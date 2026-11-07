"""Hugging Face sentence embeddings. The multilingual model lets shoppers search in Hindi and English alike."""

import os
from functools import lru_cache

import numpy as np

from ..core.optional import deep_models_enabled

MODEL_NAME = os.getenv("EMBEDDING_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
BATCH_SIZE = 64


@lru_cache
def _encoder():
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(MODEL_NAME, device="cpu")


def available() -> bool:
    return deep_models_enabled()


def embed(texts: list[str]) -> np.ndarray:
    """Unit-length vectors, so a dot product is cosine similarity."""
    return np.asarray(_encoder().encode(texts, batch_size=BATCH_SIZE, normalize_embeddings=True, show_progress_bar=False))
