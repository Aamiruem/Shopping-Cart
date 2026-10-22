"""/api/ai - proxies the separate AI service (RAG Q&A, shopping agent, content-based recommendations).

The shopper's token is passed through so the agent can act on the shopper's own cart.
"""

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from ..core.config import get_settings
from ..deps import get_current_user, require_seller

router = APIRouter(prefix="/api/ai", tags=["ai"])


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
