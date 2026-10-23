"""Holds the trained catalog models (recommender + RAG index), built lazily from the live catalog."""

from ..rag import RagIndex
from ..services.catalog import get_products
from .recommender import Recommender

_state: dict = {}


def models(refresh: bool = False) -> tuple[Recommender, RagIndex]:
    if refresh or "recommender" not in _state:
        products = get_products(force=refresh)
        _state["recommender"] = Recommender(products)
        _state["rag"] = RagIndex(products)
    return _state["recommender"], _state["rag"]
