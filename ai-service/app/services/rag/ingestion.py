"""Ingestion pipeline: fetch (with DB cache) -> chunk -> embed -> upsert.

Fetching goes through :class:`TranscriptSource`, which serves transcripts from
the Postgres cache whenever possible so re-runs spend no Equibles quota.
Missing transcripts are logged and skipped rather than failing the run.
:meth:`IngestionPipeline.add_newer_quarters` is the incremental path used by
freshness refresh: it indexes only newer calls and drops the quarters that
fall out of the window.
"""

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date

from app.models.transcript import (
    EarningsCallEvent,
    Transcript,
    company_from_event_title,
    parse_period_label,
    period_label,
)

from .chunking import Chunk, chunk_id_prefix, chunk_transcript
from .embeddings import DenseEmbedder, SparseEncoder
from .equibles import EquiblesClient
from .errors import (
    EquiblesNotFoundError,
    IngestionInterruptedError,
    NoTranscriptsError,
)
from .repository import RagRepository
from .vector_store import PineconeVectorStore

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class IngestionResult:
    ticker: str
    company_name: str
    quarters: list[str]
    chunk_count: int
    latest_call_date: date | None = None


def _latest_date(*dates: date | None) -> date | None:
    return max((d for d in dates if d is not None), default=None)


def _latest_call_date(transcripts: Sequence[Transcript]) -> date | None:
    return _latest_date(*(t.call_date for t in transcripts))


class TranscriptSource:
    """The latest N transcripts for a ticker, cache first, Equibles second."""

    def __init__(
        self, equibles: EquiblesClient, repo: RagRepository, *, quarters: int
    ) -> None:
        self._equibles = equibles
        self._repo = repo
        self._quarters = quarters

    @property
    def quarters(self) -> int:
        """How many of the latest quarters a ticker keeps indexed."""
        return self._quarters

    def load(
        self, ticker: str, *, refresh: bool = False, cache_only: bool = False
    ) -> list[Transcript]:
        cached = self._cached(ticker)
        if cache_only or (not refresh and len(cached) >= self._quarters):
            latest = list(cached.values())[: self._quarters]
            logger.info("serving %d %s transcripts from cache", len(latest), ticker)
            return [Transcript.from_equibles(p) for p in latest]

        try:
            events = self._equibles.list_earnings_calls(ticker)[: self._quarters]
        except EquiblesNotFoundError as exc:
            raise NoTranscriptsError(f"equibles does not know {ticker}") from exc
        return self._load_events(ticker, events, cached, refresh=refresh)

    def load_events(
        self, ticker: str, events: Sequence[EarningsCallEvent]
    ) -> list[Transcript]:
        """Transcripts for specific calls (cache first), e.g. a newer quarter."""
        return self._load_events(ticker, events, self._cached(ticker), refresh=False)

    def _cached(self, ticker: str) -> dict[tuple[int, int], dict]:
        return {
            (c.fiscal_year, c.fiscal_quarter): c.payload
            for c in self._repo.get_cached_transcripts(ticker)
        }

    def _load_events(
        self,
        ticker: str,
        events: Sequence[EarningsCallEvent],
        cached: dict[tuple[int, int], dict],
        *,
        refresh: bool,
    ) -> list[Transcript]:
        transcripts: list[Transcript] = []
        for event in events:
            fy, fq = event.fiscal_year, event.fiscal_quarter
            assert fy is not None and fq is not None  # guaranteed by is_ingestible
            payload = None if refresh else cached.get((fy, fq))
            if payload is None:
                payload = self._fetch(ticker, fy, fq)
                if payload is None:
                    continue
                self._repo.save_transcript(
                    ticker,
                    fy,
                    fq,
                    payload,
                    event_title=payload.get("eventTitle") or event.title,
                    call_date=event.call_date,
                )
            transcripts.append(Transcript.from_equibles(payload))
        return transcripts

    def _fetch(self, ticker: str, fy: int, fq: int) -> dict | None:
        try:
            payload = self._equibles.get_transcript(ticker, fy, fq)
        except EquiblesNotFoundError:
            logger.warning(
                "transcript missing for %s FY%dQ%d; skipping", ticker, fy, fq
            )
            return None
        if not payload.get("data"):
            logger.warning("transcript empty for %s FY%dQ%d; skipping", ticker, fy, fq)
            return None
        return payload


def _with_consistent_company(
    ticker: str, transcripts: list[Transcript]
) -> list[Transcript]:
    """Use one company name for every quarter of a ticker.

    Event titles vary (e.g. "2026 Q2 Earnings Call" has no company), so take the
    first title that yields a name and apply it to all transcripts.
    """
    company = next(
        (
            name
            for t in transcripts
            if (name := company_from_event_title(t.event_title)) is not None
        ),
        ticker,
    )
    return [t.model_copy(update={"company_name": company}) for t in transcripts]


