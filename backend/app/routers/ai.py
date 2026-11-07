"""/api/ai - proxies the separate AI service (RAG Q&A, shopping agent, content-based recommendations).

The shopper's token is passed through so the agent can act on the shopper's own cart.
"""

import httpx
from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.responses import JSONResponse

from ..core.cache import cached
from ..core.config import get_settings
from ..core.errors import ApiError
from ..core.rate_limit import rate_limit
from ..deps import get_current_user, require_seller
from ..services.ai import MAX_IMAGE_BYTES, forward_image, summarize_reviews

router = APIRouter(prefix="/api/ai", tags=["ai"])
vision_limiter = rate_limit(30, message="Too many photo searches. Please try again in a few minutes.")
SUMMARY_TTL = 3600


async def _forward(request: Request, path: str, method: str = "GET", body: bytes | None = None) -> JSONResponse:
    url = f"{get_settings().ai_service_url}{path}"
    headers = {"Content-Type": "application/json", "Authorization": request.headers.get("authorization", "")}
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.request(method, url, content=body, headers=headers)
        return JSONResponse(response.json(), status_code=response.status_code)
    except (httpx.HTTPError, ValueError):
        return JSONResponse({"error": "AI service is unavailable"}, status_code=502)


@router.get("/recommend/{product_id}")
async def recommend(product_id: str, request: Request, k: int = 4):
    return await _forward(request, f"/recommend/{product_id}?k={k}")


@router.post("/visual-search", dependencies=[Depends(vision_limiter)])
async def visual_search(file: UploadFile = File(...)):
    """Find products that look like a photo."""
    data = await file.read(MAX_IMAGE_BYTES + 1)
    if len(data) > MAX_IMAGE_BYTES:
        raise ApiError(413, "Please use an image under 8 MB")
    return await forward_image("/vision/search", file.filename or "photo", data)


@router.get("/review-summary/{product_id}")
async def review_summary(product_id: str):
    return await cached(f"reviews:summary:{product_id}", SUMMARY_TTL, lambda: summarize_reviews(product_id))


@router.post("/ask")
async def ask(request: Request):
    return await _forward(request, "/rag/ask", "POST", await request.body())


@router.post("/agent", dependencies=[Depends(get_current_user)])
async def agent(request: Request):
    return await _forward(request, "/agent/chat", "POST", await request.body())


@router.post("/listing", dependencies=[Depends(require_seller)])
async def listing(request: Request):
    """AI listing writer for sellers: SEO title, description, highlights, tags and meta description."""
    return await _forward(request, "/listing/generate", "POST", await request.body())
