"""A tiny thread-safe TTL cache for quotes."""

import threading
import time

from app.models.quote import Quote


class QuoteCache:
    """In-memory cache mapping ticker -> Quote with a per-entry TTL."""

    def __init__(self, ttl_seconds: int) -> None:
        self._ttl = ttl_seconds
        self._store: dict[str, tuple[float, Quote]] = {}
        self._lock = threading.Lock()

    def get(self, ticker: str) -> Quote | None:
        """Return the cached quote for ``ticker`` if present and not expired."""
        key = ticker.upper()
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            expires_at, quote = entry
            if time.monotonic() >= expires_at:
                del self._store[key]
                return None
            return quote

    def set(self, ticker: str, quote: Quote) -> None:
        """Cache ``quote`` under ``ticker`` for the configured TTL."""
        key = ticker.upper()
        with self._lock:
            self._store[key] = (time.monotonic() + self._ttl, quote)

    def clear(self) -> None:
        """Drop all cached entries (used in tests)."""
        with self._lock:
            self._store.clear()
