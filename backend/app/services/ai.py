"""Calls to the AI service. It's an optional extra: when it's away, shopping carries on without these features."""

import logging

import httpx

from ..core.config import get_settings
from ..core.errors import ApiError
from ..db.postgres import get_pool

log = logging.getLogger("ai")

MAX_IMAGE_BYTES = 8 * 1024 * 1024
SEARCH_TIMEOUT = 2.5  # a shopper is waiting on these results
QUALITY_TIMEOUT = 8
REVIEW_LIMIT = 50


async def _post(path: str, timeout: float, **request) -> dict | list:
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(f"{get_settings().ai_service_url}{path}", **request)
    response.raise_for_status()
    return response.json()


async def semantic_search(query: str, k: int = 12) -> list[dict]:
    """Products that match the meaning of a search. Empty when the AI service is unavailable."""
    try:
        async with httpx.AsyncClient(timeout=SEARCH_TIMEOUT) as client:
            response = await client.get(f"{get_settings().ai_service_url}/search/semantic", params={"q": query, "k": k})
        response.raise_for_status()
    except httpx.HTTPError:
        return []
    return [{k: v for k, v in product.items() if k != "score"} for product in response.json()]


async def forward_image(path: str, filename: str, data: bytes) -> dict | list:
    try:
        return await _post(path, 30, files={"file": (filename, data)})
    except httpx.HTTPStatusError as err:
        if err.response.status_code == 400:
            raise ApiError(400, "This file isn't a readable image") from None
        raise ApiError(503, "Photo search isn't available right now") from None
    except httpx.HTTPError:
        raise ApiError(503, "Photo search isn't available right now") from None


async def check_photo(filename: str, data: bytes) -> dict | None:
    """Quality report for a seller's photo. None when the check can't run: an upload must never fail because of it."""
    try:
        return await _post("/vision/quality", QUALITY_TIMEOUT, files={"file": (filename, data)})
    except httpx.HTTPError:
        return None


async def summarize_reviews(product_id: str) -> dict:
    records = await get_pool().fetch(
        "SELECT rating, title, body FROM product_reviews WHERE product_id = $1 ORDER BY created_at DESC LIMIT $2", product_id, REVIEW_LIMIT
    )
    try:
        return await _post("/nlp/review-summary", 60, json={"reviews": [dict(r) for r in records]})
    except httpx.HTTPError:
        return {"ready": False}
