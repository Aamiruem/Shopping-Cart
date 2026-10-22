"""Thin wrapper around the Claude API used by RAG, the agent and the listing writer."""
import json

import anthropic

from .config import CLAUDE_MODEL, LLM_ENABLED

_client = anthropic.Anthropic() if LLM_ENABLED else None

# Re-runs a request on Anthropic's recommended fallback model if the primary declines it.
FALLBACK_BETA = "server-side-fallback-2026-07-01"


def enabled() -> bool:
    return _client is not None


def create(**params):
    return _client.beta.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=4096,
        thinking={"type": "adaptive"},
        output_config={"effort": "low"},  # chat-style traffic; raise for harder tasks
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
        model=CLAUDE_MODEL,
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
