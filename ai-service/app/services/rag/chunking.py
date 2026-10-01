"""Speaker-turn aware chunking with deterministic context headers.

Chunks never cross a speaker boundary, so every chunk has exact speaker/role
metadata. Turns longer than the target size are split on sentence boundaries
into ~``target_tokens`` windows that overlap by ~``overlap_tokens``.

Equibles does not label sections, so Q&A is inferred: once management (anyone
other than the operator or an analyst) has spoken, Q&A starts at the first
analyst turn, the first operator turn that mentions questions, or the turn after
a management hand-off such as "we will now open the call for questions".
Requiring management first guards against Equibles misattributing early turns.
"""

import re
from dataclasses import dataclass
from enum import StrEnum

from app.models.transcript import SpeakerTurn, Transcript

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
_QA_OPERATOR_RE = re.compile(r"\bquestions?\b", re.IGNORECASE)
_QA_HANDOFF_RE = re.compile(
    r"open (?:the|up the) (?:call|line|lines|floor) (?:for|to) questions"
    r"|question[- ]and[- ]answer|first question",
    re.IGNORECASE,
)
# Operator turns this short are logistics ("Next question, please.").
_MIN_OPERATOR_TOKENS = 40
# Any turn this short ("Thank you.") carries no retrievable content.
_MIN_TURN_TOKENS = 8
_CHARS_PER_TOKEN = 4


class Section(StrEnum):
    PREPARED_REMARKS = "prepared_remarks"
    QA = "qa"

    @property
    def label(self) -> str:
        return "Prepared remarks" if self is Section.PREPARED_REMARKS else "Q&A"


