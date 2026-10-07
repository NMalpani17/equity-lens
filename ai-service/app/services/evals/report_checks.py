"""Deterministic checks for a generated research report.

- sections_present: the six sections, in order, none empty
- citations_valid: every [n] is a returned citation, every [Dn] a data source
- sections_cited: every written section cites something (fixed "unavailable"
  texts excepted)
- numbers_from_sources: every figure appears in the sources it may come from:
  Stock performance only from market data, other sections from the cited
  passages or market data (years, dates, quarter labels and bare counts up to
  12 are not figures)
- changes_cite_both_quarters: "What changed" cites both compared quarters
- comparison_sections / comparison_closing: the comparison rules' headings
  and closing line
- no_fundamentals: no valuation figures in Stock performance (there is no
  fundamentals tool)
- disclaimer_and_dates: the not-advice note and the "as of" dates
"""

import json
import re
from typing import Any

from app.models.report import SECTIONS, ResearchReportContent
from app.services.report.assemble import UNAVAILABLE_SECTIONS

from .checks import comparison_closing_line, comparison_structure
from .models import CheckResult

_PASSAGE_REF_RE = re.compile(r"\[(\d{1,3})\]")
_DATA_REF_RE = re.compile(r"\[(D\d{1,2})\]")
# Not figures: citation markers, ISO dates, fiscal labels, years.
_NOT_FIGURES_RE = re.compile(
    r"\[D?\d{1,3}\]"
    r"|\b\d{4}-\d{2}-\d{2}\b"
    r"|\bQ[1-4]\b|\bFY\s?\d{2,4}\b"
    r"|\b(?:19|20)\d{2}\b"
)
# 1,234.5 / $96 / 75.0% / -3.2
_NUMBER_RE = re.compile(r"(?<![\w.])(\$?)(-?\d[\d,]*(?:\.\d+)?)(%?)")
_FUNDAMENTALS_RE = re.compile(
    r"\bP/?E\b|price[- ]to[- ]earnings|\bmarket cap(?:italization)?\b|"
    r"\bEV/EBITDA\b|valuation multiple|\bprice target\b",
    re.IGNORECASE,
)
SMALL_COUNT = 12


def _result(name: str, passed: bool, detail: str) -> CheckResult:
    return CheckResult(name=name, passed=passed, detail="" if passed else detail)


def figures(text: str) -> list[tuple[float, int]]:
    """Each figure in ``text`` as (value, decimals)."""
    out = []
    for match in _NUMBER_RE.finditer(_NOT_FIGURES_RE.sub(" ", text)):
        dollar, raw, percent = match.groups()
        value = float(raw.replace(",", ""))
        decimals = len(raw.split(".")[1]) if "." in raw else 0
        if not dollar and not percent and decimals == 0 and abs(value) <= SMALL_COUNT:
            continue  # "6 months", "3 agents", "two quarters": counts, not data
        out.append((value, decimals))
    return out


def _source_values(texts: list[str]) -> set[float]:
    values: set[float] = set()
    for text in texts:
        for match in _NUMBER_RE.finditer(text):
            values.add(float(match.group(2).replace(",", "")))
    return values


def _in_sources(value: float, decimals: int, sources: set[float]) -> bool:
    """True if a source number shows as ``value`` at the report's precision."""
    return any(
        round(s, decimals) == round(value, decimals)
        or round(abs(s), decimals) == round(abs(value), decimals)
        for s in sources
    )


def _unsupported(text: str, sources: set[float]) -> list[str]:
    return [
        f"{value:g}"
        for value, decimals in figures(text)
        if not _in_sources(value, decimals, sources)
    ]


