"""Ingestion pipeline: fetch (with DB cache) -> chunk -> embed -> upsert.

Fetching goes through :class:`TranscriptSource`, which serves transcripts from
the Postgres cache whenever possible so re-runs spend no Equibles quota.
Missing transcripts are logged and skipped rather than failing the run.
"""

import logging
from collections.abc import Sequence
from dataclasses import dataclass

from app.models.transcript import Transcript, company_from_event_title

from .chunking import Chunk, chunk_id_prefix, chunk_transcript
from .embeddings import DenseEmbedder, SparseEncoder
from .equibles import EquiblesClient
from .errors import EquiblesNotFoundError, NoTranscriptsError
from .repository import RagRepository
from .vector_store import PineconeVectorStore

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class IngestionResult:
    ticker: str
    company_name: str
    quarters: list[str]
    chunk_count: int


class TranscriptSource:
    """The latest N transcripts for a ticker, cache first, Equibles second."""

    def __init__(
        self, equibles: EquiblesClient, repo: RagRepository, *, quarters: int
    ) -> None:
        self._equibles = equibles
        self._repo = repo
        self._quarters = quarters

    def load(
        self, ticker: str, *, refresh: bool = False, cache_only: bool = False
    ) -> list[Transcript]:
        cached = {
            (c.fiscal_year, c.fiscal_quarter): c.payload
            for c in self._repo.get_cached_transcripts(ticker)
        }
        if cache_only or (not refresh and len(cached) >= self._quarters):
            latest = list(cached.values())[: self._quarters]
            logger.info("serving %d %s transcripts from cache", len(latest), ticker)
            return [Transcript.from_equibles(p) for p in latest]

        try:
            events = self._equibles.list_earnings_calls(ticker)[: self._quarters]
        except EquiblesNotFoundError as exc:
            raise NoTranscriptsError(f"equibles does not know {ticker}") from exc

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
    ) -> IngestionResult:
        """Index the latest transcripts for ``ticker``. Safe to re-run.

        ``include_plain`` also indexes header-less copies into the evaluation
        namespace; ``plain_only`` indexes only those.
        """
        transcripts = self._source.load(ticker, refresh=refresh, cache_only=cache_only)
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
            self._index(chunks, namespace=namespace, with_header=with_header)

        result = IngestionResult(
            ticker=ticker,
            company_name=transcripts[0].company_name,
            quarters=[t.period_label for t in transcripts],
            chunk_count=len(chunks),
        )
        logger.info(
            "indexed %s: %d chunks across %s",
            ticker,
            result.chunk_count,
            ",".join(result.quarters),
        )
        return result

    def _index(
        self, chunks: Sequence[Chunk], *, namespace: str, with_header: bool
    ) -> None:
        texts = [c.embedding_text(with_header=with_header) for c in chunks]
        dense = self._embedder.embed_documents(texts)
        sparse = self._sparse.encode_documents(texts)
        self._store.upsert_chunks(chunks, dense, sparse, namespace=namespace)
        # Drop vectors from quarters that rolled out of the window or from a
        # previous chunking run that produced more chunks.
        if chunks:
            self._store.delete_stale(
                chunk_id_prefix(chunks[0].ticker),
                {c.id for c in chunks},
                namespace=namespace,
            )