def estimate_tokens(text: str) -> int:
    """Cheap, deterministic token estimate (~4 characters per token)."""
    return max(1, len(text) // _CHARS_PER_TOKEN)


@dataclass(frozen=True)
class Chunk:
    """A searchable slice of one speaker turn plus its citation metadata."""

    ticker: str
    company_name: str
    fiscal_year: int
    fiscal_quarter: int
    call_date: str  # YYYY-MM-DD, or "" when unknown
    speaker: str
    role: str
    section: Section
    chunk_index: int
    text: str
    context_header: str

    @property
    def id(self) -> str:
        """Stable vector ID, so re-indexing overwrites instead of duplicating."""
        return chunk_id_prefix(self.ticker, self.fiscal_year, self.fiscal_quarter) + (
            f"{self.chunk_index:04d}"
        )

    def embedding_text(self, *, with_header: bool) -> str:
        """Text to embed / sparse-encode / rerank."""
        return f"{self.context_header}\n\n{self.text}" if with_header else self.text

    def metadata(self) -> dict[str, str | int]:
        """Pinecone metadata (no nulls allowed), including the display text."""
        return {
            "ticker": self.ticker,
            "company_name": self.company_name,
            "fiscal_year": self.fiscal_year,
            "fiscal_quarter": self.fiscal_quarter,
            "call_date": self.call_date,
            "speaker": self.speaker,
            "role": self.role,
            "section": self.section.value,
            "chunk_index": self.chunk_index,
            "context_header": self.context_header,
            "text": self.text,
        }


def chunk_id_prefix(
    ticker: str, fiscal_year: int | None = None, fiscal_quarter: int | None = None
) -> str:
    """ID prefix for a ticker (or one of its quarters), e.g. ``AAPL#FY2025Q3#``."""
    if fiscal_year is None or fiscal_quarter is None:
        return f"{ticker}#"
    return f"{ticker}#FY{fiscal_year}Q{fiscal_quarter}#"


def build_context_header(transcript: Transcript, section: Section, speaker: str) -> str:
    """E.g. ``AAPL (Apple Inc) · Q3 FY2025 earnings call · 2025-07-31 · Q&A · ...``."""
    parts = [
        f"{transcript.ticker} ({transcript.company_name})",
        f"Q{transcript.fiscal_quarter} FY{transcript.fiscal_year} earnings call",
    ]
    if transcript.call_date:
        parts.append(transcript.call_date.isoformat())
    parts.extend([section.label, speaker])
    return " · ".join(parts)


def speaker_label(turn: SpeakerTurn) -> str:
    """``Name, Role`` when known, falling back to the role or speaker index."""
    if turn.speaker_name and turn.speaker_role:
        return f"{turn.speaker_name}, {turn.speaker_role}"
    return turn.speaker_name or turn.speaker_role or f"Speaker {turn.speaker_index}"


def _is_role(turn: SpeakerTurn, role: str) -> bool:
    """Match a role label; Equibles qualifies some, e.g. "Analyst - UBS"."""
    return (turn.speaker_role or "").strip().lower().startswith(role)


def assign_sections(turns: list[SpeakerTurn]) -> list[Section]:
    """Label each turn as prepared remarks or Q&A."""
    sections: list[Section] = []
    in_qa = False
    qa_starts_next = False
    management_has_spoken = False
    for turn in turns:
        if not in_qa:
            is_operator = _is_role(turn, "operator")
            is_analyst = _is_role(turn, "analyst")
            if qa_starts_next or (
                management_has_spoken
                and (
                    is_analyst
                    or (is_operator and _QA_OPERATOR_RE.search(turn.text))
                    or (is_operator and _QA_HANDOFF_RE.search(turn.text))
                )
            ):
                in_qa = True
            elif not (is_operator or is_analyst):
                # Management often closes its remarks with the hand-off ("we'll
                # now open the call for questions"); that turn is still prepared
                # remarks, and Q&A begins with the next turn.
                if management_has_spoken and _QA_HANDOFF_RE.search(turn.text):
                    qa_starts_next = True
                management_has_spoken = True
        sections.append(Section.QA if in_qa else Section.PREPARED_REMARKS)
    return sections


def _is_filler(turn: SpeakerTurn) -> bool:
    """True for turns too short to be worth indexing."""
    tokens = estimate_tokens(turn.text)
    if _is_role(turn, "operator"):
        return tokens < _MIN_OPERATOR_TOKENS
    return tokens < _MIN_TURN_TOKENS


def _split_long_sentence(sentence: str, max_chars: int) -> list[str]:
    """Hard-wrap a single sentence that exceeds the window on word boundaries."""
    pieces: list[str] = []
    current: list[str] = []
    length = 0
    for word in sentence.split():
        if current and length + len(word) + 1 > max_chars:
            pieces.append(" ".join(current))
            current, length = [], 0
        current.append(word)
        length += len(word) + 1
    if current:
        pieces.append(" ".join(current))
    return pieces


def split_text(text: str, target_tokens: int, overlap_tokens: int) -> list[str]:
    """Split text into ~target-sized windows on sentence boundaries, with overlap."""
    text = " ".join(text.split())
    if estimate_tokens(text) <= target_tokens:
        return [text] if text else []

    max_chars = target_tokens * _CHARS_PER_TOKEN
    sentences: list[str] = []
    for sentence in _SENTENCE_SPLIT_RE.split(text):
        if len(sentence) > max_chars:
            sentences.extend(_split_long_sentence(sentence, max_chars))
        elif sentence:
            sentences.append(sentence)

    windows: list[str] = []
    start = 0
    while start < len(sentences):
        end, size = start, 0
        while end < len(sentences) and (
            end == start or size + estimate_tokens(sentences[end]) <= target_tokens
        ):
            size += estimate_tokens(sentences[end])
            end += 1
        windows.append(" ".join(sentences[start:end]))
        if end >= len(sentences):
            break
        # Step back over trailing sentences to create the overlap, but always
        # advance at least one sentence so the loop terminates.
        next_start, overlap = end, 0
        while next_start - 1 > start and overlap < overlap_tokens:
            next_start -= 1
            overlap += estimate_tokens(sentences[next_start])
        start = next_start
    return windows


def chunk_transcript(
    transcript: Transcript, *, target_tokens: int = 400, overlap_tokens: int = 60
) -> list[Chunk]:
    """Turn a transcript into ordered, speaker-aware chunks."""
    chunks: list[Chunk] = []
    call_date = transcript.call_date.isoformat() if transcript.call_date else ""
    sections = assign_sections(transcript.turns)
    for turn, section in zip(transcript.turns, sections, strict=True):
        if _is_filler(turn):
            continue
        speaker = speaker_label(turn)
        header = build_context_header(transcript, section, speaker)
        for piece in split_text(turn.text, target_tokens, overlap_tokens):
            chunks.append(
                Chunk(
                    ticker=transcript.ticker,
                    company_name=transcript.company_name,
                    fiscal_year=transcript.fiscal_year,
                    fiscal_quarter=transcript.fiscal_quarter,
                    call_date=call_date,
                    speaker=turn.speaker_name or speaker,
                    role=turn.speaker_role or "",
                    section=section,
                    chunk_index=len(chunks),
                    text=piece,
                    context_header=header,
                )
            )
    return chunks