def run_report_checks(report: ResearchReportContent) -> list[CheckResult]:
    sections = {s.key: s.markdown for s in report.sections}
    citation_ids = {c.id for c in report.citations}
    data_ids = {s.id for s in report.data_sources}
    unavailable = {
        key
        for key, text in UNAVAILABLE_SECTIONS.items()
        if sections.get(key, "").strip() == text
    }
    results: list[CheckResult] = []

    order = [s.key for s in report.sections]
    empty = [k for k, text in sections.items() if not text.strip()]
    expected = [key for key, _ in SECTIONS]
    results.append(
        _result(
            "sections_present",
            order == expected and not empty,
            f"sections {order}, empty {empty}",
        )
    )

    all_text = "\n".join(sections.values())
    bad_passages = sorted(
        {int(n) for n in _PASSAGE_REF_RE.findall(all_text)} - citation_ids
    )
    bad_data = sorted(set(_DATA_REF_RE.findall(all_text)) - data_ids)
    results.append(
        _result(
            "citations_valid",
            not bad_passages and not bad_data,
            f"unknown passages {bad_passages}, data {bad_data}",
        )
    )

    uncited = [
        key
        for key, text in sections.items()
        if key not in unavailable
        and not _PASSAGE_REF_RE.search(text)
        and not _DATA_REF_RE.search(text)
    ]
    results.append(_result("sections_cited", not uncited, f"uncited {uncited}"))

    market_texts = [json.dumps(s.data) for s in report.data_sources]
    by_id = {c.id: c for c in report.citations}
    offenders: list[str] = []
    for key, text in sections.items():
        if key in unavailable:
            continue
        if key == "stock":
            allowed = _source_values(market_texts)
        else:
            cited = [
                by_id[int(n)].text
                for n in _PASSAGE_REF_RE.findall(text)
                if int(n) in by_id
            ]
            allowed = _source_values(cited + market_texts)
        offenders.extend(f"{key}: {v}" for v in _unsupported(text, allowed))
    results.append(
        _result(
            "numbers_from_sources",
            not offenders,
            f"not in sources: {offenders[:6]}",
        )
    )

    if report.comparison_available and "changes" not in unavailable:
        changes = sections.get("changes", "")
        cited_quarters = {
            (by_id[int(n)].fiscal_year, by_id[int(n)].fiscal_quarter)
            for n in _PASSAGE_REF_RE.findall(changes)
            if int(n) in by_id
        }
        wanted = {(report.quarter.fiscal_year, report.quarter.fiscal_quarter)}
        if report.prior_quarter:
            wanted.add(
                (report.prior_quarter.fiscal_year, report.prior_quarter.fiscal_quarter)
            )
        results.append(
            _result(
                "changes_cite_both_quarters",
                wanted <= cited_quarters,
                f"cited {sorted(cited_quarters)}, need {sorted(wanted)}",
            )
        )
        results.append(comparison_structure(changes))
        results.append(comparison_closing_line(changes))

    fundamentals = _FUNDAMENTALS_RE.findall(sections.get("stock", ""))
    results.append(
        _result("no_fundamentals", not fundamentals, f"mentions {fundamentals}")
    )

    missing: list[str] = []
    if not re.search(r"not (?:financial|investment) advice", report.disclaimer, re.I):
        missing.append("disclaimer")
    if not report.as_of.latest_call:
        missing.append("latest call date")
    if report.market_data_available and not (
        report.as_of.quote and report.as_of.prices
    ):
        missing.append("market data dates")
    results.append(_result("disclaimer_and_dates", not missing, f"missing {missing}"))
    return results


def report_markdown(report: ResearchReportContent) -> str:
    """The report as one Markdown document (what the judge reads)."""
    head = (
        f"# {report.company_name} ({report.ticker}): Q{report.quarter.fiscal_quarter} "
        f"FY{report.quarter.fiscal_year}"
    )
    body = "\n\n".join(f"## {s.title}\n{s.markdown}" for s in report.sections)
    return f"{head}\n\n{body}\n\n_{report.disclaimer}_"


def judge_evidence(report: ResearchReportContent) -> dict[str, Any]:
    """Citations and data sources in the shapes the judge's evidence uses."""
    return {
        "citations": [c.model_dump() for c in report.citations],
        "data": [
            {"id": s.id, "label": s.label, "as_of": s.as_of, **s.data}
            for s in report.data_sources
        ],
    }
