"""Payment signature checks and media upload validation (no database needed)."""

import hashlib
import hmac

import pytest

from app.core.config import get_settings
from app.core.errors import ApiError
from app.services import razorpay
from app.services.storage import _validate


@pytest.fixture
def secrets(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "razorpay_key_id", "rzp_test_key")
    monkeypatch.setattr(settings, "razorpay_key_secret", "key-secret")
    monkeypatch.setattr(settings, "razorpay_webhook_secret", "hook-secret")
    return settings


def sign(secret: str, message: bytes) -> str:
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def test_checkout_signature(secrets):
    good = sign("key-secret", b"order_1|pay_1")
    assert razorpay.verify_payment_signature("order_1", "pay_1", good)
    assert not razorpay.verify_payment_signature("order_1", "pay_2", good)  # signature for another payment
    assert not razorpay.verify_payment_signature("order_1", "pay_1", "")


def test_webhook_signature(secrets):
    body = b'{"event":"payment.captured"}'
    assert razorpay.verify_webhook_signature(body, sign("hook-secret", body))
    assert not razorpay.verify_webhook_signature(body, sign("key-secret", body))  # signed with the wrong secret


def test_not_configured_means_no_signature_passes(monkeypatch):
    monkeypatch.setattr(get_settings(), "razorpay_key_secret", "")
    assert not razorpay.is_configured()
    assert not razorpay.verify_payment_signature("o", "p", sign("", b"o|p"))


@pytest.mark.parametrize(
    ("kind", "content_type", "content", "ext"),
    [
        ("image", "image/png", b"\x89PNG\r\n\x1a\n" + b"0" * 20, ".png"),
        ("image", "image/webp", b"RIFF\x00\x00\x00\x00WEBPVP8 ", ".webp"),
        ("video", "video/mp4", b"\x00\x00\x00\x18ftypmp42" + b"0" * 20, ".mp4"),
        ("video", "video/webm", b"\x1a\x45\xdf\xa3" + b"0" * 20, ".webm"),
        ("audio", "audio/mpeg", b"ID3\x04" + b"0" * 20, ".mp3"),
        ("audio", "audio/wav", b"RIFF\x00\x00\x00\x00WAVEfmt ", ".wav"),
    ],
)
def test_media_accepted(kind, content_type, content, ext):
    assert _validate(content, content_type, kind) == ext


@pytest.mark.parametrize(
    ("kind", "content_type", "content", "message"),
    [
        ("image", "image/png", b"MZ\x90\x00 not a png", "not a valid"),  # renamed .exe
        ("video", "image/png", b"\x89PNG\r\n\x1a\n", "Only MP4 or WebM"),  # wrong kind
        ("audio", "audio/wav", b"RIFF\x00\x00\x00\x00AVI LIST", "not a valid"),  # a video posing as WAV
    ],
)
def test_media_rejected(kind, content_type, content, message):
    with pytest.raises(ApiError) as err:
        _validate(content, content_type, kind)
    assert message in err.value.message


def test_media_too_big():
    with pytest.raises(ApiError) as err:
        _validate(b"\x89PNG\r\n\x1a\n" + b"0" * (15 * 1024 * 1024), "image/png", "image")
    assert "15 MB" in err.value.message


def test_photos_are_optimised_to_webp():
    import io

    from PIL import Image

    from app.services.storage import optimise_image

    raw = io.BytesIO()
    Image.new("RGB", (4000, 3000), (200, 30, 30)).save(raw, "JPEG", quality=95)
    out = optimise_image(raw.getvalue())
    img = Image.open(io.BytesIO(out))
    assert img.format == "WEBP" and img.size == (1600, 1200)
    assert len(out) < len(raw.getvalue())
    with pytest.raises(ApiError):
        optimise_image(b"\xff\xd8\xff not really a jpeg")


def test_bank_details_encrypted_at_rest():
    from app.services.crypto import decrypt, encrypt

    stored = encrypt("123456789012")
    assert stored.startswith("enc:") and "123456789012" not in stored
    assert decrypt(stored) == "123456789012"
    assert decrypt("987654321") == "987654321"  # rows saved before encryption still read
    assert encrypt(None) is None and decrypt(None) is None
