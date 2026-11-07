"""Delivery locations: Indian pincode lookup (India Post data) and turning a phone's GPS position into an address.

Both use free public services, so a failure must never block checkout: callers get `found: None` ("unknown")
and the shopper simply types their address. For high traffic, move to a licensed pincode dataset or courier API.
"""

import logging

import httpx

from ..core.cache import cached
from ..core.config import get_settings

log = logging.getLogger("location")

PINCODE_API = "https://api.postalpincode.in/pincode"
REVERSE_API = "https://nominatim.openstreetmap.org/reverse"
HEADERS = {"User-Agent": "ArvixaStore/1.0"}  # Nominatim's usage policy requires an identifying client name
DAY = 24 * 3600


def delivery_days(pincode: str) -> dict[str, int]:
    """Estimated days from the warehouse. Indian pincodes get more local digit by digit, so shared digits mean closer."""
    warehouse = get_settings().warehouse_pincode
    if not warehouse:
        return {"min": 3, "max": 7}
    if pincode[:2] == warehouse[:2]:
        return {"min": 1, "max": 2}
    if pincode[0] == warehouse[0]:
        return {"min": 2, "max": 4}
    return {"min": 4, "max": 7}


async def _fetch_pincode(pincode: str) -> dict | None:
    async with httpx.AsyncClient(timeout=6, headers=HEADERS) as client:
        response = await client.get(f"{PINCODE_API}/{pincode}")
        response.raise_for_status()
    result = response.json()[0]
    offices = result.get("PostOffice") or []
    if result.get("Status") != "Success" or not offices:
        return None
    first = offices[0]
    return {
        "city": first["District"].strip(),
        "state": first["State"].strip(),
        "areas": sorted({o["Name"].strip() for o in offices}),
        "deliverable": any(o.get("DeliveryStatus") == "Delivery" for o in offices),
    }


async def lookup_pincode(pincode: str) -> dict:
    try:
        place = await cached(f"pincode:{pincode}", 30 * DAY, lambda: _fetch_pincode(pincode))
    except (httpx.HTTPError, ValueError, KeyError, IndexError):
        log.warning("pincode lookup failed for %s", pincode)
        return {"pincode": pincode, "found": None, "days": delivery_days(pincode)}
    if place is None:
        return {"pincode": pincode, "found": False}
    return {"pincode": pincode, "found": True, **place, "days": delivery_days(pincode)}


async def _fetch_address(lat: float, lon: float) -> dict | None:
    params = {"format": "jsonv2", "lat": lat, "lon": lon, "addressdetails": 1, "accept-language": "en"}
    async with httpx.AsyncClient(timeout=6, headers=HEADERS) as client:
        response = await client.get(REVERSE_API, params=params)
        response.raise_for_status()
    address = response.json().get("address") or {}
    if address.get("country_code") != "in":
        return None
    street = [address.get(k) for k in ("house_number", "road", "neighbourhood", "suburb")]
    return {
        "line1": ", ".join(part for part in street if part),
        "city": address.get("city") or address.get("town") or address.get("state_district") or address.get("county") or "",
        "state": address.get("state", ""),
        "pincode": address.get("postcode", "").replace(" ", ""),
    }


async def reverse_geocode(lat: float, lon: float) -> dict | None:
    """The address at a position. Rounded to about 100 m, so nearby shoppers share a cached answer."""
    key = f"reverse:{lat:.3f},{lon:.3f}"
    try:
        return await cached(key, 7 * DAY, lambda: _fetch_address(round(lat, 3), round(lon, 3)))
    except (httpx.HTTPError, ValueError):
        log.warning("reverse geocoding failed")
        return None
