"""Retry with exponential backoff and full jitter for flaky upstream calls."""

import logging
import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RetryPolicy:
    """How many times to retry and how long to wait between attempts."""

    max_attempts: int = 5
    base_delay: float = 1.0
    max_delay: float = 30.0
    sleep: Callable[[float], None] = field(default=time.sleep, compare=False)

    def delay_for(self, attempt: int) -> float:
        """Full-jitter backoff delay before retry number ``attempt`` (1-based)."""
        ceiling = min(self.max_delay, self.base_delay * (2 ** (attempt - 1)))
        return random.uniform(0, ceiling)


def retry_call[T](
    fn: Callable[[], T],
    *,
    is_retryable: Callable[[BaseException], bool],
    policy: RetryPolicy,
    operation: str,
) -> T:
    """Call ``fn``, retrying retryable errors with exponential backoff.

    Non-retryable errors, and the last retryable error once attempts are
    exhausted, propagate to the caller unchanged.
    """
    attempt = 1
    while True:
        try:
            return fn()
        except Exception as exc:
            if attempt >= policy.max_attempts or not is_retryable(exc):
                raise
            delay = policy.delay_for(attempt)
            logger.warning(
                "%s failed (attempt %d/%d), retrying in %.2fs: %s",
                operation,
                attempt,
                policy.max_attempts,
                delay,
                exc,
            )
            policy.sleep(delay)
            attempt += 1
