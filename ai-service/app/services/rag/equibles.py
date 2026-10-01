"""Client for the Equibles REST API (earnings call transcripts).

Docs: https://equibles.com/docs/api/endpoints/earnings
The free plan allows 100 requests/day (reset 00:00 UTC); every successful page
counts. A 429 means the *daily* quota is gone, so it is never retried.
"""

import logging
from typing import Any

import httpx

from app.models.transcript import EarningsCallEvent

from .errors import EquiblesError, EquiblesNotFoundError, EquiblesQuotaError
from .retry import RetryPolicy, retry_call

logger = logging.getLogger(__name__)

# Equibles caps /speakers pages at 200 turns; most calls fit in one page.
_SPEAKERS_PAGE_SIZE = 200
# Enough recent events to find N earnings calls with transcripts.
_EVENTS_PAGE_SIZE = 12


class _TransientEquiblesError(EquiblesError):
    """5xx or transport failure; safe to retry."""


def _is_transient(exc: BaseException) -> bool:
    return isinstance(exc, _TransientEquiblesError)


class EquiblesClient:
    """Fetches earnings call metadata and transcripts for a ticker."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str,
        timeout: float,
        retry_policy: RetryPolicy,
        http_client: httpx.Client | None = None,
    ) -> None:
        self._http = http_client or httpx.Client(timeout=timeout)
        self._base_url = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {api_key}"}
        self._retry_policy = retry_policy

    def list_earnings_calls(self, ticker: str) -> list[EarningsCallEvent]:
        """Return recent earnings calls (newest first) that have transcripts."""
        payload = self._get(
            f"/stocks/{ticker}/investor-events",
            {"eventType": "EarningsCall", "limit": _EVENTS_PAGE_SIZE},
        )
        events = [EarningsCallEvent.model_validate(e) for e in payload.get("data", [])]
        return [e for e in events if e.is_ingestible]

    def get_transcript(
        self, ticker: str, fiscal_year: int, fiscal_quarter: int
    ) -> dict[str, Any]:
        """Return the raw ``/speakers`` payload with every page's turns merged."""
        path = (
            f"/stocks/{ticker}/earnings-calls/{fiscal_year}/{fiscal_quarter}/speakers"
        )
        merged: dict[str, Any] | None = None
        offset = 0
        while True:
            page = self._get(path, {"limit": _SPEAKERS_PAGE_SIZE, "offset": offset})
            turns = page.get("data", [])
            if merged is None:
                merged = page
            else:
                merged["data"].extend(turns)
            if not page.get("hasMore") or not turns:
                break
            offset += len(turns)

        merged["offset"] = 0
        merged["hasMore"] = False
        merged["turnCount"] = len(merged["data"])
        return merged

    def _get(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        return retry_call(
            lambda: self._get_once(path, params),
            is_retryable=_is_transient,
            policy=self._retry_policy,
            operation=f"equibles GET {path}",
        )

    def _get_once(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._base_url}{path}"
        try:
            response = self._http.get(url, params=params, headers=self._headers)
        except httpx.HTTPError as exc:
            raise _TransientEquiblesError(f"equibles request failed: {exc}") from exc

        remaining = response.headers.get("X-RateLimit-Remaining")
        if remaining is not None:
            logger.info(
                "equibles %s -> %d (quota remaining=%s)",
                path,
                response.status_code,
                remaining,
            )

        status = response.status_code
        if status == 429:
            raise EquiblesQuotaError("equibles daily request quota exhausted")
        if status == 404:
            raise EquiblesNotFoundError(f"equibles: not found: {path}")
        if status >= 500:
            raise _TransientEquiblesError(f"equibles server error {status}")
        if status >= 400:
            raise EquiblesError(
                f"equibles client error {status}: {response.text[:200]}"
            )

        try:
            return response.json()
        except ValueError as exc:
            raise EquiblesError("equibles returned invalid JSON") from exc
