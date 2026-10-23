"""Runs the agent loop against a scripted fake model (no API key needed)."""

from types import SimpleNamespace as NS

from app.agents import shopping as agent_module
from app.agents.shopping import ShoppingAgent
from app.ml.recommender import Recommender
from app.rag import RagIndex
from tests.test_ml import PRODUCTS


def test_agent_calls_tool_then_answers(monkeypatch):
    replies = iter(
        [
            NS(stop_reason="tool_use", content=[NS(type="tool_use", id="t1", name="search_products", input={"query": "yoga mat"})]),
            NS(stop_reason="end_turn", content=[NS(type="text", text="The Yoga Mat costs Rs 899.")]),
        ]
    )
    seen = []

    def fake_create(**params):
        seen.append(params["messages"])
        return next(replies)

    monkeypatch.setattr(agent_module.llm, "create", fake_create)
    agent = ShoppingAgent(Recommender(PRODUCTS), RagIndex(PRODUCTS), "Bearer test")
    result = agent.chat([{"role": "user", "content": "Do you have a yoga mat?"}])

    assert result["reply"] == "The Yoga Mat costs Rs 899."
    assert result["actions"] == [{"tool": "search_products", "input": {"query": "yoga mat"}}]
    tool_result = seen[1][-1]["content"][0]
    assert tool_result["tool_use_id"] == "t1" and "Yoga Mat" in tool_result["content"]
