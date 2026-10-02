"""Human-readable progress labels and result summaries for tool calls."""

from typing import Any

_SAFE_ARG_KEYS = {
    "query",
    "ticker",
    "fiscal_year",
    "fiscal_quarter",
    "period",
    "action",
    "shares",
    "price",
}


def safe_args(args: dict[str, Any]) -> dict[str, Any]:
    """The subset of tool arguments worth showing in the UI (strings truncated)."""
    out: dict[str, Any] = {}
    for key, value in args.items():
        if key not in _SAFE_ARG_KEYS or value is None:
            continue
        out[key] = value[:120] if isinstance(value, str) else value
    return out


def tool_label(name: str, args: dict[str, Any]) -> str:
    ticker = str(args.get("ticker") or "").upper()
    match name:
        case "search_transcripts":
            return (
                f"Searching {ticker} transcripts…"
                if ticker
                else "Searching earnings call transcripts…"
            )
        case "get_quote":
            return f"Getting {ticker or 'the'} quote…"
        case "get_price_history":
            return f"Loading {ticker} price history ({args.get('period', '6mo')})…"
        case "get_portfolio":
            return "Reading your portfolio…"
        case "resolve_company":
            return f"Looking up “{str(args.get('query', ''))[:60]}”…"
        case "calculate_position":
            return "Calculating position math…"
    return f"Running {name}…"


def tool_summary(name: str, data: dict[str, Any] | None, *, failed: bool) -> str:
    if failed or data is None:
        return "Tool failed"
    status = data.get("status")
    if status not in (None, "ok", "resolved"):
        message = str(data.get("message") or status)
        return message.split(". ")[0][:140]
    match name:
        case "search_transcripts":
            count = len(data.get("passages", []))
            return f"Found {count} passage{'s' if count != 1 else ''}"
        case "get_quote":
            currency = data.get("currency", "")
            return f"{data.get('ticker')} {data.get('price')} {currency}".strip()
        case "get_price_history":
            change = data.get("change_percent")
            return f"{data.get('ticker')} {change}% over {data.get('period')}"
        case "get_portfolio":
            return f"{data.get('position_count', 0)} positions"
        case "resolve_company":
            return f"{data.get('ticker')} ({data.get('company_name')})"
        case "calculate_position":
            return f"New average cost {data.get('avg_cost_after')}"
    return "Done"
