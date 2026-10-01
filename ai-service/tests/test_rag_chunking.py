"""Tests for speaker-turn aware chunking and context headers."""

from datetime import date

from app.models.transcript import SpeakerTurn, Transcript
from app.services.rag.chunking import (
    Section,
    assign_sections,
    chunk_transcript,
    estimate_tokens,
    split_text,
)


def turn(idx: int, role: str | None, text: str, name: str | None = None) -> SpeakerTurn:
    return SpeakerTurn(
        speaker_index=idx, speaker_name=name, speaker_role=role, text=text
    )


def make_transcript(turns: list[SpeakerTurn]) -> Transcript:
    return Transcript(
        ticker="AAPL",
        company_name="Apple Inc",
        call_date=date(2025, 7, 31),
        fiscal_year=2025,
        fiscal_quarter=3,
        turns=turns,
    )


LONG_OPERATOR_INTRO = (
    "Good afternoon and welcome to the call. After the prepared remarks there "
    "will be a question-and-answer session. This call is being recorded today."
)
QA_HANDOFF = (
    "Thank you. We will now begin the question and answer session. Our first "
    "question comes from the line of an analyst at a large bank. Please go ahead."
)


def test_sections_switch_to_qa_after_management_and_operator_handoff() -> None:
    turns = [
        turn(1, "Operator", LONG_OPERATOR_INTRO),  # mentions questions, too early
        turn(2, "CEO", "Revenue grew strongly this quarter across all segments."),
        turn(3, "Operator", QA_HANDOFF),
        turn(4, "CFO", "Margins expanded thanks to services mix and cost control."),
    ]

    assert assign_sections(turns) == [
        Section.PREPARED_REMARKS,
        Section.PREPARED_REMARKS,
        Section.QA,
        Section.QA,
    ]


def test_sections_switch_to_qa_at_first_analyst() -> None:
    turns = [
        turn(1, "CEO", "Opening remarks about the quarter and the outlook."),
        turn(2, "Analyst", "Can you talk about gross margin drivers next quarter?"),
        turn(3, None, "Sure, the main driver is the services mix this year."),
    ]

    assert assign_sections(turns)[1:] == [Section.QA, Section.QA]


def test_chunks_carry_metadata_header_and_stable_ids() -> None:
    transcript = make_transcript(
        [
            turn(1, "Operator", "Next question, please."),  # filler, skipped
            turn(2, "CEO", "We set a new record for services revenue.", "Tim Cook"),
            turn(3, "Analyst", "Could you talk about EBITDA trends going forward?"),
            turn(4, None, "Thanks."),  # filler, skipped
        ]
    )

    chunks = chunk_transcript(transcript)

    assert [c.chunk_index for c in chunks] == [0, 1]
    first, second = chunks
    assert first.id == "AAPL#FY2025Q3#0000"
    assert first.speaker == "Tim Cook" and first.role == "CEO"
    assert first.section is Section.PREPARED_REMARKS
    assert first.context_header == (
        "AAPL (Apple Inc) · Q3 FY2025 earnings call · 2025-07-31 · "
        "Prepared remarks · Tim Cook, CEO"
    )
    assert first.embedding_text(with_header=True).startswith(first.context_header)
    assert first.embedding_text(with_header=False) == first.text
    assert second.speaker == "Analyst" and second.section is Section.QA
    assert first.metadata()["text"] == "We set a new record for services revenue."
    assert None not in first.metadata().values()


def test_chunking_is_deterministic() -> None:
    transcript = make_transcript(
        [turn(1, "CEO", "Sentence number one is here. " * 200, "Jane Doe")]
    )

    assert chunk_transcript(transcript) == chunk_transcript(transcript)


def test_split_text_respects_target_and_overlaps() -> None:
    sentences = [f"This is sentence number {i} of the remarks." for i in range(120)]
    windows = split_text(" ".join(sentences), target_tokens=100, overlap_tokens=20)

    assert len(windows) > 1
    assert all(estimate_tokens(w) <= 110 for w in windows)
    for previous, current in zip(windows, windows[1:], strict=False):
        last_sentence = previous.rsplit(". ", 1)[-1]
        assert last_sentence in current  # consecutive windows overlap


def test_split_text_hard_wraps_a_single_huge_sentence() -> None:
    windows = split_text("word " * 2000, target_tokens=100, overlap_tokens=10)

    assert len(windows) > 1
    assert all(estimate_tokens(w) <= 100 for w in windows)


def test_short_text_is_a_single_window() -> None:
    assert split_text("  Short   answer. ", 400, 60) == ["Short answer."]


def test_qualified_analyst_roles_start_qa() -> None:
    turns = [
        turn(1, "CEO", "Opening remarks about the quarter and the outlook ahead."),
        turn(2, "Analyst — Morgan Stanley", "How should we think about capex?"),
    ]

    assert assign_sections(turns) == [Section.PREPARED_REMARKS, Section.QA]


def test_misattributed_analyst_before_management_does_not_start_qa() -> None:
    turns = [
        turn(1, "Analyst - Morgan Stanley", "Good afternoon."),
        turn(2, "CFO", "We delivered another outstanding quarter of revenue growth."),
        turn(
            3, "Head of Investor Relations", "We will now open the call for questions."
        ),
        turn(4, None, "Thanks. Could you size the networking opportunity?"),
    ]

    assert assign_sections(turns) == [
        Section.PREPARED_REMARKS,
        Section.PREPARED_REMARKS,
        Section.PREPARED_REMARKS,  # the hand-off itself is still remarks
        Section.QA,
    ]


def test_management_handoff_at_end_of_remarks_keeps_the_remarks() -> None:
    turns = [
        turn(1, "CFO", "Welcome to the call. Our COO will speak first."),
        turn(2, "COO", "Thanks. A few highlights from the year before results."),
        turn(
            3, "CFO", "Membership fee income rose 14%. We'll then open for questions."
        ),
        turn(4, "Operator", "To ask a question, press star one on your keypad now."),
    ]

    assert assign_sections(turns) == [
        Section.PREPARED_REMARKS,
        Section.PREPARED_REMARKS,
        Section.PREPARED_REMARKS,
        Section.QA,
    ]
