"""Thread-safe LRU cache with per-entry TTL (query embeddings, rerank results)."""

import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Hashable


class TTLCache[V]:
    """Bounded LRU mapping whose entries expire ``ttl_seconds`` after insert."""

    def __init__(
        self,
        max_size: int,
        ttl_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_size = max_size
        self._ttl = ttl_seconds
        self._clock = clock
        self._store: OrderedDict[Hashable, tuple[float, V]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: Hashable) -> V | None:
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            expires_at, value = entry
            if self._clock() >= expires_at:
                del self._store[key]
                return None
            self._store.move_to_end(key)
            return value

    def set(self, key: Hashable, value: V) -> None:
        with self._lock:
            self._store[key] = (self._clock() + self._ttl, value)
            self._store.move_to_end(key)
            while len(self._store) > self._max_size:
                self._store.popitem(last=False)

    def get_or_compute(self, key: Hashable, compute: Callable[[], V]) -> V:
        """Return the cached value, computing and caching it on a miss."""
        cached = self.get(key)
        if cached is not None:
            return cached
        value = compute()
        self.set(key, value)
        return value

    def __len__(self) -> int:
        with self._lock:
            return len(self._store)
