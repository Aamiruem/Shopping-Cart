"""Product media storage (images, videos, audio): Amazon S3 in production, the local uploads/ folder in development."""

import asyncio
import uuid
from pathlib import Path

from ..core.config import get_settings
from ..core.errors import ApiError

LOCAL_URL_PREFIX = "/api/uploads"  # served by FastAPI; under /api so the dev proxy and nginx forward it
MB = 1024 * 1024


def _ftyp(content: bytes) -> bool:  # MP4 / M4A containers: "ftyp" box at byte 4
    return content[4:8] == b"ftyp"


# kind -> allowed content types (with file extension and a signature check, so a renamed .exe can't pose as media)
MEDIA = {
    "image": {
        "max": 5 * MB,
        "label": "JPEG, PNG or WebP image",
        "types": {
            "image/jpeg": (".jpg", lambda c: c.startswith(b"\xff\xd8\xff")),
            "image/png": (".png", lambda c: c.startswith(b"\x89PNG\r\n\x1a\n")),
            "image/webp": (".webp", lambda c: c.startswith(b"RIFF") and c[8:12] == b"WEBP"),
        },
    },
    "video": {
        "max": 50 * MB,
        "label": "MP4 or WebM video",
        "types": {
            "video/mp4": (".mp4", _ftyp),
            "video/webm": (".webm", lambda c: c.startswith(b"\x1a\x45\xdf\xa3")),
        },
    },
    "audio": {
        "max": 10 * MB,
        "label": "MP3, M4A, OGG or WAV audio",
        "types": {
            "audio/mpeg": (".mp3", lambda c: c.startswith(b"ID3") or c[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2")),
            "audio/mp4": (".m4a", _ftyp),
            "audio/x-m4a": (".m4a", _ftyp),
            "audio/ogg": (".ogg", lambda c: c.startswith(b"OggS")),
            "audio/wav": (".wav", lambda c: c.startswith(b"RIFF") and c[8:12] == b"WAVE"),
            "audio/x-wav": (".wav", lambda c: c.startswith(b"RIFF") and c[8:12] == b"WAVE"),
        },
    },
}
MAX_BYTES = MEDIA["image"]["max"]  # kept for callers that only handle images


def _validate(content: bytes, content_type: str, kind: str) -> str:
    spec = MEDIA.get(kind)
    if not spec:
        raise ApiError(400, "Unknown media type")
    if content_type not in spec["types"]:
        raise ApiError(400, f"Only {spec['label']} files are allowed")
    if len(content) > spec["max"]:
        raise ApiError(400, f"The file must be {spec['max'] // MB} MB or smaller")
    ext, looks_valid = spec["types"][content_type]
    if not looks_valid(content):
        raise ApiError(400, f"The file is not a valid {spec['label']}")
    return ext


def _put_s3(key: str, content: bytes, content_type: str) -> str:
    import boto3  # imported lazily: only needed when S3 is configured

    s = get_settings()
    boto3.client("s3", region_name=s.aws_region).put_object(
        Bucket=s.s3_bucket, Key=key, Body=content, ContentType=content_type, CacheControl="public, max-age=31536000, immutable"
    )
    base = s.s3_public_url.rstrip("/") or f"https://{s.s3_bucket}.s3.{s.aws_region}.amazonaws.com"
    return f"{base}/{key}"


async def save_media(content: bytes, content_type: str, seller_id: int, kind: str = "image") -> str:
    """Stores a product image / video / audio file and returns its public URL."""
    ext = _validate(content, content_type, kind)
    name = f"{uuid.uuid4().hex}{ext}"
    settings = get_settings()
    if settings.s3_bucket:
        key = f"media/products/{seller_id}/{name}"  # CloudFront serves the bucket under /media/*
        return await asyncio.to_thread(_put_s3, key, content, content_type)

    folder = Path(settings.upload_dir)
    folder.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread((folder / name).write_bytes, content)
    return f"{LOCAL_URL_PREFIX}/{name}"


async def save_product_image(content: bytes, content_type: str, seller_id: int) -> str:
    return await save_media(content, content_type, seller_id, "image")
