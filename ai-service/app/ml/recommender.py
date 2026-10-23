"""Content-based product recommendations (ML).

Each product is turned into a TF-IDF vector of its name, description, category
and tags; similar products are found with cosine similarity. Swap in
collaborative filtering (e.g. implicit ALS on order history) once you have
enough orders.
"""

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

from ..services.catalog import product_text


class Recommender:
    def __init__(self, products: list[dict]):
        self.products = products
        self.index = {str(p["_id"]): i for i, p in enumerate(products)}
        self.vectorizer = TfidfVectorizer(stop_words="english", ngram_range=(1, 2))
        self.matrix = self.vectorizer.fit_transform([product_text(p) for p in products])

    def similar(self, product_id: str, k: int = 4) -> list[dict]:
        i = self.index.get(str(product_id))
        if i is None:
            return []
        scores = cosine_similarity(self.matrix[i], self.matrix).ravel()
        ranked = [j for j in scores.argsort()[::-1] if j != i][:k]
        return [{**self.products[j], "score": round(float(scores[j]), 3)} for j in ranked]

    def for_cart(self, product_ids: list[str], k: int = 4) -> list[dict]:
        """Recommend products similar to everything in the cart, excluding cart items."""
        rows = [self.index[str(pid)] for pid in product_ids if str(pid) in self.index]
        if not rows:
            return []
        scores = cosine_similarity(self.matrix[rows], self.matrix).mean(axis=0)
        ranked = [j for j in scores.argsort()[::-1] if j not in rows][:k]
        return [{**self.products[j], "score": round(float(scores[j]), 3)} for j in ranked]
