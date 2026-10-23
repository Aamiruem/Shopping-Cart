"""Arvixa marketplace API (FastAPI).

Run locally:   uvicorn app.main:app --reload --port 5000     (from the backend folder)
          or:  python -m app.main  /  python app/main.py  /  python main.py (from backend/app)
API docs:      http://localhost:5000/docs
"""

import sys
from pathlib import Path

if not __package__:
    # Run as a file (`python main.py`, an IDE "Run" button, or uvicorn's reload worker on Windows, which
    # re-runs this file as __mp_main__): make the `app` package importable so the relative imports below work.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    __package__ = "app"  # noqa: A001 - tells Python which package "from .core ..." is relative to

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import ORJSONResponse
from fastapi.staticfiles import StaticFiles

from .core.config import get_settings
from .core.errors import register_error_handlers
from .db.mongo import close_mongo, connect_mongo
from .db.postgres import close_postgres, connect_postgres
from .routers import (
    addresses,
    ai,
    analytics,
    auth,
    cart,
    orders,
    payments,
    products,
    recommendations,
    seller,
    seller_import,
    seo,
    support,
    wishlist,
)
from .services.storage import LOCAL_URL_PREFIX

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    await connect_postgres()
    await connect_mongo()
    yield
    await close_mongo()
    await close_postgres()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Arvixa Marketplace API",
        version="2.0.0",
        description="Store, seller, analytics and ML endpoints. PostgreSQL for transactional data, MongoDB for catalog and events.",
        lifespan=lifespan,
        default_response_class=ORJSONResponse,  # orjson: several times faster JSON encoding
    )
    app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=5)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition"],
    )
    register_error_handlers(app)

    # Public catalog reads may be cached briefly by browsers and the CDN (never anything personal)
    @app.middleware("http")
    async def cache_headers(request: Request, call_next):
        response = await call_next(request)
        path = request.url.path
        public = path.startswith("/api/products") or path in ("/api/recommendations/trending", "/sitemap.xml", "/robots.txt")
        if request.method == "GET" and public and response.status_code == 200 and "authorization" not in request.headers:
            response.headers.setdefault("Cache-Control", "public, max-age=30, stale-while-revalidate=120")
        return response

    @app.get("/api/health", tags=["health"])
    async def health():
        return {"ok": True}

    for module in (
        auth,
        products,
        cart,
        wishlist,
        addresses,
        orders,
        payments,
        ai,
        seller_import,
        seller,
        analytics,
        recommendations,
        support,
        seo,
    ):
        app.include_router(module.router)

    # Locally stored product images (production uses S3 / CloudFront instead)
    Path(settings.upload_dir).mkdir(parents=True, exist_ok=True)
    app.mount(LOCAL_URL_PREFIX, StaticFiles(directory=settings.upload_dir), name="uploads")
    return app


app = create_app()

if __name__ == "__main__":
    # `python main.py` / `python app/main.py`: same as `uvicorn app.main:app --reload --port 5000` in backend/
    import os

    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "5000")),
        reload=os.getenv("RELOAD", "1") != "0",
        reload_dirs=[str(Path(__file__).resolve().parent)],
        app_dir=str(Path(__file__).resolve().parents[1]),
    )
