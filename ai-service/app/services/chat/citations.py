"""Per-turn source registry and citation validation.

Every transcript passage the agent retrieves gets a turn-unique number. The
model may only cite those numbers; after the answer is complete, markers are
validated against the registry, unknown ones are dropped, and the survivors
are renumbered [1], [2], ... in order of first appearance.
"""

import re
import threading
from dataclasses import dataclass

from app.models.chat import Citation
from app.models.rag import RagSearchResult

# [3], [3, 5], [3,5] — one or two digits so years like [2025] are left alone.
_MARKER_RE = re.compile(r"\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]")
_PASSAGE_TAG_RE = re.compile(r"</?\s*passage", re.IGNORECASE)
MAX_PASSAGE_CHARS = 1800


@dataclass(frozen=True)
class Source:
    id: int
    chunk_id: str
    ticker: str
    company_name: str
    fiscal_year: int
    fiscal_quarter: int
    call_date: str | None
    speaker: str
    role: str | None
    section: str
    text: str

    def to_citation(self, new_id: int) -> Citation:
        return Citation(
            id=new_id,
            ticker=self.ticker,
            company_name=self.company_name,
            fiscal_year=self.fiscal_year,
            fiscal_quarter=self.fiscal_quarter,
            call_date=self.call_date,
            speaker=self.speaker,
            role=self.role,
            section=self.section,
            text=self.text,
        )


class CitationRegistry:
    """Numbers retrieved passages for one turn.

    Thread-safe, because sync tools run in worker threads.
    """

    def __init__(self) -> None:
        self._sources: dict[int, Source] = {}
        self._by_chunk: dict[str, int] = {}
        self._lock = threading.Lock()

    def add(self, result: RagSearchResult) -> Source:
        """Register a search result, reusing its number if already retrieved."""
        with self._lock:
            existing = self._by_chunk.get(result.id)
            if existing is not None:
                return self._sources[existing]
            source = Source(
                id=len(self._sources) + 1,
                chunk_id=result.id,
                ticker=result.ticker,
                company_name=result.company_name,
                fiscal_year=result.fiscal_year,
                fiscal_quarter=result.fiscal_quarter,
                call_date=result.call_date,
                speaker=result.speaker,
                role=result.role,
                section=result.section,
                text=result.text,
            )
            self._sources[source.id] = source
            self._by_chunk[result.id] = source.id
            return source

    def get(self, source_id: int) -> Source | None:
        with self._lock:
            return self._sources.get(source_id)

    def __len__(self) -> int:
        with self._lock:
            return len(self._sources)


def sanitize_passage(text: str) -> str:
    """Neutralize anything that could close or forge a passage delimiter."""
    clean = _PASSAGE_TAG_RE.sub(lambda m: m.group(0).replace("<", "‹"), text)
    clean = " ".join(clean.split())
    return clean[:MAX_PASSAGE_CHARS]


def format_passage(source: Source) -> str:
    """Delimited, metadata-labeled passage as shown to the model."""
    role = f", {source.role}" if source.role else ""
    date = f", call date {source.call_date}" if source.call_date else ""
    header = (
        f'<passage id="{source.id}" ticker="{source.ticker}" '
        f'period="Q{source.fiscal_quarter} FY{source.fiscal_year}">'
    )
    meta = (
        f"[{source.id}] {source.company_name} Q{source.fiscal_quarter} "
        f"FY{source.fiscal_year} earnings call{date} · {source.section} · "
        f"{source.speaker}{role}"
    )
    return f"{header}\n{meta}\n{sanitize_passage(source.text)}\n</passage>"


@dataclass(frozen=True)
class ValidatedAnswer:
    text: str
    citations: list[Citation]
    dropped: list[int]


def validate_citations(text: str, registry: CitationRegistry) -> ValidatedAnswer:
    """Keep only citations of retrieved passages and renumber them sequentially."""
    mapping: dict[int, int] = {}
    citations: list[Citation] = []
    dropped: list[int] = []

    def replace(match: re.Match[str]) -> str:
        kept: list[str] = []
        for raw in match.group(1).split(","):
            old = int(raw)
            source = registry.get(old)
            if source is None:
                if old not in dropped:
                    dropped.append(old)
                continue
            if old not in mapping:
                mapping[old] = len(mapping) + 1
                citations.append(source.to_citation(mapping[old]))
            new = f"[{mapping[old]}]"
            if new not in kept:
                kept.append(new)
        return "".join(kept)

    cleaned = _MARKER_RE.sub(replace, text)
    # Tidy spaces left before punctuation where a marker was removed.
    cleaned = re.sub(r"[ \t]+([.,;:!?])", r"\1", cleaned)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned).strip()
    return ValidatedAnswer(text=cleaned, citations=citations, dropped=dropped)