class IngestionPipeline:
    def __init__(
        self,
        source: TranscriptSource,
        embedder: DenseEmbedder,
        sparse_encoder: SparseEncoder,
        store: PineconeVectorStore,
        *,
        namespace: str,
        plain_namespace: str,
        chunk_tokens: int,
        overlap_tokens: int,
    ) -> None:
        self._source = source
        self._embedder = embedder
        self._sparse = sparse_encoder
        self._store = store
        self._namespace = namespace
        self._plain_namespace = plain_namespace
        self._chunk_tokens = chunk_tokens
        self._overlap_tokens = overlap_tokens

    def ingest(
        self,
        ticker: str,
        *,
        refresh: bool = False,
        cache_only: bool = False,
        include_plain: bool = False,
        plain_only: bool = False,
        should_stop: Callable[[], bool] = lambda: False,
    ) -> IngestionResult:
        """Index the latest transcripts for ``ticker``. Safe to re-run.

        ``include_plain`` also indexes header-less copies into the evaluation
        namespace; ``plain_only`` indexes only those. ``should_stop`` is checked
        between stages; when it returns True the run raises
        :class:`IngestionInterruptedError` (shutdown), leaving the job to be
        reclaimed.
        """

        def checkpoint() -> None:
            if should_stop():
                raise IngestionInterruptedError(f"ingestion of {ticker} interrupted")

        transcripts = self._source.load(ticker, refresh=refresh, cache_only=cache_only)
        checkpoint()
        if not transcripts:
            raise NoTranscriptsError(f"no transcripts available for {ticker}")
        transcripts = _with_consistent_company(ticker, transcripts)

        chunks = [
            chunk
            for transcript in transcripts
            for chunk in chunk_transcript(
                transcript,
                target_tokens=self._chunk_tokens,
                overlap_tokens=self._overlap_tokens,
            )
        ]
        # On-demand ingestion may run before anyone has seeded the index.
        self._store.ensure_index()
        targets = [] if plain_only else [(self._namespace, True)]
        if include_plain or plain_only:
            targets.append((self._plain_namespace, False))
        for namespace, with_header in targets:
            checkpoint()
            self._index(
                chunks,
                namespace=namespace,
                with_header=with_header,
                checkpoint=checkpoint,
            )

        result = IngestionResult(
            ticker=ticker,
            company_name=transcripts[0].company_name,
            quarters=[t.period_label for t in transcripts],
            chunk_count=len(chunks),
            latest_call_date=_latest_call_date(transcripts),
        )
        logger.info(
            "indexed %s: %d chunks across %s",
            ticker,
            result.chunk_count,
            ",".join(result.quarters),
        )
        return result

    def add_newer_quarters(
        self,
        ticker: str,
        events: Sequence[EarningsCallEvent],
        *,
        indexed_quarters: Sequence[str],
        company_name: str | None,
        chunk_count: int,
        latest_call_date: date | None,
        should_stop: Callable[[], bool] = lambda: False,
    ) -> IngestionResult:
        """Index calls newer than the indexed ones, keeping the latest N quarters.

        Only the new quarters are fetched and embedded; the quarters that fall
        out of the window lose their vectors (by ID prefix) after the new ones
        are upserted, so searches never see a gap. ``events`` is Equibles'
        list of calls, newest first.
        """

        def checkpoint() -> None:
            if should_stop():
                raise IngestionInterruptedError(f"refresh of {ticker} interrupted")

        indexed = {p for label in indexed_quarters if (p := parse_period_label(label))}
        newest = max(indexed, default=(0, 0))
        window = self._source.quarters
        newer = [
            e
            for e in events
            if e.fiscal_year is not None
            and e.fiscal_quarter is not None
            and (e.fiscal_year, e.fiscal_quarter) > newest
        ][:window]
        transcripts = self._source.load_events(ticker, newer)
        checkpoint()
        if not transcripts:
            raise NoTranscriptsError(f"no newer transcripts available for {ticker}")
        if company_name:
            transcripts = [
                t.model_copy(update={"company_name": company_name}) for t in transcripts
            ]
        else:
            transcripts = _with_consistent_company(ticker, transcripts)
        company = transcripts[0].company_name
        chunks = [
            chunk
            for transcript in transcripts
            for chunk in chunk_transcript(
                transcript,
                target_tokens=self._chunk_tokens,
                overlap_tokens=self._overlap_tokens,
            )
        ]
        self._store.ensure_index()
        self._index(
            chunks,
            namespace=self._namespace,
            with_header=True,
            checkpoint=checkpoint,
            prune=False,
        )

        added = {(t.fiscal_year, t.fiscal_quarter) for t in transcripts}
        kept = sorted(indexed | added, reverse=True)[:window]
        removed = sorted(indexed - set(kept), reverse=True)
        deleted = 0
        for year, quarter in removed:
            checkpoint()
            deleted += self._store.delete_prefix(
                chunk_id_prefix(ticker, year, quarter), namespace=self._namespace
            )

        result = IngestionResult(
            ticker=ticker,
            company_name=company,
            quarters=[period_label(y, q) for y, q in kept],
            chunk_count=max(chunk_count - deleted, 0) + len(chunks),
            latest_call_date=_latest_date(
                latest_call_date, _latest_call_date(transcripts)
            ),
        )
        logger.info(
            "refreshed %s: added %s (%d chunks), removed %s (%d vectors)",
            ticker,
            ",".join(t.period_label for t in transcripts),
            len(chunks),
            ",".join(period_label(y, q) for y, q in removed) or "none",
            deleted,
        )
        return result

    def _index(
        self,
        chunks: Sequence[Chunk],
        *,
        namespace: str,
        with_header: bool,
        checkpoint: Callable[[], None] = lambda: None,
        prune: bool = True,
    ) -> None:
        texts = [c.embedding_text(with_header=with_header) for c in chunks]
        dense = self._embedder.embed_documents(texts)
        checkpoint()
        sparse = self._sparse.encode_documents(texts)
        checkpoint()
        self._store.upsert_chunks(chunks, dense, sparse, namespace=namespace)
        # Drop vectors from quarters that rolled out of the window or from a
        # previous chunking run that produced more chunks.
        if chunks and prune:
            self._store.delete_stale(
                chunk_id_prefix(chunks[0].ticker),
                {c.id for c in chunks},
                namespace=namespace,
            )
