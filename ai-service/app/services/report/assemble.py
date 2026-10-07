"""Turn the graph's final state into the stored, shared report.

Citations are validated with the chat citation logic across all six
sections at once (one numbering for the whole report), and only passages the
writer was shown may be cited. [Dn] markers must name a data source from the
market analyst. Nothing user-specific is included.
"""

import logging
from typing import Any

from app.config import Settings
from app.models.report import (
    SECTIONS,
    ReportAsOf,
    ReportDraft,
    ReportPeriod,
    ReportSection,
    ResearchReportContent,
)
from app.services.chat.citations import CitationNumbering, CitationRegistry
from app.services.chat.formatting import tidy_answer

from .graph import (
    MarketResearch,
    Period,
    ReportError,
    TranscriptResearch,
    writer_passage_ids,
)
from .sources import validate_data_refs

logger = logging.getLogger(__name__)

PRICE_UNAVAILABLE = "Price data was unavailable when this report was generated."


def _call_date(
    registry: CitationRegistry, ids: list[int], period: Period
) -> str | None:
    for i in ids:
        source = registry.get(i)
        if source and (source.fiscal_year, source.fiscal_quarter) == (
            period.fiscal_year,
            period.fiscal_quarter,
        ):
            return source.call_date
    return None


def assemble_report(
    state: dict[str, Any],
    *,
    ticker: str,
    company_name: str,
    registry: CitationRegistry,
    settings: Settings,
) -> ResearchReportContent:
    research: TranscriptResearch | None = state.get("transcripts")
    draft: ReportDraft | None = state.get("draft")
    if research is None or draft is None:
        raise ReportError("incomplete", "The report didn't finish.", retryable=True)
    market: MarketResearch = state.get("market") or MarketResearch()

    allowed = set(writer_passage_ids(research, settings))
    numbering = CitationNumbering(registry, allowed=allowed)
    known_refs = {s.id for s in market.sources}
    sections: list[ReportSection] = []
    dropped_refs: list[str] = []
    for key, title in SECTIONS:
        text = getattr(draft, key)
        if key == "stock" and not market.ok:
            text = PRICE_UNAVAILABLE
        refs = validate_data_refs(text, known_refs)
        dropped_refs.extend(refs.dropped)
        markdown = tidy_answer(numbering.apply(refs.text))
        if not markdown:
            raise ReportError(
                "writer_failed",
                f'The report came back without a "{title}" section. Please try again.',
                retryable=True,
            )
        sections.append(ReportSection(key=key, title=title, markdown=markdown))
    if numbering.dropped or dropped_refs:
        logger.warning(
            "report %s dropped citations: passages %s, data %s",
            ticker,
            numbering.dropped,
            dropped_refs,
        )

    quote = next((s for s in market.sources if s.kind == "quote"), None)
    history = next((s for s in market.sources if s.kind == "price_history"), None)
    return ResearchReportContent(
        ticker=ticker,
        company_name=company_name,
        quarter=ReportPeriod(
            fiscal_year=research.current.fiscal_year,
            fiscal_quarter=research.current.fiscal_quarter,
            call_date=_call_date(registry, research.passage_ids, research.current),
        ),
        prior_quarter=ReportPeriod(
            fiscal_year=research.prior.fiscal_year,
            fiscal_quarter=research.prior.fiscal_quarter,
            call_date=_call_date(registry, research.passage_ids, research.prior),
        ),
        sections=sections,
        citations=numbering.citations,
        data_sources=market.sources,
        chart=market.chart,
        market_data_available=market.ok,
        as_of=ReportAsOf(
            latest_call=_call_date(registry, research.passage_ids, research.current),
            quote=quote.as_of if quote else None,
            prices=history.as_of if history else None,
        ),
        agents=list(state.get("runs") or []),
    )
