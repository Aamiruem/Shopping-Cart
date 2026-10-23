"""Agentic AI data analyst: plain-English questions about sales -> SQL -> pandas -> answer, table and chart.

Claude writes PostgreSQL over the read-only reporting views and runs it through the `run_sql` tool; errors
(syntax, a blocked function, a timeout) go back to the model so it can correct itself, for up to MAX_STEPS
turns. It then picks a chart with `show_chart` and writes a short answer citing the numbers.

Safety: every query passes sql_guard.validate (one SELECT, allow-listed views and functions) and runs in a
READ ONLY, time-limited session whose search_path holds only the views - and a seller's session only sees
that seller's sales. Without ANTHROPIC_API_KEY, questions are matched to vetted query templates instead.
"""

import json
import re

import pandas as pd
import psycopg

from ..analytics.charts import CHART_TYPES, auto_chart, chart, inr, records
from ..core.config import get_settings
from ..db.postgres import analytics_session, query_df
from ..db.queries import TEMPLATES
from ..llm import client as llm
from .sql_guard import UnsafeSQL, validate

MAX_STEPS = 6
ROWS_TO_MODEL = 40  # the model sees a preview; the user gets the full (capped) table

SCHEMA = """\
orders(id, customer_id, status 'placed'|'cancelled', payment_method 'upi'|'card'|'netbanking'|'wallet'|'emi'|'cod',
       source, delivery_fee numeric, created_at timestamptz, total numeric)  -- one row per order, rupees
order_items(id, order_id, product_id, product_name, category, seller_id, price numeric, qty int, line_total numeric,
            fulfilment, order_status, payment_method, ordered_at timestamptz)  -- one row per product line
customers(id, city, joined_at timestamptz, is_synthetic bool)  -- no names or contact details
sellers(seller_id, store_name, created_at)
support_tickets(id, category, priority 'low'|'medium'|'high', status, sentiment numeric -1..1, created_at, resolved_at)
Categories: mobiles, electronics, fashion, accessories, beauty, home, kitchen, sports, grocery."""

SYSTEM = f"""You are the data analyst for Arvixa, an Indian online marketplace. Answer the user's question about \
their store data by querying PostgreSQL with the run_sql tool, then (when a chart helps) call show_chart, then \
reply with a short answer.

Tables (PostgreSQL views; the session already limits a seller to their own sales - never try to filter by seller \
or change settings):
{SCHEMA}

Rules:
- One SELECT per run_sql call. Only the tables above, by bare name. Aggregate in SQL; LIMIT 200 or fewer rows.
- Exclude cancelled orders (status / order_status <> 'cancelled') unless the question is about cancellations.
- Timestamps are already in India time. Use date_trunc / to_char for periods; now() for "today".
- Money is in Indian rupees; round to whole rupees. Name result columns clearly (revenue, orders, units...).
- If a query fails, read the error and fix the query. If the data can't answer the question, say so.
- Final answer: 2-4 sentences in plain English with the key numbers (₹ with Indian digit grouping), no SQL, no \
markdown tables - the user already sees the table and chart."""

TOOLS = [
    {
        "name": "run_sql",
        "description": "Run one read-only PostgreSQL SELECT over the store views and get the result rows back.",
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "sql": {"type": "string", "description": "A single SELECT statement"},
                "purpose": {"type": "string", "description": "What this query answers, in a few words"},
            },
            "required": ["sql", "purpose"],
            "additionalProperties": False,
        },
    },
    {
        "name": "show_chart",
        "description": "Chart the most recent successful run_sql result for the user.",
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": list(CHART_TYPES)},
                "x": {"type": "string", "description": "Result column for the x axis / slices"},
                "y": {"type": "array", "items": {"type": "string"}, "description": "Numeric result columns to plot"},
                "title": {"type": "string"},
            },
            "required": ["type", "x", "y", "title"],
            "additionalProperties": False,
        },
    },
]


MONEY_WORDS = ("revenue", "total", "value", "price", "sales", "amount", "aov")


def _amount(column: str, value) -> str:
    return inr(float(value)) if any(w in column for w in MONEY_WORDS) else f"{float(value):,.0f}"


