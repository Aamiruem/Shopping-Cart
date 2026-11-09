"""/api/events - behaviour signals the storefront sends.

Product page views are already recorded when GET /api/products/{id} is served (services/events.py), so the view event
the storefront also sends (for the Vercel store API, which records views this way) is acknowledged without a second count.
"""

from fastapi import APIRouter, Response

router = APIRouter(prefix="/api/events", tags=["events"])


@router.post("/view", status_code=204)
async def view() -> Response:
    return Response(status_code=204)
