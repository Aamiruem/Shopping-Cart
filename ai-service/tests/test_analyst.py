"""The data analyst agent loop and the auth layer, with a scripted fake model and a fake database."""

import time
from contextlib import contextmanager
from types import SimpleNamespace as NS

import jwt
import pandas as pd
import pytest
from fastapi import HTTPException

from app.agents import analyst as analyst_module
from app.agents.analyst import DataAnalyst
from app.core import security
from app.core.config import get_settings

RESULT = pd.DataFrame({"category": ["fashion", "beauty"], "revenue": [5000.0, 3000.0]})


@pytest.fixture
def fake_db(monkeypatch):
    ran = []

    @contextmanager
    def session(seller_id):
        ran.append(("scope", seller_id))
        yield NS(transaction=lambda: _nullcontext())

    def query_df(conn, sql, params=None, max_rows=None):
        ran.append(("sql", sql))
        return RESULT, False

    monkeypatch.setattr(analyst_module, "analytics_session", session)
    monkeypatch.setattr(analyst_module, "query_df", query_df)
    return ran


@contextmanager
def _nullcontext():
    yield


def test_agent_fixes_a_rejected_query_then_charts_and_answers(fake_db, monkeypatch):
    replies = iter(
        [
            NS(
                stop_reason="tool_use",
                content=[NS(type="tool_use", id="t1", name="run_sql", input={"sql": "SELECT * FROM users", "purpose": "x"})],
            ),
            NS(
                stop_reason="tool_use",
                content=[
                    NS(
                        type="tool_use",
                        id="t2",
                        name="run_sql",
                        input={"sql": "SELECT category, SUM(line_total) AS revenue FROM order_items GROUP BY 1", "purpose": "revenue"},
                    )
                ],
            ),
            NS(
                stop_reason="tool_use",
                content=[
                    NS(
                        type="tool_use",
                        id="t3",
                        name="show_chart",
                        input={"type": "bar", "x": "category", "y": ["revenue"], "title": "Revenue"},
                    )
                ],
            ),
            NS(stop_reason="end_turn", content=[NS(type="text", text="Fashion leads with ₹5,000.")]),
        ]
    )
    seen = []

    def fake_create(**params):
        seen.append({**params, "messages": list(params["messages"])})  # snapshot: the agent keeps appending
        return next(replies)

    monkeypatch.setattr(analyst_module.llm, "enabled", lambda: True)
    monkeypatch.setattr(analyst_module.llm, "create", fake_create)
    result = DataAnalyst(seller_id=4).ask("Which category sells most?")

    assert result["answer"] == "Fashion leads with ₹5,000." and result["llm"] is True
    assert ("scope", 4) in fake_db  # the seller's scope was applied to the session
    executed = [s for kind, s in fake_db if kind == "sql"]
    assert len(executed) == 1 and "users" not in executed[0]  # the unsafe query never reached the database
    rejection = seen[1]["messages"][-1]["content"][0]
    assert rejection["is_error"] and "users" in rejection["content"]
    assert result["chart"]["type"] == "bar" and result["table"]["columns"] == ["category", "revenue"]
    assert seen[0]["system"][0]["cache_control"] == {"type": "ephemeral"}  # schema prompt is cached
    assert all(t.get("strict") for t in seen[0]["tools"])


def test_template_mode_without_api_key(fake_db, monkeypatch):
    monkeypatch.setattr(analyst_module.llm, "enabled", lambda: False)
    result = DataAnalyst(seller_id=None).ask("revenue by category please")
    assert result["llm"] is False and "fashion leads with ₹5,000" in result["answer"] and result["chart"]["type"] == "bar"


def _token(role: str, secret: str | None = None, uid: int = 7) -> str:
    claims = {"id": uid, "email": "a@b.c", "role": role, "exp": int(time.time()) + 60}
    return "Bearer " + jwt.encode(claims, secret or get_settings().jwt_secret, algorithm="HS256")


def test_tokens_and_roles():
    assert security.current_user(_token("seller")).role == "seller"
    with pytest.raises(HTTPException) as missing:
        security.current_user("")
    with pytest.raises(HTTPException) as forged:
        security.current_user(_token("admin", secret="not-the-secret"))
    with pytest.raises(HTTPException) as customer:
        security.require_seller(security.current_user(_token("customer")))
    assert (missing.value.status_code, forged.value.status_code, customer.value.status_code) == (401, 401, 403)


def test_sellers_only_ever_see_their_own_data():
    seller, admin = security.User(5, "s", "seller"), security.User(1, "a", "admin")
    assert security.seller_scope(seller, seller_id=99) == 5  # a seller can't ask for someone else's store
    assert security.seller_scope(admin, seller_id=99) == 99 and security.seller_scope(admin) is None
