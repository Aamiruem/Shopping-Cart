"""Heavy ML libraries are optional (requirements-ml.txt): without them each feature falls back to a lighter method."""

import importlib.util
import os


def has(library: str) -> bool:
    return importlib.util.find_spec(library) is not None


def deep_models_enabled() -> bool:
    """False on small machines: DEEP_MODELS=0 keeps downloaded models out of memory even when the libraries exist."""
    return os.getenv("DEEP_MODELS", "1") != "0" and has("sentence_transformers")
