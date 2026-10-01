"""Tests for parsing Equibles payloads into Transcript models."""

from datetime import date

from app.models.transcript import Transcript, company_from_event_title


def test_company_from_event_title() -> None:
    assert company_from_event_title("Nvidia Corp Q1 FY2027 Earnings Call") == (
        "Nvidia Corp"
    )
    assert company_from_event_title("Some Investor Day") is None
    assert company_from_event_title(None) is None


def test_from_equibles_parses_turns_and_falls_back_to_ticker() -> None:
    transcript = Transcript.from_equibles(
        {
            "ticker": "nvda",
            "eventTitle": None,
            "callDate": "2026-05-20T00:00:00+00:00",
            "fiscalYear": 2027,
            "fiscalQuarter": 1,
            "data": [
                {
                    "speakerIndex": 1,
                    "speakerName": None,
                    "speakerRole": "Operator",
                    "text": "Good afternoon.",
                    "startSeconds": 0.0,
                }
            ],
        }
    )

    assert transcript.ticker == "NVDA"
    assert transcript.company_name == "NVDA"
    assert transcript.call_date == date(2026, 5, 20)
    assert transcript.period_label == "FY2027Q1"
    assert transcript.turns[0].speaker_role == "Operator"
