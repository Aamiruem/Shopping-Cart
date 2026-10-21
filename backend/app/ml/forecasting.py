"""Daily revenue forecast.

Model: robust (Huber) regression on a linear trend + day-of-week effects + a monthly cycle -
the same idea as Prophet's additive model, small enough to train in milliseconds. Huber loss
stops one-off sale spikes from dragging the trend, and exponentially decaying sample weights
let the trend follow recent level shifts (a lost customer segment, a new product line).

It is validated on the last 28 days (trained only on earlier data) and compared with a
seasonal-naive baseline ("same weekday last week"), so the dashboard can show whether the
model actually beats the obvious guess.
"""

import numpy as np
import pandas as pd
from sklearn.linear_model import HuberRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .data import completed

HOLDOUT_DAYS = 28
MIN_HISTORY_DAYS = 56
HALF_LIFE_DAYS = 45


def _features(dates: pd.DatetimeIndex, origin: pd.Timestamp) -> np.ndarray:
    t = ((dates - origin).days).to_numpy(dtype=float)
    dow = np.eye(7)[dates.dayofweek][:, 1:]  # Monday is the baseline
    month_phase = 2 * np.pi * dates.day.to_numpy() / 30.5
    return np.column_stack([t, dow, np.sin(month_phase), np.cos(month_phase)])


def _fit(y: pd.Series, origin: pd.Timestamp):
    # Recent days count more (45-day half-life) so the trend follows level shifts instead of averaging over them
    age = (y.index[-1] - y.index).days.to_numpy(dtype=float)
    weights = 0.5 ** (age / HALF_LIFE_DAYS)
    model = make_pipeline(StandardScaler(), HuberRegressor(epsilon=1.5, alpha=0.001, max_iter=2000))
    model.fit(_features(y.index, origin), y.to_numpy(), huberregressor__sample_weight=weights)
    return model


def daily_revenue(sales: pd.DataFrame, today: pd.Timestamp) -> pd.Series:
    """Revenue per local day up to yesterday (today is still in progress), with empty days as 0."""
    done = completed(sales)
    if done.empty:
        return pd.Series(dtype=float)
    by_day = done.groupby("date")["revenue"].sum()
    index = pd.date_range(by_day.index.min(), today - pd.Timedelta(days=1), freq="D", tz=today.tz)
    return by_day.reindex(index, fill_value=0.0)


def forecast_revenue(sales: pd.DataFrame, today: pd.Timestamp, horizon: int = 30) -> dict:
    y = daily_revenue(sales, today)
    history = [{"date": d.strftime("%Y-%m-%d"), "revenue": round(float(v), 2)} for d, v in y.tail(120).items()]
    if len(y) < MIN_HISTORY_DAYS:
        return {"ready": False, "reason": f"Needs at least {MIN_HISTORY_DAYS} days of sales history (have {len(y)}).", "history": history}

    origin = y.index[0]

    # 1) Validate: train on everything before the last 28 days, predict those 28 days
    train, test = y.iloc[:-HOLDOUT_DAYS], y.iloc[-HOLDOUT_DAYS:]
    predicted = np.clip(_fit(train, origin).predict(_features(test.index, origin)), 0, None)
    naive = y.shift(7).iloc[-HOLDOUT_DAYS:].to_numpy()  # same weekday last week
    errors = test.to_numpy() - predicted
    mae = float(np.mean(np.abs(errors)))
    baseline_mae = float(np.mean(np.abs(test.to_numpy() - naive)))
    nonzero = test.to_numpy() > 0
    mape = float(np.mean(np.abs(errors[nonzero] / test.to_numpy()[nonzero]))) if nonzero.any() else None
    spread = float(np.std(errors))

    # 2) Refit on all history and forecast the horizon with a ~95% interval
    model = _fit(y, origin)
    future = pd.date_range(today, periods=horizon, freq="D", tz=today.tz)
    yhat = np.clip(model.predict(_features(future, origin)), 0, None)
    forecast = [
        {
            "date": d.strftime("%Y-%m-%d"),
            "yhat": round(float(v), 2),
            "lo": round(max(0.0, float(v) - 1.96 * spread), 2),
            "hi": round(float(v) + 1.96 * spread, 2),
        }
        for d, v in zip(future, yhat, strict=False)
    ]

    last_30 = float(y.tail(30).sum())
    next_total = float(yhat.sum())
    return {
        "ready": True,
        "model": "Huber regression · trend + weekday + monthly cycle, recent days weighted more",
        "history": history,
        "forecast": forecast,
        "summary": {
            "next30Revenue": round(next_total * 30 / horizon, 2),
            "last30Revenue": round(last_30, 2),
            "expectedGrowthPct": round((next_total * 30 / horizon / last_30 - 1) * 100, 1) if last_30 else None,
        },
        "metrics": {
            "holdoutDays": HOLDOUT_DAYS,
            "mae": round(mae, 2),
            "mape": round(mape * 100, 1) if mape is not None else None,
            "baselineMae": round(baseline_mae, 2),
            "improvementPct": round((1 - mae / baseline_mae) * 100, 1) if baseline_mae else None,
        },
    }
