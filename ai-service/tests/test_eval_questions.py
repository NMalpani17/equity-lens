"""Sanity checks for the labeled retrieval evaluation set."""

from collections import Counter

from scripts.eval_rag import DEFAULT_QUESTIONS, load_questions


def test_question_set_is_well_formed_and_balanced() -> None:
    questions = load_questions(DEFAULT_QUESTIONS)

    assert len(questions) == 20
    assert len({q.id for q in questions}) == len(questions)
    kinds = Counter(q.kind for q in questions)
    assert kinds["exact"] >= 8 and kinds["conceptual"] >= 8
    tickers = {q.expected.ticker for q in questions}
    assert tickers == {
        "AAPL",
        "MSFT",
        "NVDA",
        "AMZN",
        "GOOGL",
        "META",
        "TSLA",
        "JPM",
        "NFLX",
        "AMD",
    }
