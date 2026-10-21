"""Input rules shared by auth, profile and address endpoints.

Keep in sync with frontend/src/utils/validation.js - the browser checks first, the server re-checks everything.
"""

import asyncio
import re

import dns.asyncresolver
import dns.exception
import dns.resolver

EMAIL_RE = re.compile(r"^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$", re.I)
PHONE_RE = re.compile(r"^[6-9]\d{9}$")  # Indian 10-digit mobile number
PINCODE_RE = re.compile(r"^\d{6}$")
PASSWORD_MIN = 8


def normalize_email(email: str | None) -> str:
    return str(email or "").strip().lower()


def email_error(email: str) -> str | None:
    if not email:
        return "Please enter your email address"
    if len(email) > 254 or not EMAIL_RE.match(email) or ".." in email:
        return "Please enter a valid email address"
    return None


async def email_domain_error(email: str) -> str | None:
    """Rejects domains that cannot receive mail (typos like "gmail.con").

    If DNS itself is unavailable we let the address through rather than block signups.
    """
    domain = email.split("@")[1]
    message = f"“{domain}” can’t receive email. Please check the address."
    try:
        answer = await asyncio.wait_for(dns.asyncresolver.resolve(domain, "MX"), timeout=3)
        return None if len(answer) else message
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer, dns.resolver.NoNameservers):
        return message
    except (TimeoutError, dns.exception.DNSException):
        return None


def phone_error(phone: str | None) -> str | None:
    if not phone:
        return None  # optional
    return None if PHONE_RE.match(phone) else "Please enter a valid 10-digit mobile number starting with 6, 7, 8 or 9"


def password_error(password) -> str | None:
    if not isinstance(password, str) or len(password) < PASSWORD_MIN:
        return f"Password must be at least {PASSWORD_MIN} characters"
    if len(password.encode()) > 72:
        return "Password must be at most 72 characters"  # bcrypt limit
    if not re.search(r"[a-z]", password, re.I) or not re.search(r"\d", password):
        return "Password must contain at least one letter and one number"
    return None


def name_error(name: str) -> str | None:
    if len(name) < 2:
        return "Please enter your full name"
    if len(name) > 100:
        return "Name is too long"
    return None


def first_error(*errors: str | None) -> str | None:
    return next((e for e in errors if e), None)
