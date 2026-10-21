"""Thin wrapper around the Claude API used by RAG and the agent."""
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
