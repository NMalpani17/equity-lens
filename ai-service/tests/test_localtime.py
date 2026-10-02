"""User time zone validation and local formatting."""

from datetime import UTC, date, datetime

import pytest

from app.localtime import format_local, valid_time_zone
from app.models.chat import ChatTurnRequest
from app.services.chat.prompt import build_system_prompt


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("America/New_York", "America/New_York"),
        ("Asia/Kolkata", "Asia/Kolkata"),
        ("UTC", "UTC"),
        ("Not/AZone", None),
        ("../../etc/passwd", None),
        ("", None),
        (None, None),
        (42, None),
    ],
)
def test_valid_time_zone(name, expected) -> None:
    assert valid_time_zone(name) == expected


def test_format_local_converts_and_labels_the_zone() -> None:
    moment = datetime(2026, 10, 2, 3, 10, tzinfo=UTC)

    assert format_local(moment, "America/Los_Angeles") == "Oct 1, 2026, 8:10 PM PDT"
    assert format_local(moment, "Asia/Kolkata") == "Oct 2, 2026, 8:40 AM IST"
    assert format_local(moment, None) == "Oct 2, 2026, 3:10 AM UTC"
    assert format_local(datetime(2026, 1, 5, 12, 0, tzinfo=UTC), "UTC").endswith(
        "12:00 PM UTC"
    )


def test_request_drops_unknown_time_zones() -> None:
    ok = ChatTurnRequest(user_id="u", message="hi", time_zone="Europe/London")
    bad = ChatTurnRequest(user_id="u", message="hi", time_zone="Mars/Olympus")

    assert ok.time_zone == "Europe/London"
    assert bad.time_zone is None


def test_prompt_states_the_users_zone() -> None:
    prompt = build_system_prompt(
        date(2026, 10, 1),
        advice_request=False,
        is_anonymous=False,
        time_zone="America/Chicago",
    )

    assert (
        "Today's date is 2026-10-01 in the user's time zone (America/Chicago)" in prompt
    )
