"""Search by meaning: "something warm for winter" or "लाल जूते" finds products that share no words with the query."""

import numpy as np

from ..services.catalog import product_text
from . import embeddings

MIN_SIMILARITY = 0.3  # below this, results are noise and the shopper is better served by "no results"


class SemanticSearch:
    def __init__(self, products: list[dict]):
        self.products = products
        self.vectors = embeddings.embed([product_text(p) for p in products]) if products and embeddings.available() else None

    @property
    def ready(self) -> bool:
        return self.vectors is not None

    def search(self, query: str, k: int = 12, max_price: float | None = None) -> list[dict]:
        if not self.ready:
            return []
        scores = self.vectors @ embeddings.embed([query])[0]
        results = []
        for i in np.argsort(-scores):
            if scores[i] < MIN_SIMILARITY or len(results) >= k:
                break
            if max_price is None or self.products[i]["price"] <= max_price:
                results.append({**self.products[i], "score": round(float(scores[i]), 3)})
        return results
