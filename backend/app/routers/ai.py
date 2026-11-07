"""/api/ai - proxies the separate AI service (RAG Q&A, shopping agent, recommendations, listing writer,
data analyst, statistical insights and the neural-network forecast).

The caller's token is passed through: the shopping agent acts only on the shopper's own cart, and the AI
service limits a seller's analytics to that seller's own sales.
"""

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from ..core.config import get_settings
from ..deps import get_current_user, require_seller

router = APIRouter(prefix="/api/ai", tags=["ai"])


async def _forward(request: Request, path: str, method: str = "GET", body: bytes | None = None, timeout: float = 60) -> JSONResponse:
    url = f"{get_settings().ai_service_url}{path}"
    headers = {"Content-Type": "application/json", "Authorization": request.headers.get("authorization", "")}
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
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


@router.get("/analyst/suggestions", dependencies=[Depends(require_seller)])
async def analyst_suggestions(request: Request):
    return await _forward(request, "/analyst/suggestions")


@router.post("/analyst", dependencies=[Depends(require_seller)])
async def analyst(request: Request):
    """Plain-English questions about the seller's sales -> SQL -> answer, table and chart."""
    return await _forward(request, "/analyst/ask", "POST", await request.body(), timeout=150)


@router.get("/insights", dependencies=[Depends(require_seller)])
async def insights(request: Request):
    """Statistical insights: confidence intervals, hypothesis tests, regression, correlation."""
    return await _forward(request, f"/analytics/insights?{request.url.query}")


@router.get("/forecast", dependencies=[Depends(require_seller)])
async def forecast(request: Request):
    """Neural-network forecast of units sold over the next 14 days."""
    return await _forward(request, f"/analytics/forecast?{request.url.query}")
