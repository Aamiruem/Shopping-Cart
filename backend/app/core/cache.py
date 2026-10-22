"""Tiny in-process TTL cache for hot, public reads (catalog lists, facets, categories).

Each API worker keeps its own copy for a few seconds; any product or stock change clears the
"catalog" namespace so shoppers never see stale data for long. With several replicas behind a load
balancer the TTL bounds staleness; swap this for Redis if you need cross-replica invalidation.
"""

import time
from collections.abc import Awaitable, Callable
from typing import Any

_store: dict[str, tuple[float, Any]] = {}
MAX_ENTRIES = 2000


async def cached(key: str, ttl: float, compute: Callable[[], Awaitable[Any]]) -> Any:
    now = time.monotonic()
    hit = _store.get(key)
    if hit and hit[0] > now:
        return hit[1]
    value = await compute()
    if len(_store) >= MAX_ENTRIES:  # simple bound: drop expired entries, then the oldest
        for k in [k for k, (exp, _) in _store.items() if exp <= now] or list(_store)[: MAX_ENTRIES // 4]:
            _store.pop(k, None)
    _store[key] = (now + ttl, value)
    return value


def invalidate(prefix: str = "") -> None:
    for key in [k for k in _store if k.startswith(prefix)]:
        _store.pop(key, None)
