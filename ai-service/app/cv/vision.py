"""Computer vision: search the catalog with a photo (CLIP) and check the quality of seller photos.

CLIP places images in a shared vector space, so a shopper's photo of a shoe sits close to product photos of similar
shoes. The quality check needs no model at all: sharpness, resolution and exposure come straight from the pixels.
"""

import io
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import httpx
import numpy as np
from PIL import Image, UnidentifiedImageError

from ..core.config import get_settings
from ..core.optional import deep_models_enabled

log = logging.getLogger("vision")

CLIP_MODEL = os.getenv("CLIP_MODEL", "openai/clip-vit-base-patch32")
DOWNLOAD_WORKERS = 8
ENCODE_BATCH = 32
MIN_MATCH = 0.5

MIN_SIDE = 500  # below this, photos look soft on phone screens
BLUR_LIMIT = 60  # variance of the Laplacian; lower means fewer sharp edges
DARK_LIMIT, BRIGHT_LIMIT = 40, 245


class InvalidImage(ValueError):
    """The upload isn't a readable image."""


def _open(data: bytes) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except (UnidentifiedImageError, OSError) as err:
        raise InvalidImage("This file isn't a readable image") from err
    return image.convert("RGB")


def quality_report(data: bytes) -> dict:
    """Plain-language problems with a product photo, for the seller to fix before publishing."""
    image = _open(data)
    width, height = image.size
    gray = np.asarray(image.convert("L"), dtype=np.float32)
    laplacian = 4 * gray[1:-1, 1:-1] - gray[:-2, 1:-1] - gray[2:, 1:-1] - gray[1:-1, :-2] - gray[1:-1, 2:]
    sharpness = float(laplacian.var())
    brightness = float(gray.mean())

    issues = []
    if min(width, height) < MIN_SIDE:
        issues.append(f"Low resolution ({width}×{height}). Use a photo at least {MIN_SIDE} px on its shortest side.")
    if sharpness < BLUR_LIMIT:
        issues.append("The photo looks blurry. Retake it with a steady hand and good light.")
    if brightness < DARK_LIMIT:
        issues.append("The photo is too dark.")
    elif brightness > BRIGHT_LIMIT:
        issues.append("The photo is overexposed.")
    return {"width": width, "height": height, "sharpness": round(sharpness, 1), "brightness": round(brightness, 1), "issues": issues}


@lru_cache
def _clip():
    from transformers import CLIPModel, CLIPProcessor

    return CLIPModel.from_pretrained(CLIP_MODEL).eval(), CLIPProcessor.from_pretrained(CLIP_MODEL)


def _encode(images: list[Image.Image]) -> np.ndarray:
    """Unit-length image vectors, so a dot product is cosine similarity."""
    import torch

    model, processor = _clip()
    batches = []
    for start in range(0, len(images), ENCODE_BATCH):
        inputs = processor(images=images[start : start + ENCODE_BATCH], return_tensors="pt")
        with torch.no_grad():
            features = model.get_image_features(**inputs)
        features = getattr(features, "pooler_output", features)
        batches.append(torch.nn.functional.normalize(features, dim=-1).numpy())
    return np.vstack(batches)


def _absolute(url: str) -> str:
    return url if url.startswith("http") else f"{get_settings().storefront_url.rstrip('/')}{url}"


def _download(product: dict) -> Image.Image | None:
    try:
        response = httpx.get(_absolute(product["image"]), timeout=15, follow_redirects=True)
        response.raise_for_status()
        return _open(response.content)
    except (httpx.HTTPError, InvalidImage, KeyError):
        return None  # a missing photo only means this product can't be found by photo


class VisualIndex:
    def __init__(self, products: list[dict], loader=_download):
        self.products: list[dict] = []
        self.vectors = None
        if not deep_models_enabled():
            return
        with ThreadPoolExecutor(DOWNLOAD_WORKERS) as pool:
            images = list(pool.map(loader, products))
        found = [(p, image) for p, image in zip(products, images, strict=True) if image is not None]
        if not found:
            log.warning("no product photos could be downloaded; visual search stays off")
            return
        self.products = [p for p, _ in found]
        self.vectors = _encode([image for _, image in found])

    @property
    def ready(self) -> bool:
        return self.vectors is not None

    def search(self, data: bytes, k: int = 12) -> list[dict]:
        if not self.ready:
            return []
        scores = self.vectors @ _encode([_open(data)])[0]
        ranked = [i for i in np.argsort(-scores)[:k] if scores[i] >= MIN_MATCH]
        return [{**self.products[i], "score": round(float(scores[i]), 3)} for i in ranked]
