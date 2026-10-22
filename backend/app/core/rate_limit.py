"""Small in-memory rate limiter (per client IP + route) used as a FastAPI dependency.

Good enough for a single instance; use a Redis-backed limiter (or AWS WAF rate rules) when running several replicas.
"""

import math
import time

from fastapi import Request

from .errors import ApiError

_ALL_COUNTERS: list[dict] = []


def reset_all() -> None:
    """Forget every counter (used by the test suite between tests)."""
    for hits in _ALL_COUNTERS:
        hits.clear()


def rate_limit(max_hits: int = 20, window_seconds: int = 15 * 60, message: str = "Too many attempts. Please try again later."):
    hits: dict[str, tuple[int, float]] = {}
    _ALL_COUNTERS.append(hits)

    async def dependency(request: Request) -> None:
        ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (request.client.host if request.client else "?")
        key = f"{ip}:{request.url.path}"
        now = time.time()
        count, reset_at = hits.get(key, (0, now + window_seconds))
        if reset_at <= now:
            count, reset_at = 0, now + window_seconds
        count += 1
        hits[key] = (count, reset_at)
        if count > max_hits:
            raise ApiError(429, message, headers={"Retry-After": str(math.ceil(reset_at - now))})

    return dependency
