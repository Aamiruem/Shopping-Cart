"""Thin wrapper around the Claude API used by RAG, the agents and the listing writer."""

import json

import anthropic

from ..core.config import get_settings

_settings = get_settings()
_client = anthropic.Anthropic(api_key=_settings.anthropic_api_key) if _settings.llm_enabled else None

# Re-runs a request on Anthropic's recommended fallback model if the primary declines it.
FALLBACK_BETA = "server-side-fallback-2026-07-01"


def enabled() -> bool:
    return _client is not None


def cached_system(text: str) -> list[dict]:
    """A system prompt marked for prompt caching: a long, stable prompt (e.g. the analyst's database schema)
    is then billed at the cache-read rate on every later request."""
    return [{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}]


def create(effort: str = "low", max_tokens: int = 4096, **params):
    return _client.beta.messages.create(
        model=_settings.claude_model,
        max_tokens=max_tokens,
        thinking={"type": "adaptive"},
        output_config={"effort": effort},  # low for chat-style traffic; medium for multi-step SQL analysis
        betas=[FALLBACK_BETA],
        fallbacks="default",
        **params,
    )


def text_of(response) -> str:
    if response.stop_reason == "refusal":
        return "Sorry, I can't help with that request."
    return "".join(b.text for b in response.content if b.type == "text").strip()


def complete(system: str, prompt: str) -> str:
    return text_of(create(system=system, messages=[{"role": "user", "content": prompt}]))


class Declined(Exception):
    """Claude (and its fallback) declined the request."""


def structured(system: str, prompt: str, schema: dict, effort: str = "low") -> dict:
    """One request whose answer is guaranteed to be JSON matching `schema` (structured outputs)."""
    response = _client.beta.messages.create(
        model=_settings.claude_model,
        max_tokens=4096,
        thinking={"type": "adaptive"},
        output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        betas=[FALLBACK_BETA],
        fallbacks="default",
        system=system,
        messages=[{"role": "user", "content": prompt}],
    )
    if response.stop_reason == "refusal":
        raise Declined()
    return json.loads(next(b.text for b in response.content if b.type == "text"))
