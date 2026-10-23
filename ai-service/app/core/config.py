"""Settings, read once from environment variables (and ai-service/.env in development)."""

import os
import re
from dataclasses import dataclass
from functools import lru_cache

from dotenv import load_dotenv

load_dotenv()

IDENTIFIER = re.compile(r"[a-z_][a-z0-9_]{0,62}")


@dataclass(frozen=True)
class Settings:
    # Arvixa backend API (catalog for RAG / recommendations, carts for the shopping agent)
    backend_url: str = os.getenv("BACKEND_URL", "http://localhost:5000")

    # Claude (RAG answers, shopping agent, data analyst, listing writer). Unset = template / retrieval fallbacks.
    anthropic_api_key: str = os.getenv("ANTHROPIC_API_KEY", "")
    claude_model: str = os.getenv("CLAUDE_MODEL", "claude-opus-5-5")

    # PostgreSQL: same database as the backend. Analytics only ever reads the read-only reporting views in
    # "<PG_SCHEMA>_analytics" (created by backend/app/db/schema.sql), never the raw tables.
    database_url: str = os.getenv("DATABASE_URL", "")
    pg_schema: str = os.getenv("PG_SCHEMA", "")
    timezone: str = os.getenv("TIMEZONE", "Asia/Kolkata")

    # Same secret the backend signs login tokens with, so the AI service can check who is calling
    jwt_secret: str = os.getenv("JWT_SECRET", "dev-secret")

    # Data analyst safety limits
    query_timeout_ms: int = int(os.getenv("ANALYST_QUERY_TIMEOUT_MS", "5000"))
    max_rows: int = int(os.getenv("ANALYST_MAX_ROWS", "500"))

    @property
    def llm_enabled(self) -> bool:
        return bool(self.anthropic_api_key)

    @property
    def analytics_schema(self) -> str:
        name = f"{self.pg_schema}_analytics" if self.pg_schema else "analytics"
        if not IDENTIFIER.fullmatch(name):
            raise ValueError(f"Invalid analytics schema name {name!r}")
        return name


@lru_cache
def get_settings() -> Settings:
    return Settings()
