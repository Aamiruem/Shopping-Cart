"""Arvixa AI service (FastAPI): RAG, agents, ML, deep learning, statistics and data visualisation.

Run locally:   uvicorn app.main:app --port 8100     (from the ai-service folder)
          or:  python -m app.main  /  python app/main.py  /  python main.py (from ai-service/app)
API docs:      http://localhost:8100/docs

Layers (see README.md):  api/routes -> agents, rag, ml, dl, analytics, services -> llm, db -> core
"""

import sys
from pathlib import Path


def _use_service_venv() -> None:
    """`python main.py` with a Python that lacks the service's packages (the system Python, or backend/.venv, which
    has no LangGraph or Anthropic SDK): run this file with ai-service/.venv's Python instead of failing on an import."""
    if __name__ != "__main__":
        return  # imported by uvicorn, or uvicorn's reload worker: already the right Python
    venv = Path(__file__).resolve().parents[1] / ".venv"
    python = venv / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    if not python.exists() or Path(sys.prefix).resolve() == venv.resolve():
        return
    import importlib.util

    if all(importlib.util.find_spec(name) for name in ("fastapi", "uvicorn", "langgraph", "anthropic")):
        return  # this Python has everything the service needs
    import subprocess

    print(f"This Python ({sys.executable}) doesn't have the AI service's packages; starting with {python}", file=sys.stderr)
    try:
        sys.exit(subprocess.call([str(python), str(Path(__file__).resolve()), *sys.argv[1:]]))
    except KeyboardInterrupt:  # Ctrl+C reaches the server too; just leave quietly
        sys.exit(130)


_use_service_venv()


def _use_signed_libpq() -> None:
    """Windows Smart App Control can block psycopg's bundled libpq ("DLL load failed while importing _psycopg: An
    Application Control policy has blocked this file"). PostgreSQL's own signed libpq.dll is allowed, so on Windows,
    when a local PostgreSQL is installed, use psycopg's pure-Python mode over that DLL (what start-dev.ps1 does).
    Must run before anything imports psycopg. Linux, Docker and an explicit PSYCOPG_IMPL are left alone."""
    import os

    if sys.platform != "win32" or os.environ.get("PSYCOPG_IMPL"):
        return
    roots = [Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "PostgreSQL"]
    found = sorted((p for root in roots if root.is_dir() for p in root.glob("*/bin/libpq.dll")), reverse=True)
    if not found:
        return
    os.environ["PATH"] = f"{found[0].parent}{os.pathsep}{os.environ.get('PATH', '')}"
    os.environ["PSYCOPG_IMPL"] = "python"  # inherited by uvicorn's reload worker too


_use_signed_libpq()

if not __package__:
    # Run as a file (`python main.py`, an IDE "Run" button, or uvicorn's reload worker on Windows, which
    # re-runs this file as __mp_main__): make the `app` package importable so the relative imports below work.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    __package__ = "app"  # noqa: A001 - tells Python which package "from .core ..." is relative to

from fastapi import FastAPI

from .api.routes import agents, analytics, catalog, content, intelligence
from .core.config import get_settings
from .llm import client as llm

app = FastAPI(
    title="Arvixa AI Service",
    version="2.0.0",
    description="Recommendations, semantic and photo search, RAG Q&A, LangGraph agents, review NLP and neural forecasting.",
)


@app.get("/health", tags=["health"])
def health():
    settings = get_settings()
    return {"ok": True, "llm_enabled": llm.enabled(), "analytics_enabled": bool(settings.postgres_dsn), "model": settings.claude_model}


for module in (catalog, agents, analytics, content, intelligence):
    app.include_router(module.router)


if __name__ == "__main__":
    # `python main.py` / `python app/main.py`: same as `uvicorn app.main:app --reload --port 8100` in ai-service/
    import os

    import uvicorn

    reload = os.getenv("RELOAD", "1") != "0"  # RELOAD=0 for a plain server
    uvicorn.run(
        "app.main:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8100")),
        reload=reload,
        reload_dirs=[str(Path(__file__).resolve().parent)] if reload else None,
        app_dir=str(Path(__file__).resolve().parents[1]),
    )
