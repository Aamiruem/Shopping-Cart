"""/api/location - pincode check for delivery estimates and address autofill."""

from fastapi import APIRouter, Depends, Query

from ..core.errors import ApiError
from ..core.rate_limit import rate_limit
from ..services import location
from ..services.validation import PINCODE_RE

router = APIRouter(prefix="/api/location", tags=["location"])
lookup_limiter = rate_limit(120, message="Too many location checks. Please try again in a few minutes.")


@router.get("/pincode/{pincode}", dependencies=[Depends(lookup_limiter)])
async def pincode(pincode: str):
    if not PINCODE_RE.match(pincode):
        raise ApiError(400, "Please enter a valid 6-digit pincode")
    return await location.lookup_pincode(pincode)


@router.get("/reverse", dependencies=[Depends(lookup_limiter)])
async def reverse(lat: float = Query(ge=6, le=38), lon: float = Query(ge=68, le=98)):
    """Address for "Use my location". The bounds are India's, so the free geocoder isn't used for anything else."""
    address = await location.reverse_geocode(lat, lon)
    if not address:
        raise ApiError(404, "We couldn't find an address here. Please type it in.")
    return address
