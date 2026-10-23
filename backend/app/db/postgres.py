"""PostgreSQL (users, sellers, addresses, orders, support tickets) via an asyncpg pool."""

import asyncio
import json
import re
from pathlib import Path

import asyncpg

from ..core.config import get_settings

SCHEMA_FILE = Path(__file__).with_name("schema.sql")
SCHEMA_NAME = re.compile(r"[a-z_][a-z0-9_]{0,62}")
_pool: asyncpg.Pool | None = None


async def _setup_connection(conn: asyncpg.Connection) -> None:
    # Return json / jsonb columns (e.g. json_agg) as Python objects
    for type_name in ("json", "jsonb"):
        await conn.set_type_codec(type_name, encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def _ensure_schema(dsn: str, schema: str) -> None:
    if not SCHEMA_NAME.fullmatch(schema):
        raise ValueError(f"PG_SCHEMA must be a simple identifier, got {schema!r}")
    conn = await asyncpg.connect(dsn, timeout=15)
    try:
        await conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
    finally:
        await conn.close()


async def connect_postgres(run_schema: bool = True) -> asyncpg.Pool:
    global _pool
    settings = get_settings()
    server_settings = {}
    if settings.pg_schema:
        await _ensure_schema(settings.postgres_dsn, settings.pg_schema)
        server_settings["search_path"] = settings.pg_schema  # every table lives in (and is read from) this schema
    _pool = await asyncpg.create_pool(
        settings.postgres_dsn,
        min_size=1,
        max_size=10,
        timeout=15,
        statement_cache_size=settings.pg_statement_cache_size,
        init=_setup_connection,
        server_settings=server_settings,
    )
    if run_schema:
        if not SCHEMA_NAME.fullmatch(settings.analytics_schema):
            raise ValueError(f"Invalid analytics schema name {settings.analytics_schema!r}")
        async with _pool.acquire() as conn:
            await conn.execute(SCHEMA_FILE.read_text(encoding="utf-8").replace("{analytics}", settings.analytics_schema))
    return _pool


async def close_postgres() -> None:
    global _pool
    if _pool:
        try:
            await asyncio.wait_for(_pool.close(), timeout=5)
        except TimeoutError:
            _pool.terminate()
        _pool = None


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("PostgreSQL pool is not initialised")
    return _pool


def row(record: asyncpg.Record | None) -> dict | None:
    return dict(record) if record else None


def rows(records: list[asyncpg.Record]) -> list[dict]:
    return [dict(r) for r in records]
