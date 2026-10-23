"""Read-only PostgreSQL sessions for analytics (psycopg 3), returning pandas DataFrames.

Every session is locked down before any query runs:
  * READ ONLY transaction      - INSERT / UPDATE / DELETE / DDL fail inside the database itself
  * statement_timeout          - a runaway query is cancelled (ANALYST_QUERY_TIMEOUT_MS)
  * search_path = the reporting views schema only - raw tables (users, payments...) are not even in scope
  * arvixa.seller_id           - the views then show only that seller's sales (unset = whole marketplace)
"""

from collections.abc import Iterator
from contextlib import contextmanager
from decimal import Decimal

import pandas as pd
import psycopg
from fastapi import HTTPException

from ..core.config import get_settings


@contextmanager
def analytics_session(seller_id: int | None) -> Iterator[psycopg.Connection]:
    settings = get_settings()
    if not settings.database_url:
        raise HTTPException(503, "Analytics needs DATABASE_URL (the backend's PostgreSQL) in ai-service/.env")
    try:
        conn = psycopg.connect(settings.database_url, connect_timeout=5, options=f"-c search_path={settings.analytics_schema}")
    except psycopg.OperationalError:
        raise HTTPException(503, "Can't reach the analytics database right now") from None
    with conn, conn.transaction():
        conn.execute("SET TRANSACTION READ ONLY")
        conn.execute("SELECT set_config('statement_timeout', %s, true)", (str(settings.query_timeout_ms),))
        conn.execute("SELECT set_config('TimeZone', %s, true)", (settings.timezone,))
        conn.execute("SELECT set_config('arvixa.seller_id', %s, true)", (str(seller_id) if seller_id else "",))
        yield conn


def _plain(value):
    # NUMERIC arrives as Decimal; analysis and JSON want floats
    return float(value) if isinstance(value, Decimal) else value


def query_df(conn: psycopg.Connection, sql: str, params: dict | None = None, max_rows: int | None = None) -> tuple[pd.DataFrame, bool]:
    """Runs one query; returns (DataFrame, truncated). At most `max_rows` rows are fetched."""
    with conn.cursor() as cur:
        cur.execute(sql, params or {})
        if cur.description is None:
            return pd.DataFrame(), False
        columns = [c.name for c in cur.description]
        rows = cur.fetchmany(max_rows + 1) if max_rows else cur.fetchall()
    truncated = bool(max_rows) and len(rows) > max_rows
    rows = rows[:max_rows] if max_rows else rows
    return pd.DataFrame([[_plain(v) for v in row] for row in rows], columns=columns), truncated
