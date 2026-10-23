"""Retrieval-augmented generation: documents.py (chunking) -> retriever.py (hybrid search) -> pipeline.py."""

from .pipeline import RagIndex

__all__ = ["RagIndex"]
