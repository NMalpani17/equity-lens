"""One sector taxonomy for Finnhub industries and Yahoo sectors.

Finnhub's free profile gives an industry ("Semiconductors", "Banking") and
Yahoo a sector of its own naming ("Consumer Cyclical"). Both map onto the 11
GICS sectors, plus "Funds" for ETFs and mutual funds, so a portfolio groups
the same way whichever provider answered. Anything unmapped is None, which the
portfolio shows as "Other".
"""

FUNDS = "Funds"

INFORMATION_TECHNOLOGY = "Information Technology"
HEALTH_CARE = "Health Care"
FINANCIALS = "Financials"
CONSUMER_DISCRETIONARY = "Consumer Discretionary"
CONSUMER_STAPLES = "Consumer Staples"
COMMUNICATION_SERVICES = "Communication Services"
INDUSTRIALS = "Industrials"
ENERGY = "Energy"
UTILITIES = "Utilities"
REAL_ESTATE = "Real Estate"
MATERIALS = "Materials"

SECTORS = frozenset(
    {
        INFORMATION_TECHNOLOGY,
        HEALTH_CARE,
        FINANCIALS,
        CONSUMER_DISCRETIONARY,
        CONSUMER_STAPLES,
        COMMUNICATION_SERVICES,
        INDUSTRIALS,
        ENERGY,
        UTILITIES,
        REAL_ESTATE,
        MATERIALS,
        FUNDS,
    }
)

_FINNHUB_INDUSTRIES: dict[str, str] = {
    "technology": INFORMATION_TECHNOLOGY,
    "semiconductors": INFORMATION_TECHNOLOGY,
    # Communications equipment (e.g. Cisco); telecom carriers are below.
    "communications": INFORMATION_TECHNOLOGY,
    "health care": HEALTH_CARE,
    "biotechnology": HEALTH_CARE,
    "pharmaceuticals": HEALTH_CARE,
    "life sciences tools & services": HEALTH_CARE,
    "banking": FINANCIALS,
    "financial services": FINANCIALS,
    "insurance": FINANCIALS,
    "automobiles": CONSUMER_DISCRETIONARY,
    "auto components": CONSUMER_DISCRETIONARY,
    "retail": CONSUMER_DISCRETIONARY,
    "hotels, restaurants & leisure": CONSUMER_DISCRETIONARY,
    "leisure products": CONSUMER_DISCRETIONARY,
    "textiles, apparel & luxury goods": CONSUMER_DISCRETIONARY,
    "diversified consumer services": CONSUMER_DISCRETIONARY,
    "distributors": CONSUMER_DISCRETIONARY,
    "beverages": CONSUMER_STAPLES,
    "food products": CONSUMER_STAPLES,
    "tobacco": CONSUMER_STAPLES,
    "consumer products": CONSUMER_STAPLES,
    "media": COMMUNICATION_SERVICES,
    "telecommunication": COMMUNICATION_SERVICES,
    "aerospace & defense": INDUSTRIALS,
    "airlines": INDUSTRIALS,
    "building": INDUSTRIALS,
    "commercial services & supplies": INDUSTRIALS,
    "construction": INDUSTRIALS,
    "electrical equipment": INDUSTRIALS,
    "industrial conglomerates": INDUSTRIALS,
    "logistics & transportation": INDUSTRIALS,
    "machinery": INDUSTRIALS,
    "marine": INDUSTRIALS,
    "professional services": INDUSTRIALS,
    "road & rail": INDUSTRIALS,
    "trading companies & distributors": INDUSTRIALS,
    "transportation infrastructure": INDUSTRIALS,
    "energy": ENERGY,
    "utilities": UTILITIES,
    "real estate": REAL_ESTATE,
    "chemicals": MATERIALS,
    "metals & mining": MATERIALS,
    "packaging": MATERIALS,
    "paper & forest": MATERIALS,
}

_YAHOO_SECTORS: dict[str, str] = {
    "technology": INFORMATION_TECHNOLOGY,
    "healthcare": HEALTH_CARE,
    "financial services": FINANCIALS,
    "consumer cyclical": CONSUMER_DISCRETIONARY,
    "consumer defensive": CONSUMER_STAPLES,
    "communication services": COMMUNICATION_SERVICES,
    "industrials": INDUSTRIALS,
    "energy": ENERGY,
    "utilities": UTILITIES,
    "real estate": REAL_ESTATE,
    "basic materials": MATERIALS,
}

# Yahoo quote types that are funds rather than companies.
_FUND_QUOTE_TYPES = frozenset({"ETF", "MUTUALFUND"})


def _key(label: str | None) -> str:
    return (label or "").strip().lower()


def _as_gics(label: str | None) -> str | None:
    """A label that already is one of our sectors, in any case."""
    key = _key(label)
    return next((s for s in SECTORS if s.lower() == key), None)


def sector_from_finnhub(industry: str | None) -> str | None:
    return _FINNHUB_INDUSTRIES.get(_key(industry)) or _as_gics(industry)


def sector_from_yahoo(sector: str | None, quote_type: str | None = None) -> str | None:
    if (quote_type or "").upper() in _FUND_QUOTE_TYPES:
        return FUNDS
    return _YAHOO_SECTORS.get(_key(sector)) or _as_gics(sector)
