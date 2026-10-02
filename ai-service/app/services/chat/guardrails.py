"""Deterministic pre-checks run before the model sees a message.

Conservative by design: only clear-cut cases are handled here (with no model
or tool calls); everything else reaches the agent, whose system prompt enforces
the same scope rules for subtler cases.
"""

import re
from dataclasses import dataclass
from enum import StrEnum

OFF_TOPIC_REPLY = (
    "I'm Equity Lens's research assistant, so I stick to stocks, earnings calls, "
    "markets, your portfolio, and general investing concepts. Try asking something "
    'like "What did NVIDIA say about data center demand last quarter?"'
)
INJECTION_REPLY = (
    "I can't change how I work or share my internal instructions. I'm happy to "
    "help with stocks, earnings calls, markets, or your portfolio, though."
)
ADVICE_NOTE = "_This is general information, not financial advice._"

_INJECTION_RE = re.compile(
    r"\b(ignore|disregard|forget|override|bypass)\b[^.?!\n]{0,40}"
    r"\b(instructions?|prompts?|rules|guidelines|guardrails|restrictions)\b"
    r"|\b(reveal|show|print|repeat|output|tell me|what(?:'s| is| are))\b[^.?!\n]{0,30}"
    r"\b(system prompt|your (?:system )?(?:prompt|instructions)|hidden instructions)\b"
    r"|\bsystem prompt\b"
    r"|\b(developer|god|dan|jailbreak) mode\b|\bjailbreak\b"
    r"|\byou are now\b|\bpretend (?:you are|to be)\b|\bnew instructions\b",
    re.IGNORECASE,
)
_OFF_TOPIC_RE = re.compile(
    r"\b(recipes?|cook(?:ing)?|bake|baking|ingredients?|poem|haiku|lyrics|limerick|"
    r"jokes?|horoscope|weather|movies?|tv shows?|celebrit(?:y|ies)|riddle|trivia|"
    r"homework|translate|capital of|who won|sports? scores?)\b"
    r"|\b(write|fix|debug|refactor)\b[^.?!\n]{0,30}"
    r"\b(code|python|javascript|typescript|java|c\+\+|sql|html|css|regex|function|"
    r"script|program)\b"
    r"|\b(solve|integrate|differentiate)\b[^.?!\n]{0,20}\b(equation|integral|x)\b",
    re.IGNORECASE,
)
_FINANCE_RE = re.compile(
    r"\b(stocks?|shares?|equit(?:y|ies)|earnings|revenue|sales|margins?|guidance|"
    r"eps|dividends?|buybacks?|portfolio|holdings?|positions?|invest\w*|markets?|"
    r"valuation|p/?e|tickers?|quarter(?:ly)?|fiscal|transcripts?|conference call|"
    r"price|prices|priced|trad(?:e|es|ing)|etfs?|index|indices|s&p|nasdaq|dow|bonds?|"
    r"yields?|interest rates?|inflation|fed|ipo|capex|cash flow|balance sheet|"
    r"analysts?|ceo|cfo|compan(?:y|ies)|sector|returns?|gains?|loss(?:es)?|"
    r"average cost|cost basis|options?|short(?:ing)?|hedge|recession|gdp|"
    r"profit|profits|income|debt|growth|demand|outlook|bull|bear|volatility)\b",
    re.IGNORECASE,
)
# Ticker-like tokens: "$NVDA" or an all-caps word such as "MSFT" (case-sensitive).
_TICKER_TOKEN_RE = re.compile(r"\$[A-Z]{1,5}\b|\b[A-Z]{2,5}\b")
_ADVICE_RE = re.compile(
    r"\bshould i\b[^.?!\n]{0,40}\b(buy|sell|hold|invest|short|dump|add|trim|keep|"
    r"get out|exit)\b"
    r"|\b(is|are)\b[^.?!\n]{0,30}\b(a )?(good|great|bad|smart) (buy|investment|"
    r"stock to buy)\b"
    r"|\bwhat (stocks?|shares?) should i\b|\bgood time to (buy|sell|invest)\b"
    r"|\b(buy|sell),? or (sell|hold|buy)\b|\bworth (buying|investing in)\b",
    re.IGNORECASE,
)
# All-caps words that are not tickers, so they don't count as a finance signal.
_NOT_TICKERS = {"OK", "AI", "USA", "US", "UK", "EU", "PM", "AM", "FAQ", "LOL", "THE"}


class Verdict(StrEnum):
    ALLOW = "allow"
    OFF_TOPIC = "off_topic"
    INJECTION = "injection"


@dataclass(frozen=True)
class GuardResult:
    verdict: Verdict
    reply: str | None = None
    advice_request: bool = False


def _has_finance_signal(message: str) -> bool:
    if _FINANCE_RE.search(message):
        return True
    return any(
        token not in _NOT_TICKERS and not _OFF_TOPIC_RE.fullmatch(token)
        for token in (
            m.group(0).lstrip("$") for m in _TICKER_TOKEN_RE.finditer(message)
        )
    )


def check_message(message: str) -> GuardResult:
    """Classify a user message before any model call."""
    if _INJECTION_RE.search(message):
        return GuardResult(Verdict.INJECTION, INJECTION_REPLY)
    if _OFF_TOPIC_RE.search(message) and not _has_finance_signal(message):
        return GuardResult(Verdict.OFF_TOPIC, OFF_TOPIC_REPLY)
    return GuardResult(Verdict.ALLOW, advice_request=bool(_ADVICE_RE.search(message)))


def ensure_advice_note(text: str) -> str:
    """Append the not-financial-advice note if the answer lacks one."""
    if re.search(r"not (?:financial|investment) advice", text, re.IGNORECASE):
        return text
    return f"{text.rstrip()}\n\n{ADVICE_NOTE}"
