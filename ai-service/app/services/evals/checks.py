"""Deterministic checks: tools, citations, refusals, numbers, charts."""

import re

from app.services.chat.comparison_rules import COMPARISON_HEADINGS as RULE_HEADINGS
from app.services.chat.comparison_rules import NOTHING_FOUND
from app.services.chat.guardrails import INJECTION_REPLY, OFF_TOPIC_REPLY

from .models import CheckResult, EvalCase, TurnRecord

# The same test the agent uses before appending its own note (any wording).
_ADVICE_NOTE_RE = re.compile(r"not (?:financial|investment) advice", re.IGNORECASE)
_MARKER_RE = re.compile(r"\[(\d{1,3})\]")
_NUMBER_RE = re.compile(r"-?\$?\d[\d,]*(?:\.\d+)?")
# A Markdown heading or a line that is entirely bold ("**New**" / "**New:**").
_HEADING_RE = re.compile(
    r"^\s*(?:#{1,6}\s+(?P<hash>.+?)|\*\*(?P<bold>[^*]+)\*\*:?)\s*$"
)
# The quarter-comparison headings, in their required order.
COMPARISON_HEADINGS = (
    "new",
    "raised",
    "lowered",
    "no longer mentioned",
    "unchanged",
)
# "Lowered / worse, No longer mentioned: nothing found in the retrieved passages."
_CLOSING_RE = re.compile(
    rf"^(?P<categories>[A-Za-z /,]+?):\s*{NOTHING_FOUND}\.?$", re.IGNORECASE
)
# The pre-2026-10-06 status-first wording ("Nothing to report …: X").
_OLD_CLOSING = "nothing to report in the retrieved passages"
# A model-written redirect or refusal (the guardrail replies are matched exactly).
_REDIRECT_RE = re.compile(
    r"\b(can(?:'|no)t|cannot|unable to|not able to|won't|don't have access|"
    r"only (?:help|assist|discuss|answer|see|access)|outside (?:of )?(?:my|what)|"
    r"stick to|focus(?:ed)? on (?:stocks|investing|markets))\b",
    re.IGNORECASE,
)


def run_checks(case: EvalCase, turn: TurnRecord) -> list[CheckResult]:
    """Every applicable deterministic check for this case."""
    expect = case.expect
    if turn.error:
        return [CheckResult(name="completed", passed=False, detail=turn.error)]
    results = [_check_citations_resolve(turn)]
    if expect.tools:
        missing = [t for t in expect.tools if t not in turn.tool_names]
        results.append(_result("expected_tools", not missing, f"missing {missing}"))
    if expect.any_tools:
        hit = any(t in turn.tool_names for t in expect.any_tools)
        results.append(_result("any_tool", hit, f"none of {expect.any_tools}"))
    if expect.forbid_tools:
        used = [t for t in expect.forbid_tools if t in turn.tool_names]
        results.append(_result("forbidden_tools", not used, f"called {used}"))
    if expect.no_tools:
        results.append(_result("no_tools", not turn.tool_calls, str(turn.tool_names)))
    if expect.citations:
        results.extend(_citation_expectations(case, turn))
    if expect.comparison_sections:
        results.extend(_check_comparison_sections(turn))
    if expect.refusal:
        results.append(_result("refusal", is_refusal(turn), "answered instead"))
    if expect.clarify:
        results.append(_result("clarifies", asks_question(turn), "no question asked"))
    if expect.advice_note:
        has_note = bool(_ADVICE_NOTE_RE.search(turn.content))
        results.append(_result("advice_note", has_note, "no not-advice note"))
    if expect.charts:
        kinds = {c.get("kind") for c in turn.charts}
        missing = [k for k in expect.charts if k not in kinds]
        results.append(_result("charts", not missing, f"missing {missing}"))
    if expect.numbers:
        found = numbers_in(turn.content)
        missing = [
            n
            for n in expect.numbers
            if not any(abs(f - n) <= expect.number_tolerance for f in found)
        ]
        results.append(_result("numbers", not missing, f"missing {missing}"))
    text = turn.content.lower()
    if expect.mentions:
        missing = [m for m in expect.mentions if m.lower() not in text]
        results.append(_result("mentions", not missing, f"missing {missing}"))
    if expect.not_mentions:
        leaked = [m for m in expect.not_mentions if m.lower() in text]
        results.append(_result("not_mentions", not leaked, f"contains {leaked}"))
    return results


def _result(name: str, passed: bool, detail: str) -> CheckResult:
    return CheckResult(name=name, passed=passed, detail="" if passed else detail)


