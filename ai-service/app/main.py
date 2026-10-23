"""Arvixa AI service (FastAPI): RAG, agents, ML, deep learning, statistics and data visualisation.

Run locally:   uvicorn app.main:app --port 8100     (from the ai-service folder)
API docs:      http://localhost:8100/docs

Layers (see README.md):  api/routes -> agents, rag, ml, dl, analytics, services -> llm, db -> core
"""

from fastapi import FastAPI

from .api.routes import agents, analytics, catalog, content
from .core.config import get_settings
from .llm import client as llm

app = FastAPI(
    title="Arvixa AI Service",
    version="2.0.0",
    description="Recommendations, RAG Q&A, shopping and data-analyst agents, statistics and neural-network forecasting.",
)


@app.get("/health", tags=["health"])
def health():
    settings = get_settings()
    return {"ok": True, "llm_enabled": llm.enabled(), "analytics_enabled": bool(settings.database_url), "model": settings.claude_model}


for module in (catalog, agents, analytics, content):
    app.include_router(module.router)
