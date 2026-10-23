import json
from pathlib import Path

from app.ml.recommender import Recommender
from app.rag import RagIndex

# Small fixed catalog so these tests do not depend on the store's demo data
SAMPLE = json.loads((Path(__file__).parent / "fixtures" / "products.json").read_text(encoding="utf-8"))
PRODUCTS = [{**p, "_id": str(i)} for i, p in enumerate(SAMPLE)]


def by_name(name):
    return next(p for p in PRODUCTS if p["name"] == name)


def test_similar_products_share_a_theme():
    rec = Recommender(PRODUCTS)
    names = [p["name"] for p in rec.similar(by_name("Wireless Headphones")["_id"], k=2)]
    assert "Bluetooth Speaker" in names


def test_cart_recommendations_exclude_cart_items():
    rec = Recommender(PRODUCTS)
    cart = [by_name("Ceramic Coffee Mug")["_id"]]
    results = rec.for_cart(cart, k=3)
    assert results[0]["name"] == "French Press Coffee Maker"
    assert all(p["_id"] not in cart for p in results)


def test_rag_retrieves_policy_passage():
    rag = RagIndex(PRODUCTS)
    top = rag.retrieve("how many days do I have to return an item?")[0]
    assert "Returns" in top["source"]


def test_rag_answers_without_llm():
    result = RagIndex(PRODUCTS).ask("price of the yoga mat")
    assert result["llm"] is False
    assert "899" in result["answer"]
