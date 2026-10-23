"""Data visualisation: chart specifications the storefront draws with Recharts.

A spec is plain JSON - {type, title, x, y, data, ...} - so any front end (or a notebook) can render it, and the
AI service stays light: no plotting library or image rendering on the server.
"""

import math
from datetime import date, datetime

import numpy as np
import pandas as pd

CHART_TYPES = ("bar", "line", "area", "pie", "scatter")
MAX_POINTS = 200


def _clean(value):
    """JSON-safe cell: numpy scalars to Python, NaN/inf to None, dates to ISO strings."""
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (datetime, date, pd.Timestamp)):
        return value.isoformat()[:10] if not isinstance(value, datetime) or value.time() == datetime.min.time() else value.isoformat()
    return value


def records(df: pd.DataFrame, limit: int | None = None) -> list[dict]:
    frame = df if limit is None else df.head(limit)
    return [{k: _clean(v) for k, v in row.items()} for row in frame.to_dict(orient="records")]


def chart(kind: str, title: str, df: pd.DataFrame, x: str, y: list[str], **extra) -> dict:
    if kind not in CHART_TYPES:
        raise ValueError(f"chart type must be one of {', '.join(CHART_TYPES)}")
    missing = [c for c in [x, *y] if c not in df.columns]
    if missing:
        raise ValueError(f"unknown column(s): {', '.join(missing)}. Columns: {', '.join(map(str, df.columns))}")
    return {"type": kind, "title": title, "x": x, "y": y, "data": records(df[[x, *y]], MAX_POINTS), **extra}


def auto_chart(df: pd.DataFrame, title: str = "") -> dict | None:
    """Picks a sensible chart for a query result: a time axis -> line, a category -> bar (pie for few
    slices of one measure), two numeric columns -> scatter."""
    if df.empty or len(df.columns) < 2:
        return None
    numeric = [c for c in df.columns if pd.api.types.is_numeric_dtype(df[c]) and not pd.api.types.is_bool_dtype(df[c])]
    labels = [c for c in df.columns if c not in numeric]
    if not numeric:
        return None
    x = labels[0] if labels else numeric[0]
    measures = [c for c in numeric if c != x and not c.endswith("_id") and c != "id"][:3]
    if not measures:
        return None
    sample = df[x].dropna().head(5)
    is_time = len(sample) > 0 and (
        pd.api.types.is_datetime64_any_dtype(df[x])
        or all(isinstance(v, (date, datetime)) for v in sample)
        or sample.astype(str).str.fullmatch(r"\d{4}-\d{2}(-\d{2})?.*").all()  # "2026-10", "2026-10-23"
    )
    if not labels:
        return chart("scatter", title, df, x, measures[:1])
    if is_time:
        return chart("line", title, df, x, measures)
    if len(df) <= 6 and len(measures) == 1:
        return chart("pie", title, df, x, measures)
    return chart("bar", title, df, x, measures)
