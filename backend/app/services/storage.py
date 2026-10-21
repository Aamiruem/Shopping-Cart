"""Product image storage: Amazon S3 in production, the local uploads/ folder in development."""

import asyncio
import uuid
from pathlib import Path

from ..core.config import get_settings
from ..core.errors import ApiError

ALLOWED_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
MAX_BYTES = 5 * 1024 * 1024
LOCAL_URL_PREFIX = "/api/uploads"  # served by FastAPI; under /api so the dev proxy and nginx forward it

# File signatures, so a renamed .exe can't pose as an image
_MAGIC = {"image/jpeg": [b"\xff\xd8\xff"], "image/png": [b"\x89PNG\r\n\x1a\n"], "image/webp": [b"RIFF"]}


def _validate(content: bytes, content_type: str) -> str:
    if content_type not in ALLOWED_TYPES:
        raise ApiError(400, "Only JPEG, PNG or WebP images are allowed")
    if len(content) > MAX_BYTES:
        raise ApiError(400, "Image must be 5 MB or smaller")
    if not any(content.startswith(sig) for sig in _MAGIC[content_type]):
        raise ApiError(400, "The file is not a valid image")
    return ALLOWED_TYPES[content_type]


def _put_s3(key: str, content: bytes, content_type: str) -> str:
    import boto3  # imported lazily: only needed when S3 is configured

    s = get_settings()
    boto3.client("s3", region_name=s.aws_region).put_object(
        Bucket=s.s3_bucket, Key=key, Body=content, ContentType=content_type, CacheControl="public, max-age=31536000, immutable"
    )
    base = s.s3_public_url.rstrip("/") or f"https://{s.s3_bucket}.s3.{s.aws_region}.amazonaws.com"
    return f"{base}/{key}"


async def save_product_image(content: bytes, content_type: str, seller_id: int) -> str:
    """Stores the image and returns its public URL."""
    ext = _validate(content, content_type)
    name = f"{uuid.uuid4().hex}{ext}"
    settings = get_settings()
    if settings.s3_bucket:
        key = f"media/products/{seller_id}/{name}"  # CloudFront serves the bucket under /media/*
        return await asyncio.to_thread(_put_s3, key, content, content_type)

    folder = Path(settings.upload_dir)
    folder.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread((folder / name).write_bytes, content)
    return f"{LOCAL_URL_PREFIX}/{name}"
