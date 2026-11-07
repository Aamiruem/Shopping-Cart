"""Holds the catalog models, built lazily from the live catalog (the first request after a deploy is slower)."""

from ..cv.vision import VisualIndex
from ..rag import RagIndex
from ..services.catalog import get_products
from .recommender import Recommender
from .semantic_search import SemanticSearch

_state: dict = {}


def models(refresh: bool = False) -> tuple[Recommender, RagIndex]:
    if refresh or "recommender" not in _state:
        products = get_products(force=refresh)
        _state["recommender"] = Recommender(products)
        _state["rag"] = RagIndex(products)
        _state.pop("semantic", None)
        _state.pop("visual", None)
    return _state["recommender"], _state["rag"]


def semantic_index() -> SemanticSearch:
    if "semantic" not in _state:
        _state["semantic"] = SemanticSearch(get_products())
    return _state["semantic"]


def visual_index() -> VisualIndex:
    if "visual" not in _state:
        _state["visual"] = VisualIndex(get_products())
    return _state["visual"]