class DataAnalyst:
    def __init__(self, seller_id: int | None):
        self.seller_id = seller_id
        self.queries: list[dict] = []
        self.result: pd.DataFrame | None = None
        self.truncated = False
        self.chart: dict | None = None

    # ---- tools ---------------------------------------------------------------
    def run_sql(self, conn: psycopg.Connection, sql: str, purpose: str = "") -> dict:
        safe = validate(sql)
        try:
            with conn.transaction():  # savepoint: a failed query doesn't abort the session
                df, truncated = query_df(conn, safe, max_rows=get_settings().max_rows)
        except psycopg.Error as e:
            message = (e.diag.message_primary if e.diag and e.diag.message_primary else str(e)).splitlines()[0]
            self.queries.append({"sql": safe, "purpose": purpose, "error": message})
            raise UnsafeSQL(f"Database error: {message}") from None
        self.result, self.truncated = df, truncated
        self.queries.append({"sql": safe, "purpose": purpose, "rows": len(df)})
        return {"columns": list(df.columns), "rows": records(df, ROWS_TO_MODEL), "row_count": len(df), "truncated": truncated}

    def show_chart(self, type: str, x: str, y: list[str], title: str) -> dict:  # noqa: A002 - tool argument name
        if self.result is None:
            raise UnsafeSQL("Run a query first")
        self.chart = chart(type, title, self.result, x, y)
        return {"ok": True}

    def _call(self, conn, name: str, args: dict) -> tuple[dict, bool]:
        try:
            if name == "run_sql":
                return self.run_sql(conn, args.get("sql", ""), args.get("purpose", "")), False
            if name == "show_chart":
                return self.show_chart(args.get("type", ""), args.get("x", ""), list(args.get("y") or []), args.get("title", "")), False
            return {"error": f"Unknown tool {name}"}, True
        except (UnsafeSQL, ValueError) as e:
            return {"error": str(e)}, True

    # ---- answers -------------------------------------------------------------
    def _response(self, answer: str, used_llm: bool) -> dict:
        table = None
        if self.result is not None:
            table = {
                "columns": list(self.result.columns),
                "rows": records(self.result, 200),
                "truncated": self.truncated or len(self.result) > 200,
            }
        return {"answer": answer, "queries": self.queries, "table": table, "chart": self.chart, "llm": used_llm}

    def ask(self, question: str) -> dict:
        question = question.strip()[:500]
        with analytics_session(self.seller_id) as conn:
            if not llm.enabled():
                return self._template_answer(conn, question)
            return self._agent_answer(conn, question)

    def _agent_answer(self, conn, question: str) -> dict:
        messages = [{"role": "user", "content": question}]
        for _ in range(MAX_STEPS):
            response = llm.create(effort="medium", max_tokens=8000, system=llm.cached_system(SYSTEM), tools=TOOLS, messages=messages)
            if response.stop_reason != "tool_use":
                if self.chart is None and self.result is not None:
                    self.chart = auto_chart(self.result, question)
                return self._response(llm.text_of(response), True)
            messages.append({"role": "assistant", "content": response.content})
            results = []
            for block in response.content:  # parallel tool calls: answer all of them in one user message
                if block.type == "tool_use":
                    output, is_error = self._call(conn, block.name, block.input)
                    results.append(
                        {"type": "tool_result", "tool_use_id": block.id, "content": json.dumps(output, default=str), "is_error": is_error}
                    )
            messages.append({"role": "user", "content": results})
        return self._response("That question needed too many steps - could you make it more specific?", True)

    def _template_answer(self, conn, question: str) -> dict:
        words = set(re.findall(r"[a-z]+", question.lower()))
        score, (_, title, sql, (kind, x, y)) = max(((len(words & kw), t) for t in TEMPLATES for kw in [t[0]]), key=lambda s: s[0])
        if score == 0:
            topics = ", ".join(t[1].split(" (")[0].lower() for t in TEMPLATES)
            return self._response(f"Add ANTHROPIC_API_KEY to answer any question. Without it I can show: {topics}.", False)
        self.run_sql(conn, sql, title)
        if self.result is not None and not self.result.empty:
            self.chart = chart(kind, title, self.result, x, y)
            measure = y[0]
            if kind == "line":
                lead = f"{len(self.result)} days, {_amount(measure, self.result[measure].sum())} {measure.replace('_', ' ')} in total"
            else:
                top = self.result.loc[self.result[measure].idxmax()]  # the largest value, not just the first row
                lead = f"{top[x]} leads with {_amount(measure, top[measure])} {measure.replace('_', ' ')}"
            answer = f"{title}: {lead}. (Template answer - add ANTHROPIC_API_KEY for free-form questions.)"
        else:
            answer = f"{title}: no matching data yet."
        return self._response(answer, False)


SUGGESTED_QUESTIONS = [
    "Which categories made the most revenue in the last 90 days?",
    "What are my top 10 products by revenue?",
    "Show daily revenue for the last 60 days",
    "How do customers pay, and which method has the biggest orders?",
    "Which cities buy the most?",
    "What is our busiest day of the week?",
    "How many customers are repeat buyers?",
    "How has average order value changed month by month?",
]
