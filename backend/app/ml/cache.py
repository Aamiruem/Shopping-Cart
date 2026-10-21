"""Tiny async TTL cache for trained models and expensive analytics results.

Training runs in a worker thread (scikit-learn is CPU-bound) and concurrent requests for the
same key wait for one computation instead of training the model several times.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any

_values: dict[str, tuple[float, Any]] = {}
_locks: dict[str, asyncio.Lock] = {}


async def cached(key: str, ttl_seconds: float, compute: Callable[[], Awaitable[Any]]) -> Any:
    hit = _values.get(key)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:
        hit = _values.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        value = await compute()
        _values[key] = (time.monotonic() + ttl_seconds, value)
        return value


def clear() -> int:
    count = len(_values)
    _values.clear()
    return count
