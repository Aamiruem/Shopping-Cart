"""RAG step 2 - retrieval: hybrid search over the passages.

Two retrievers rank every passage, then Reciprocal Rank Fusion (RRF) merges the two rankings:

* sparse  - TF-IDF on words and word pairs: exact terms, brand names, product codes
* dense   - 128-dimensional semantic embeddings (latent semantic analysis: TF-IDF -> truncated SVD, then
            L2-normalised), so "refund" also finds passages about "returns" and "money back"

Everything runs on CPU in a few milliseconds with NumPy / scikit-learn; no vector database is needed at this
catalog size. For millions of passages, store the dense vectors in pgvector (PostgreSQL) or OpenSearch and
swap `_dense_scores` for a nearest-neighbour query.
"""

import numpy as np
from sklearn.decomposition import TruncatedSVD
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.preprocessing import normalize

DENSE_DIMS = 128
RRF_K = 60  # standard RRF constant: dampens the weight of the very top ranks


class HybridRetriever:
    def __init__(self, texts: list[str]):
        self.sparse = TfidfVectorizer(stop_words="english", ngram_range=(1, 2), sublinear_tf=True)
        self.sparse_matrix = self.sparse.fit_transform(texts)
        # Dense embeddings: SVD needs fewer components than terms/documents
        dims = max(1, min(DENSE_DIMS, self.sparse_matrix.shape[0] - 1, self.sparse_matrix.shape[1] - 1))
        self.svd = TruncatedSVD(n_components=dims, random_state=0) if dims > 1 else None
        self.dense_matrix = normalize(self.svd.fit_transform(self.sparse_matrix)) if self.svd else None

    def _sparse_scores(self, query: str) -> np.ndarray:
        return (self.sparse_matrix @ self.sparse.transform([query]).T).toarray().ravel()

    def _dense_scores(self, query: str) -> np.ndarray:
        if self.svd is None:
            return np.zeros(self.sparse_matrix.shape[0])
        q = normalize(self.svd.transform(self.sparse.transform([query])))
        return (self.dense_matrix @ q.T).ravel()

    def search(self, query: str, k: int = 4) -> list[tuple[int, float, float]]:
        """Top-k (passage index, fused RRF score, keyword score). Passages with no keyword or meaning overlap
        are dropped, so an unrelated question returns nothing rather than random passages."""
        sparse, dense = self._sparse_scores(query), self._dense_scores(query)
        fused = np.zeros_like(sparse)
        for scores in (sparse, dense):
            ranks = np.empty_like(scores)
            ranks[np.argsort(-scores)] = np.arange(1, len(scores) + 1)
            fused += 1.0 / (RRF_K + ranks)
        relevant = (sparse > 0) | (dense > 0.2)
        order = [i for i in np.argsort(-fused) if relevant[i]][:k]
        return [(int(i), float(fused[i]), float(sparse[i])) for i in order]
