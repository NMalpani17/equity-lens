"""Tests for the sliding-window limiter and Gemini retry-after parsing."""

from google.genai import errors as genai_errors

from app.services.rag.embeddings import gemini_retry_after
from app.services.rag.rate_limit import SlidingWindowLimiter


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def time(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def test_limiter_waits_for_the_window_to_free_up() -> None:
    clock = FakeClock()
    limiter = SlidingWindowLimiter(100, 60, clock=clock.time, sleep=clock.sleep)

    limiter.acquire(60)
    clock.now = 10
    limiter.acquire(40)  # fits exactly
    limiter.acquire(30)  # must wait until the first batch ages out at t=60

    assert clock.sleeps == [50]


def test_disabled_limiter_never_sleeps() -> None:
    clock = FakeClock()
    limiter = SlidingWindowLimiter(0, clock=clock.time, sleep=clock.sleep)

    for _ in range(5):
        limiter.acquire(1000)

    assert clock.sleeps == []


def test_gemini_retry_after_reads_retry_info() -> None:
    exc = genai_errors.ClientError(
        429,
        {
            "error": {
                "code": 429,
                "message": "Quota exceeded. Please retry in 19.8s.",
                "status": "RESOURCE_EXHAUSTED",
                "details": [
                    {
                        "@type": "type.googleapis.com/google.rpc.RetryInfo",
                        "retryDelay": "19s",
                    }
                ],
            }
        },
    )

    assert gemini_retry_after(exc) == 19.0
    assert gemini_retry_after(ValueError("nope")) is None
