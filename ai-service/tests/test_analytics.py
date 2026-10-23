"""Statistics, charts and the neural-network forecaster on synthetic data with known answers (no database)."""

import numpy as np
import pandas as pd

from app.analytics import statistics
from app.analytics.charts import auto_chart, inr
from app.dl.demand_net import forecast_units

RNG = np.random.default_rng(1)
DAYS = pd.date_range("2026-04-01", periods=120, freq="D")


def _daily(weekend_boost: float = 1.0, trend: float = 0.0, seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)  # each dataset has its own seed: results don't depend on test order
    rows = []
    for i, d in enumerate(DAYS):
        base = 40 + trend * i
        units = rng.poisson(base * (weekend_boost if d.day_of_week >= 5 else 1))
        rows.append({"day": d.date(), "category": "fashion", "revenue": units * 500.0, "units": units, "orders": max(units // 2, 1)})
    return pd.DataFrame(rows)


def _orders(n: int = 600) -> pd.DataFrame:
    methods = RNG.choice(["upi", "card", "cod"], size=n, p=[0.5, 0.3, 0.2])
    totals = RNG.lognormal(7.5, 0.6, size=n) * np.where(methods == "card", 1.6, 1.0)  # card orders really are bigger
    return pd.DataFrame(
        {
            "id": range(n),
            "total": totals,
            "payment_method": methods,
            "source": "web",
            "created_at": pd.Timestamp("2026-07-01") + pd.to_timedelta(RNG.integers(0, 90, n), unit="D"),
            "city": RNG.choice(["Mumbai", "Delhi", "Pune"], size=n),
            "weekday": RNG.integers(1, 8, n),
        }
    )


def test_indian_rupee_grouping():
    assert inr(5647604) == "₹56,47,604" and inr(999) == "₹999" and inr(100000) == "₹1,00,000"


def test_weekend_effect_detected_only_when_real():
    assert statistics.weekend_effect(_daily(weekend_boost=1.8))["significant"] is True
    assert statistics.weekend_effect(_daily(weekend_boost=1.0))["significant"] is False


def test_trend_regression_finds_growth():
    result = statistics.revenue_trend(_daily(trend=0.5))
    assert result["significant"] is True and result["stats"]["slope_per_day"] > 0


def test_payment_method_difference_is_significant():
    result = statistics.payment_method_effect(_orders())
    assert result["significant"] is True and result["chart"]["type"] == "bar"


def test_confidence_interval_contains_the_mean():
    s = statistics.order_value_interval(_orders())["stats"]
    assert s["ci_low"] < s["mean"] < s["ci_high"]


def test_price_sensitivity_negative_when_cheaper_sells_more():
    price = RNG.uniform(100, 5000, 80)
    products = pd.DataFrame({"price": price, "units": (20000 / price * RNG.uniform(0.8, 1.2, 80)).round() + 1, "revenue": 1.0, "orders": 1})
    result = statistics.price_sensitivity(products)
    assert result["stats"]["spearman_rho"] < -0.5 and result["stats"]["elasticity"] < 0


def test_insights_bundle_runs_end_to_end():
    daily, orders = _daily(1.5, 0.2), _orders()
    products = pd.DataFrame({"price": RNG.uniform(100, 900, 30), "units": RNG.integers(1, 50, 30), "revenue": 1.0, "orders": 1})
    cc = pd.DataFrame(
        {
            "category": ["fashion", "beauty"] * 3,
            "city": ["Mumbai", "Mumbai", "Delhi", "Delhi", "Pune", "Pune"],
            "units": [50, 5, 10, 40, 20, 20],
        }
    )
    found = statistics.insights(orders, daily, products, cc)
    assert {i["id"] for i in found} >= {"aov-ci", "trend", "weekend", "payment-aov", "price", "city-mix", "outliers"}
    assert statistics.overview(orders, daily)["charts"][1]["type"] == "line"


def test_auto_chart_picks_line_for_dates_and_bar_for_categories():
    assert auto_chart(pd.DataFrame({"day": ["2026-10-01", "2026-10-02"], "revenue": [1, 2]}))["type"] == "line"
    assert auto_chart(pd.DataFrame({"category": list("abcdefgh"), "revenue": range(8)}))["type"] == "bar"
    assert auto_chart(pd.DataFrame({"method": ["upi", "cod"], "orders": [3, 1]}))["type"] == "pie"


def test_neural_network_learns_the_weekly_pattern():
    # On a purely weekly pattern "same as last week" is near-optimal, so the network should come close to it
    # (on the store's real, noisier sales it beats it) and must have learned that weekends sell more.
    rng = np.random.default_rng(3)
    rows = [{"day": d.date(), "units": 30 + 25 * (d.day_of_week >= 5) + rng.normal(0, 2)} for d in DAYS]
    result = forecast_units(pd.DataFrame(rows))
    assert result["ready"] and len(result["forecast"]) == 14
    assert result["metrics"]["mae"] <= result["metrics"]["naive_mae"] * 1.5
    weekend = [f["units"] for f in result["forecast"] if pd.Timestamp(f["day"]).day_of_week >= 5]
    weekday = [f["units"] for f in result["forecast"] if pd.Timestamp(f["day"]).day_of_week < 5]
    assert np.mean(weekend) > np.mean(weekday) + 10  # it learned that weekends sell more


def test_forecast_needs_enough_history():
    short = pd.DataFrame({"day": DAYS[:20].date, "units": 5})
    assert forecast_units(short)["ready"] is False
