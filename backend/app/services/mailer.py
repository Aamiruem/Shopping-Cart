"""Outgoing email over SMTP (works with Gmail app passwords, Amazon SES SMTP, etc.).

Without SMTP_HOST the message is printed to the console so local development still works.
"""

import asyncio
import logging
import smtplib
import ssl
import sys
from email.message import EmailMessage

from ..core.config import get_settings

log = logging.getLogger("mail")


def _console(text: str) -> None:
    # Windows consoles may not be able to show characters like ₹ - replace them rather than crash
    encoding = sys.stdout.encoding or "utf-8"
    print(text.encode(encoding, "replace").decode(encoding), flush=True)


def is_configured() -> bool:
    return bool(get_settings().smtp_host)


def _send_sync(msg: EmailMessage) -> None:
    s = get_settings()
    if s.smtp_port == 465:
        with smtplib.SMTP_SSL(s.smtp_host, s.smtp_port, context=ssl.create_default_context(), timeout=15) as smtp:
            if s.smtp_user:
                smtp.login(s.smtp_user, s.smtp_pass)
            smtp.send_message(msg)
    else:
        with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=15) as smtp:
            smtp.starttls(context=ssl.create_default_context())
            if s.smtp_user:
                smtp.login(s.smtp_user, s.smtp_pass)
            smtp.send_message(msg)


async def send_mail(to: str, subject: str, text: str, html: str | None = None) -> bool:
    """Returns True when the email was actually sent."""
    if not is_configured():
        _console(f"\n[mail:dev] To: {to}\n[mail:dev] Subject: {subject}\n[mail:dev] {text}\n")
        return False
    msg = EmailMessage()
    msg["From"] = get_settings().mail_from
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    await asyncio.to_thread(_send_sync, msg)
    return True
