"""SMS and WhatsApp messages through Twilio's REST API (no SDK needed).

Without Twilio credentials, messages are printed to the console and callers return the code to the
frontend in development, so OTP flows can be tested end to end.
"""

import logging

import httpx

from ..core.config import get_settings
from ..core.errors import ApiError

log = logging.getLogger("messaging")


def is_configured(channel: str) -> bool:
    s = get_settings()
    sender = s.twilio_whatsapp_from if channel == "whatsapp" else s.twilio_sms_from
    return bool(s.twilio_account_sid and s.twilio_auth_token and sender)


def _e164(phone: str) -> str:
    """Indian 10-digit mobile -> +91XXXXXXXXXX (numbers already in +CC form are kept)."""
    digits = phone.strip()
    return digits if digits.startswith("+") else f"+91{digits[-10:]}"


async def send(channel: str, phone: str, text: str) -> None:
    """channel: 'sms' or 'whatsapp'."""
    s = get_settings()
    if not is_configured(channel):
        log.warning("[%s to %s] %s (Twilio not configured - not sent)", channel, phone, text)
        return
    to = _e164(phone)
    sender = s.twilio_sms_from
    if channel == "whatsapp":
        to, sender = f"whatsapp:{to}", s.twilio_whatsapp_from
    url = f"https://api.twilio.com/2010-04-01/Accounts/{s.twilio_account_sid}/Messages.json"
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            res = await client.post(url, auth=(s.twilio_account_sid, s.twilio_auth_token), data={"To": to, "From": sender, "Body": text})
    except httpx.HTTPError:
        raise ApiError(502, "We couldn't send the code right now. Please try again in a minute.") from None
    if res.status_code >= 400:
        log.error("twilio %s failed: %s %s", channel, res.status_code, res.text[:300])
        raise ApiError(
            502, f"We couldn't send the {'WhatsApp message' if channel == 'whatsapp' else 'SMS'}. Please check the number and try again."
        )
