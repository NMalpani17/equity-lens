"""Dates in report text read like "Apr 8, 2026", never "2026-04-08".

The writer is told so; anything ISO that still slips through (tools and
passages carry ISO dates) is rewritten when the report is assembled.
"""

import re
from datetime import date

_MONTHS = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)
ISO_DATE_RE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
# "Apr 8, 2026", "April 8, 2026", "Sept. 30, 2026"
READABLE_DATE_RE = re.compile(
    r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? "
    r"\d{1,2}, \d{4}\b"
)


def readable_date(value: date) -> str:
    """``date(2026, 4, 8)`` -> "Apr 8, 2026" (no locale dependence)."""
    return f"{_MONTHS[value.month - 1]} {value.day}, {value.year}"


def readable_dates(text: str) -> str:
    """Rewrite every valid ISO date in ``text`` as "Apr 8, 2026"."""

    def replace(match: re.Match[str]) -> str:
        try:
            year, month, day = (int(part) for part in match.groups())
            return readable_date(date(year, month, day))
        except ValueError:
            return match.group(0)

    return ISO_DATE_RE.sub(replace, text)
