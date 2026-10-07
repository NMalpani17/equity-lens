"""Market-data tool results as citable sources: [D1], [D2], ...

Transcript passages are cited as [n] and validated by the chat citation
module. Market data (quotes and price history) has no passage, so each
successful tool result is registered as a data source with its own id, the
writer cites it as [Dn], and unknown ids are dropped the same way.
"""

import re
from dataclasses import dataclass, field
from typing import Any

from app.models.report import DataSource

DATA_REF_RE = re.compile(r"\[D(\d{1,2})\]")


@dataclass
class DataSourceRegistry:
    """Numbers one run's market-data results; a repeated call reuses its id."""

    sources: list[DataSource] = field(default_factory=list)
    _by_key: dict[tuple[str, str], DataSource] = field(default_factory=dict)

    def add(self, tool: str, data: dict[str, Any]) -> DataSource | None:
        """Register a successful tool result; None if it isn't citable data."""
        if data.get("status") != "ok":
            return None
        ticker = str(data.get("ticker") or "")
        if tool == "get_quote":
            key, kind = ("quote", ""), "quote"
            label = f"{ticker} quote"
            as_of = data.get("as_of")
        elif tool == "get_price_history":
            period = str(data.get("period") or "")
            key, kind = ("price_history", period), "price_history"
            label = (
                f"{ticker} price history, {period} "
                f"({data.get('start_date')} to {data.get('end_date')})"
            )
            as_of = data.get("end_date")
        else:
            return None
        existing = self._by_key.get(key)
        source = DataSource(
            id=existing.id if existing else f"D{len(self.sources) + 1}",
            kind=kind,
            ticker=ticker,
            label=label,
            as_of=str(as_of) if as_of else None,
            data=_compact(kind, data),
        )
        if existing:
            self.sources[self.sources.index(existing)] = source
        else:
            self.sources.append(source)
        self._by_key[key] = source
        return source


def _compact(kind: str, data: dict[str, Any]) -> dict[str, Any]:
    """The fields a reader (and the writer) needs; the chart has the points."""
    if kind == "quote":
        keys = ("price", "previous_close", "change", "change_percent", "currency")
    else:
        keys = (
            "period",
            "start_date",
            "end_date",
            "first_close",
            "last_close",
            "change",
            "change_percent",
            "high",
            "high_date",
            "low",
            "low_date",
            "currency",
        )
    return {k: data[k] for k in keys if k in data}


@dataclass(frozen=True)
class ValidatedRefs:
    text: str
    cited: list[str]
    dropped: list[str]


def validate_data_refs(text: str, known: set[str]) -> ValidatedRefs:
    """Keep [Dn] markers for known sources; drop the rest."""
    cited: list[str] = []
    dropped: list[str] = []

    def replace(match: re.Match[str]) -> str:
        ref = f"D{int(match.group(1))}"
        if ref not in known:
            if ref not in dropped:
                dropped.append(ref)
            return ""
        if ref not in cited:
            cited.append(ref)
        return f"[{ref}]"

    cleaned = DATA_REF_RE.sub(replace, text)
    cleaned = re.sub(r"[ \t]+([.,;:!?])", r"\1", cleaned)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned).strip()
    return ValidatedRefs(cleaned, cited, dropped)
