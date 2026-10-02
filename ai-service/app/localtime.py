"""User time zone handling: validation and local formatting of timestamps."""

from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULT_TIME_ZONE = "UTC"


def valid_time_zone(name: object) -> str | None:
    """The IANA zone name if it is valid (e.g. "America/New_York"), else None."""
    if not isinstance(name, str) or not name or len(name) > 64:
        return None
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return None
    return name


def zone(name: str | None) -> ZoneInfo:
    return ZoneInfo(valid_time_zone(name) or DEFAULT_TIME_ZONE)


def format_local(moment: datetime, time_zone: str | None) -> str:
    """E.g. "Oct 2, 2026, 11:10 AM EDT" in the user's zone (portable strftime)."""
    local = moment.astimezone(zone(time_zone))
    hour = local.strftime("%I").lstrip("0") or "12"
    return f"{local:%b} {local.day}, {local.year}, {hour}:{local:%M %p} {local:%Z}"
