"""Proper company names for display ("Amazon.com, Inc.", not "Amazon Com Inc").

Equibles event titles carry SEC-style names ("Nvidia Corp", "Jpmorgan Chase &
Co"). The indexed and demo companies get their legal names from a curated
table; any other name only gets the missing period on a trailing "Inc", "Corp",
"Co" or "Ltd", never a guessed spelling. Names are cleaned at ingestion and
again on every read, so rows and vectors written before this module still
display correctly.

The api keeps the same table for the rows it reads directly
(``api/src/services/companyNames.ts``); keep the two in sync.
"""

import re

COMPANY_NAMES: dict[str, str] = {
    "AAPL": "Apple Inc.",
    "AMD": "Advanced Micro Devices, Inc.",
    "AMZN": "Amazon.com, Inc.",
    "COST": "Costco Wholesale Corporation",
    "GOOG": "Alphabet Inc.",
    "GOOGL": "Alphabet Inc.",
    "JPM": "JPMorgan Chase & Co.",
    "META": "Meta Platforms, Inc.",
    "MSFT": "Microsoft Corporation",
    "NFLX": "Netflix, Inc.",
    "NKE": "NIKE, Inc.",
    "NVDA": "NVIDIA Corporation",
    "SBUX": "Starbucks Corporation",
    "TSLA": "Tesla, Inc.",
}

# A trailing abbreviation without its period: "Microsoft Corp" -> "Corp."
_BARE_SUFFIX_RE = re.compile(r"(?<=\s)(Inc|Corp|Co|Ltd)$")


def company_display_name(ticker: str, name: str | None) -> str:
    """The proper name for ``ticker``; ``name`` cleaned lightly, else the ticker."""
    curated = COMPANY_NAMES.get(ticker.strip().upper())
    if curated:
        return curated
    text = " ".join((name or "").split())
    if not text:
        return ticker
    return _BARE_SUFFIX_RE.sub(r"\1.", text)
