"""Loads the product catalog from the Veyra backend API, with a short cache."""
import time

import httpx

from .config import BACKEND_URL

_cache = {"products": [], "loaded_at": 0.0}
TTL_SECONDS = 300


def get_products(force: bool = False) -> list[dict]:
    if force or time.time() - _cache["loaded_at"] > TTL_SECONDS:
        response = httpx.get(f"{BACKEND_URL}/api/products", timeout=10)
        response.raise_for_status()
        _cache["products"] = response.json()
        _cache["loaded_at"] = time.time()
    return _cache["products"]


def product_text(p: dict) -> str:
    """The text the ML models see for one product."""
    tags = " ".join(p.get("tags", []))
    return f"{p['name']}. {p.get('description', '')} Category: {p.get('category', '')}. Tags: {tags}."
