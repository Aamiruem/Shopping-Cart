"""Machine learning on the catalog (content-based recommendations) and RAG product / policy Q&A."""

from fastapi import APIRouter

from ...ml.registry import models
from ..schemas import CartIds, Question

router = APIRouter(tags=["catalog"])


@router.post("/reindex")
def reindex():
    recommender, rag = models(refresh=True)
    return {"products": len(recommender.products), "passages": len(rag.passages)}


@router.get("/recommend/{product_id}")
def recommend(product_id: str, k: int = 4):
    recommender, _ = models()
    return recommender.similar(product_id, k)


@router.post("/recommend/cart")
def recommend_for_cart(body: CartIds):
    recommender, _ = models()
    return recommender.for_cart(body.product_ids, body.k)


@router.post("/rag/ask")
def ask(body: Question):
    _, rag = models()
    return rag.ask(body.question)
