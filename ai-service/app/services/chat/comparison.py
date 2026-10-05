"""The compare_quarters tool: a quarter-over-quarter "what changed" view.

Wraps :class:`QuarterComparisonService` for chat: share-class mapping, the
same wait-for-index behavior as search_transcripts, turn-unique citation ids,
and model-facing text grouped by theme and quarter. A quarter with no
passages for a theme is marked as not discussed *in the retrieved passages*,
never as dropped.
"""

from app.models.comparison import FiscalPeriod, QuarterComparison
from app.services.rag.errors import RagNotConfiguredError

from .citations import CitationRegistry, Source, format_passage
from .context import TurnContext
from .transcripts import (
    UNTRUSTED_NOTE,
    SearchDeps,
    SearchOutput,
    await_index,
    json_output,
    passage_data,
    run_guarded,
    transcript_ticker,
)

NOT_DISCUSSED = "NOT DISCUSSED IN THE RETRIEVED PASSAGES"


def _period(year: int | None, quarter: int | None) -> tuple[int, int] | None:
    return (year, quarter) if year is not None and quarter is not None else None


def _quarter_label(period: FiscalPeriod) -> str:
    return f"Q{period.fiscal_quarter} FY{period.fiscal_year}"


def compare_quarters(
    deps: SearchDeps,
    turn: TurnContext | None,
    *,
    ticker: str,
    focus: str | None = None,
    current_fiscal_year: int | None = None,
    current_fiscal_quarter: int | None = None,
    prior_fiscal_year: int | None = None,
    prior_fiscal_quarter: int | None = None,
) -> SearchOutput:
    """Compare two of a company's calls theme by theme (default: latest two)."""
    pairs = (
        (current_fiscal_year, current_fiscal_quarter),
        (prior_fiscal_year, prior_fiscal_quarter),
    )
    if any((year is None) != (quarter is None) for year, quarter in pairs):
        return json_output(
            {
                "status": "invalid_quarters",
                "ticker": ticker,
                "message": "Give a fiscal year together with its fiscal quarter "
                "(use resolve_company to map a period phrase), or omit both to "
                "compare the latest two calls.",
            }
        )
    symbol, class_note = transcript_ticker(ticker, deps.ticker_record)
    assert symbol is not None
    current = _period(current_fiscal_year, current_fiscal_quarter)
    prior = _period(prior_fiscal_year, prior_fiscal_quarter)

    def compare() -> QuarterComparison:
        if deps.comparison is None:
            raise RagNotConfiguredError(["quarter comparison"])
        return deps.comparison().compare(
            symbol, current=current, prior=prior, focus=focus
        )

    def run() -> QuarterComparison | SearchOutput:
        result = compare()
        if result.status == "indexing":
            waiting = await_index(deps, turn, symbol)
            if waiting is not None:
                return waiting
            result = compare()
        return result

    outcome = run_guarded(run, symbol)
    if isinstance(outcome, SearchOutput):
        return outcome
    if outcome.status != "ok":
        return json_output(
            {
                "status": outcome.status,
                "ticker": outcome.ticker,
                "message": outcome.message
                or f"{outcome.ticker} can't be compared right now.",
                "available_quarters": outcome.available_quarters,
            }
        )
    registry = turn.sources if turn else CitationRegistry()
    return _render(outcome, registry, class_note)


def _render(
    result: QuarterComparison, registry: CitationRegistry, class_note: str | None
) -> SearchOutput:
    assert result.current is not None and result.prior is not None
    newer, older = _quarter_label(result.current), _quarter_label(result.prior)
    sections: list[str] = []
    themes: list[dict] = []
    sources: list[Source] = []
    for theme in result.themes:
        blocks = []
        ids: dict[str, list[int]] = {}
        for side, label, passages in (
            ("current", f"{newer} (newer)", theme.current),
            ("prior", f"{older} (earlier)", theme.prior),
        ):
            added = [registry.add(p) for p in passages]
            sources.extend(added)
            ids[side] = [s.id for s in added]
            body = (
                "\n\n".join(format_passage(s) for s in added)
                if added
                else NOT_DISCUSSED
            )
            blocks.append(f"### {label}\n{body}")
        sections.append(f"## {theme.label}\n" + "\n\n".join(blocks))
        themes.append({"key": theme.key, "label": theme.label, **ids})

    notes = [n for n in (result.note, class_note) if n]
    header = (
        f"{UNTRUSTED_NOTE}\nComparing {result.ticker}'s {newer} earnings call "
        f"(newer) with {older} (earlier). Passages were retrieved separately "
        "for each quarter and grouped by theme; the groups are retrieval hints, "
        "so classify each point by what it says. Cite every claim with a "
        "passage from the quarter it describes"
    )
    header += f", e.g. [{sources[0].id}]." if sources else "."
    header += (
        f' "{NOT_DISCUSSED}" means no relevant passage was retrieved for that '
        'quarter: say "not discussed in the retrieved passages", never that '
        "management dropped the topic, or that something didn't happen or "
        "wasn't said in that quarter."
    )
    if notes:
        header += "\nNote: " + " ".join(notes)

    data: dict = {
        "status": "ok" if sources else "no_results",
        "ticker": result.ticker,
        "company_name": result.company_name,
        "current": result.current.model_dump(),
        "prior": result.prior.model_dump(),
        "focus": result.focus,
        "reranked": result.reranked,
        "themes": themes,
        "passages": [passage_data(s) for s in sources],
    }
    if notes:
        data["note"] = " ".join(notes)
    return SearchOutput(text=header + "\n\n" + "\n\n".join(sections), data=data)
