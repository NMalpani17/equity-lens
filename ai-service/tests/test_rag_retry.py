"""Tests for the exponential backoff retry helper."""

import pytest

from app.services.rag.retry import RetryPolicy, retry_call


class Transient(Exception):
    pass


def test_retries_until_success_with_growing_delay_ceiling() -> None:
    delays: list[float] = []
    policy = RetryPolicy(
        max_attempts=4, base_delay=1, max_delay=100, sleep=delays.append
    )
    outcomes = iter([Transient(), Transient(), "ok"])

    def fn() -> str:
        result = next(outcomes)
        if isinstance(result, Exception):
            raise result
        return result

    result = retry_call(
        fn,
        is_retryable=lambda e: isinstance(e, Transient),
        policy=policy,
        operation="test",
    )

    assert result == "ok"
    assert len(delays) == 2
    assert 0 <= delays[0] <= 1 and 0 <= delays[1] <= 2


def test_non_retryable_errors_propagate_immediately() -> None:
    calls = 0

    def fn() -> None:
        nonlocal calls
        calls += 1
        raise ValueError("bad input")

    with pytest.raises(ValueError):
        retry_call(
            fn,
            is_retryable=lambda e: isinstance(e, Transient),
            policy=RetryPolicy(sleep=lambda _: None),
            operation="test",
        )
    assert calls == 1


def test_delay_is_capped_at_max_delay() -> None:
    policy = RetryPolicy(base_delay=10, max_delay=15)

    assert all(policy.delay_for(attempt) <= 15 for attempt in range(1, 10))


def test_server_requested_delay_is_honored_and_capped() -> None:
    delays: list[float] = []
    policy = RetryPolicy(
        max_attempts=3, base_delay=0, max_server_delay=60, sleep=delays.append
    )
    outcomes = iter([Transient("wait 45"), Transient("wait 500"), "ok"])

    def fn() -> str:
        result = next(outcomes)
        if isinstance(result, Exception):
            raise result
        return result

    retry_call(
        fn,
        is_retryable=lambda e: isinstance(e, Transient),
        policy=policy,
        operation="test",
        retry_after=lambda e: float(str(e).split()[-1]),
    )

    assert delays == [45, 60]
