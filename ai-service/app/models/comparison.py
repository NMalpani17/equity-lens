"""Quarter-over-quarter comparison results.

Produced by :class:`app.services.rag.comparison.QuarterComparisonService` and
shaped for any consumer (the chat tool today, a multi-agent report later):
passages grouped by theme and quarter, with no chat or citation concepts.
"""

from typing import Literal

from pydantic import BaseModel, Field, computed_field

from app.models.rag import RagSearchResult
from app.models.transcript import period_label

ComparisonStatus = Literal[
    "ok",
    "indexing",
    "not_enough_quarters",
    "quarter_not_indexed",
    "invalid_quarters",
]


class FiscalPeriod(BaseModel):
    fiscal_year: int
    fiscal_quarter: int = Field(ge=1, le=4)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def label(self) -> str:
        """e.g. ``FY2026Q2``."""
        return period_label(self.fiscal_year, self.fiscal_quarter)

    @property
    def key(self) -> tuple[int, int]:
        return self.fiscal_year, self.fiscal_quarter


class ThemePassages(BaseModel):
    """Passages for one theme, retrieved separately for each quarter."""

    key: str
    label: str
    current: list[RagSearchResult] = Field(default_factory=list)
    prior: list[RagSearchResult] = Field(default_factory=list)


class QuarterComparison(BaseModel):
    status: ComparisonStatus
    ticker: str
    company_name: str | None = None
    # The newer quarter and the one it is compared with.
    current: FiscalPeriod | None = None
    prior: FiscalPeriod | None = None
    focus: str | None = None
    # False when the reranker was unavailable (hybrid order, no relevance cut).
    reranked: bool = False
    themes: list[ThemePassages] = Field(default_factory=list)
    # Indexed quarters (newest first), for statuses that explain a refusal.
    available_quarters: list[str] = Field(default_factory=list)
    note: str | None = None
    message: str | None = None