def _check_citations_resolve(turn: TurnRecord) -> CheckResult:
    """Every [n] in the answer maps to a passage the tools actually returned."""
    markers = {int(m) for m in _MARKER_RE.findall(turn.content)}
    ids = {int(c.get("id", -1)) for c in turn.citations}
    unknown = sorted(markers - ids)
    return _result("citations_valid", not unknown, f"unresolved markers {unknown}")


def _citation_expectations(case: EvalCase, turn: TurnRecord) -> list[CheckResult]:
    expect = case.expect
    results = [
        _result(
            "has_citations",
            len(turn.citations) >= expect.min_citations,
            f"{len(turn.citations)} < {expect.min_citations}",
        )
    ]
    if expect.citation_tickers:
        wrong = sorted(
            {
                str(c.get("ticker"))
                for c in turn.citations
                if c.get("ticker") not in expect.citation_tickers
            }
        )
        results.append(_result("citation_tickers", not wrong, f"cited {wrong}"))
    quarters = {
        f"FY{c.get('fiscal_year')}Q{c.get('fiscal_quarter')}" for c in turn.citations
    }
    if expect.min_citation_quarters or expect.max_citation_quarters:
        low = expect.min_citation_quarters
        high = expect.max_citation_quarters or len(quarters)
        results.append(
            _result(
                "citation_quarters",
                low <= len(quarters) <= high,
                f"{len(quarters)} quarter(s) cited",
            )
        )
    if expect.citation_periods:
        results.append(
            _result(
                "citation_periods",
                quarters == set(expect.citation_periods),
                f"cited {sorted(quarters)}",
            )
        )
    return results


def comparison_headings(content: str) -> list[str]:
    """The answer's heading lines (Markdown or all-bold), lower-cased."""
    headings = []
    for line in content.splitlines():
        match = _HEADING_RE.match(line)
        if match:
            title = match.group("hash") or match.group("bold")
            headings.append(title.strip(" *:").lower())
    return headings


def _check_comparison_sections(turn: TurnRecord) -> list[CheckResult]:
    return [
        comparison_structure(turn.content),
        comparison_closing_line(turn.content),
    ]


def comparison_structure(content: str) -> CheckResult:
    """Every heading is one of the five comparison headings, in order, and
    at least one change heading (New / Raised / Lowered / No longer
    mentioned) is present."""
    headings = comparison_headings(content)
    order = [
        next((i for i, h in enumerate(COMPARISON_HEADINGS) if title.startswith(h)), -1)
        for title in headings
    ]
    if -1 in order:
        other = headings[order.index(-1)]
        return _result("comparison_sections", False, f"unexpected heading {other!r}")
    if order != sorted(set(order)):
        return _result("comparison_sections", False, f"out of order: {headings}")
    has_change = any(i < COMPARISON_HEADINGS.index("unchanged") for i in order)
    return _result("comparison_sections", has_change, "no change headings")


def comparison_closing_line(content: str) -> CheckResult:
    """The closing line names exactly the empty categories, category first:
    "Lowered / worse, No longer mentioned: nothing found in the retrieved
    passages." It is left out when every category has content."""
    name = "comparison_closing"
    present = {
        i
        for title in comparison_headings(content)
        for i, h in enumerate(COMPARISON_HEADINGS)
        if title.startswith(h)
    }
    empty = [h for i, h in enumerate(RULE_HEADINGS) if i not in present]
    lines = [
        line.strip().strip("*_ ").strip()
        for line in content.splitlines()
        if NOTHING_FOUND in line.lower() or _OLD_CLOSING in line.lower()
    ]
    if any(_OLD_CLOSING in line.lower() for line in lines):
        return _result(name, False, "old status-first closing line")
    if not lines:
        return _result(name, not empty, f"no closing line for {empty}")
    match = _CLOSING_RE.match(lines[-1])
    if match is None:
        return _result(name, False, f"malformed closing line {lines[-1]!r}")
    listed = [c.strip() for c in match.group("categories").split(",")]
    same = [c.lower() for c in listed] == [c.lower() for c in empty]
    return _result(name, same, f"listed {listed}, empty {empty}")


def is_refusal(turn: TurnRecord) -> bool:
    if turn.status == "refused" or turn.content.strip() in (
        OFF_TOPIC_REPLY,
        INJECTION_REPLY,
    ):
        return True
    return bool(_REDIRECT_RE.search(turn.content))


def asks_question(turn: TurnRecord) -> bool:
    """A short clarifying question, without having searched transcripts."""
    return "?" in turn.content and "search_transcripts" not in turn.tool_names


def numbers_in(text: str) -> list[float]:
    values = []
    for token in _NUMBER_RE.findall(text):
        try:
            values.append(float(token.replace("$", "").replace(",", "")))
        except ValueError:
            continue
    return values
