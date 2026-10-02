"""Trace masking: secrets, contact details and portfolio values never leave."""

import json

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from app.services.chat.tools import calculate_position_tool, get_portfolio
from app.services.observability.masking import (
    MASKED,
    TraceMasker,
    portfolio_values,
    set_turn_sensitive_values,
)
from tests.chat_fakes import portfolio, position, turn


@pytest.fixture(autouse=True)
def clear_turn_values():
    set_turn_sensitive_values(())
    yield
    set_turn_sensitive_values(())


def test_configured_secrets_and_token_patterns_are_removed() -> None:
    masker = TraceMasker(["sk-lf-supersecret", "internal-token-123", "", "abc"])

    out = masker.mask(
        "key sk-lf-supersecret, token internal-token-123, "
        "Authorization: Bearer eyJhbGciOi.abc, url ?api_key=XYZ987&x=1"
    )

    assert "supersecret" not in out and "internal-token-123" not in out
    assert "eyJhbGciOi" not in out and "XYZ987" not in out
    assert "x=1" in out


def test_contact_details_are_masked_in_any_text() -> None:
    out = TraceMasker().mask(
        "Email me at jane.doe@example.com or call +1 (617) 555-0100 / 617-555-0100."
    )

    assert "jane.doe" not in out and "555-0100" not in out
    assert out.count(MASKED) == 3


def test_share_counts_are_masked_but_company_buybacks_are_not() -> None:
    out = TraceMasker().mask(
        "I hold 120 shares and want 1,250.5 shares more. "
        "Apple repurchased 10 million shares."
    )

    assert "120 shares" not in out and "1,250.5" not in out
    assert "10 million shares" in out


def test_portfolio_tool_output_is_masked_by_key_but_keeps_tickers_and_prices() -> None:
    snapshot = portfolio(position("NVDA", 37, 101.25, 182.4))
    output = get_portfolio(turn(snapshot))

    masked_text = TraceMasker().mask(output.text)
    masked_data = TraceMasker().mask(output.data)

    data = json.loads(masked_text)
    assert data == masked_data
    pos = data["positions"][0]
    assert pos["ticker"] == "NVDA" and pos["current_price"] == 182.4
    for key in ("total_shares", "avg_buy_price", "cost_basis", "market_value"):
        assert pos[key] == MASKED
    assert pos["weight_percent"] == MASKED
    assert data["totals"]["market_value"] == MASKED
    for raw in ("6748.8", "3746.25", "101.25"):
        assert raw not in masked_text


def test_position_math_arguments_and_results_are_masked() -> None:
    result = calculate_position_tool(
        None, action="buy", shares=15, price=180, current_shares=40, current_avg_cost=95
    )
    call = {
        "name": "calculate_position",
        "args": {
            "action": "buy",
            "shares": 15,
            "price": 180,
            "current_shares": 40,
            "current_avg_cost": 95,
        },
    }

    masked = TraceMasker().mask({"call": call, "result": result.data})

    assert masked["call"]["args"]["shares"] == MASKED
    assert masked["call"]["args"]["current_avg_cost"] == MASKED
    assert masked["call"]["args"]["action"] == "buy"
    assert masked["result"]["avg_cost_after"] == MASKED
    assert masked["result"]["shares_after"] == MASKED


def test_langchain_messages_are_masked_including_tool_artifacts() -> None:
    snapshot = portfolio(position("AAPL", 12, 150, 200))
    output = get_portfolio(turn(snapshot))
    messages = [
        HumanMessage("I'm jane@example.com, how is my portfolio?"),
        AIMessage("", tool_calls=[{"name": "get_portfolio", "args": {}, "id": "p1"}]),
        ToolMessage(
            output.text,
            tool_call_id="p1",
            artifact={"structured_content": output.data},
        ),
    ]

    masked = TraceMasker().mask({"messages": messages})

    dumped = json.dumps(masked)
    assert "jane@example.com" not in dumped
    assert '"market_value": 2400' not in dumped and "2400.0" not in dumped
    assert "AAPL" in dumped


def test_turn_portfolio_numbers_are_masked_in_free_text() -> None:
    snapshot = portfolio(position("NVDA", 75, 164.6, 182.4))  # value 13,680
    set_turn_sensitive_values(portfolio_values(snapshot))

    out = TraceMasker().mask(
        "Your NVDA position is worth $13,680.00 (about $13.7K, or $13,680), "
        "a gain of $1,335.00. NVDA trades at $182.40; revenue grew 56%."
    )

    assert "13,680" not in out and "1,335" not in out
    assert "$182.40" in out and "56%" in out  # public numbers stay


def test_without_a_registered_turn_numbers_are_left_alone() -> None:
    out = TraceMasker().mask("Revenue was $13,680 million.")
    assert out == "Revenue was $13,680 million."


def test_identity_fields_are_dropped_and_unknown_objects_are_stringified() -> None:
    class Opaque:
        def __str__(self) -> str:
            return "contact bob@example.com"

    masked = TraceMasker().mask({"user_id": "u-1", "email": "a@b.co", "x": Opaque()})

    assert masked == {"user_id": MASKED, "email": MASKED, "x": f"contact {MASKED}"}


def test_deeply_nested_data_fails_closed() -> None:
    data: dict = {}
    node = data
    for _ in range(30):
        node["child"] = {}
        node = node["child"]
    node["secret"] = "jane@example.com"

    assert "jane@example.com" not in json.dumps(TraceMasker().mask(data))


def test_masker_matches_the_langfuse_mask_signature() -> None:
    assert TraceMasker()(data={"market_value": 1}) == {"market_value": MASKED}
