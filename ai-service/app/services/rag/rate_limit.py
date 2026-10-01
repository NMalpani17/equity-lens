"""Sliding-window rate limiter for quota units (e.g. texts embedded per minute)."""

import threading
import time
from collections import deque
from collections.abc import Callable


class SlidingWindowLimiter:
    """Blocks until ``units`` fit within ``max_units`` per ``period`` seconds.

    ``max_units <= 0`` disables limiting. A single request larger than the
    window is allowed through once the window is empty.
    """

    def __init__(
        self,
        max_units: int,
        period: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._max_units = max_units
        self._period = period
        self._clock = clock
        self._sleep = sleep
        self._events: deque[tuple[float, int]] = deque()
        self._used = 0
        self._lock = threading.Lock()

    def acquire(self, units: int) -> None:
        if self._max_units <= 0:
            return
        with self._lock:
            while True:
                now = self._clock()
                while self._events and now - self._events[0][0] >= self._period:
                    self._used -= self._events.popleft()[1]
                if not self._events or self._used + units <= self._max_units:
                    self._events.append((now, units))
                    self._used += units
                    return
                self._sleep(self._period - (now - self._events[0][0]))
