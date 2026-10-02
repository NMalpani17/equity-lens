"""Number and table clean-up applied to the agent's final answer."""

import pytest

from app.services.chat.formatting import tidy_answer, whole_shares


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Your NVDA position is down -$13,457.", "Your NVDA position is down $13,457."),
        ("The stock fell -2.4% today.", "The stock fell 2.4% today."),
        ("Shares declined by -$3.10.", "Shares declined by $3.10."),
        ("a loss of -$120 on the sale", "a loss of $120 on the sale"),
        ("down −$5", "down $5"),  # unicode minus
        ("Down - $40", "Down $40"),
    ],
)
def test_double_negatives_are_removed(raw: str, expected: str) -> None:
    assert tidy_answer(raw) == expected


@pytest.mark.parametrize(
    "text",
    [
        "Unrealized P/L: -$13,457 (-12.3%).",  # a signed figure is fine
        "Revenue was down sharply - see below.",
        "The low was -5 C",  # no decline word
        "The day change was -$5.",  # only decline words are touched
    ],
)
def test_signed_numbers_without_a_decline_word_are_untouched(text: str) -> None:
    assert tidy_answer(text) == text


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("You hold 42.0 shares of AAPL.", "You hold 42 shares of AAPL."),
        (
            "Selling 1,200.00 shares leaves 0 shares.",
            "Selling 1,200 shares leaves 0 shares.",
        ),
        ("1.0 share", "1 share"),
        ("42.0 Shares", "42 Shares"),
    ],
)
def test_whole_share_counts_drop_decimals(raw: str, expected: str) -> None:
    assert tidy_answer(raw) == expected


@pytest.mark.parametrize(
    "text",
    ["You hold 0.5 shares.", "12.25 shares", "10.05 shares", "price 42.0 per share"],
)
def test_fractional_shares_and_other_decimals_are_kept(text: str) -> None:
    assert tidy_answer(text) == text


def test_whole_shares_normalizes_tool_values() -> None:
    assert whole_shares(42.0) == 42 and isinstance(whole_shares(42.0), int)
    assert whole_shares(0.5) == 0.5
    assert whole_shares(None) is None


def test_bullets_inside_table_cells_are_flattened() -> None:
    raw = (
        "| Quarter | Highlights |\n"
        "| --- | --- |\n"
        "| Q4 FY2026 | • Azure +39%<br>• Capex up<br/>• Margins stable |\n"
        "| Q3 FY2026 | 1. Copilot seats<br>2. Cloud margin |\n"
        "| Q2 FY2026 | - Strong demand |\n"
    )

    out = tidy_answer(raw).split("\n")

    assert out[0] == "| Quarter | Highlights |"
    assert out[1] == "| --- | --- |"
    assert out[2] == "| Q4 FY2026 | Azure +39%; Capex up; Margins stable |"
    assert out[3] == "| Q3 FY2026 | Copilot seats; Cloud margin |"
    assert out[4] == "| Q2 FY2026 | Strong demand |"


def test_tables_without_lists_and_code_blocks_are_untouched() -> None:
    text = (
        "| Ticker | P/L |\n|:---|---:|\n| NVDA | -$1,200 |\n\n"
        "```\nfell -5 shares 42.0 shares\n```"
    )

    assert tidy_answer(text) == text
