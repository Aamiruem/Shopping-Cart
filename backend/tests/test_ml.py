"""Unit tests for the analytics / ML layer. No database needed: `pytest tests/test_ml.py`."""

import numpy as np
import pandas as pd

from app.ml import recommender
from app.ml.bestsellers import predict_bestsellers
from app.ml.customers import cohort_retention, predict_churn, segment_customers
from app.ml.forecasting import forecast_revenue
from app.ml.overview import overview
from app.ml.support import classifier_info, priority, sentiment, triage


def _daily_sales(revenue: np.ndarray, today: pd.Timestamp) -> pd.DataFrame:
    days = pd.date_range(today - pd.Timedelta(days=len(revenue)), periods=len(revenue), freq="D", tz=today.tz)
    return pd.DataFrame(
        {
            "order_id": range(len(days)),
            "user_id": 1,
            "status": "placed",
            "qty": 1,
            "price": revenue,
            "revenue": revenue,
            "created_at": days + pd.Timedelta(hours=12),
            "date": days,
        }
    )


def test_forecast_learns_trend_and_weekly_seasonality(shop):
    today = shop["today"]
    t = np.arange(150)
    weekday = (today - pd.Timedelta(days=150) + pd.to_timedelta(t, unit="D")).dayofweek
    revenue = 20_000 + 150 * t + np.where(weekday >= 5, 9_000, 0) + np.random.default_rng(1).normal(0, 1_500, 150)
    result = forecast_revenue(_daily_sales(revenue, today), today, horizon=14)
    assert result["ready"]
    assert result["metrics"]["mae"] < result["metrics"]["baselineMae"]  # beats "same weekday last week"
    assert result["metrics"]["mape"] < 10
    weekend = [p["yhat"] for p in result["forecast"] if pd.Timestamp(p["date"]).dayofweek >= 5]
    weekdays = [p["yhat"] for p in result["forecast"] if pd.Timestamp(p["date"]).dayofweek < 5]
    assert np.mean(weekend) > np.mean(weekdays) + 5_000  # learned the weekend bump


def test_forecast_is_sane_on_noisy_shop_data(shop):
    result = forecast_revenue(shop["sales"], shop["today"], horizon=30)
    assert result["ready"] and len(result["forecast"]) == 30
    assert all(0 <= p["lo"] <= p["yhat"] <= p["hi"] for p in result["forecast"])
    recent = np.mean([h["revenue"] for h in result["history"][-28:]])
    assert 0.5 * recent < np.mean([p["yhat"] for p in result["forecast"]]) < 1.5 * recent


def test_forecast_needs_enough_history(shop):
    recent = shop["sales"][shop["sales"]["created_at"] >= shop["today"] - pd.Timedelta(days=20)]
    assert forecast_revenue(recent, shop["today"])["ready"] is False


def test_bestsellers_find_rising_products(shop):
    result = predict_bestsellers(shop["sales"], shop["products"], shop["events"], shop["today"], horizon=30)
    assert result["ready"]
    assert len(result["top"]) == 20
    assert result["metrics"]["r2"] > 0
    top10 = {p["productId"] for p in result["top"][:10]}
    assert len(top10 & {f"p{i}" for i in range(8)}) >= 3  # the simulated rising products show up near the top


def test_segments_rank_best_customers_first(shop):
    result = segment_customers(shop["sales"], shop["today"])
    assert result["ready"]
    by_name = {s["segment"]: s for s in result["segments"]}
    assert set(by_name) == {"Champions", "Loyal", "Needs attention", "At risk"}
    assert by_name["Champions"]["avgSpend"] > by_name["At risk"]["avgSpend"]
    assert by_name["Champions"]["avgRecencyDays"] < by_name["At risk"]["avgRecencyDays"]


def test_churn_model_learns_something(shop):
    result = predict_churn(shop["sales"], shop["events"], shop["users"], shop["today"])
    assert result["ready"]
    assert result["metrics"]["auc"] > 0.6
    assert sum(b["customers"] for b in result["distribution"]) > 0


def test_churn_masks_emails_for_sellers(shop):
    result = predict_churn(shop["sales"], shop["events"], shop["users"], shop["today"], mask_emails=True)
    assert all("***@" in c["email"] for c in result["atRisk"] if c["email"])


def test_cohorts_start_at_100_percent(shop):
    cohorts = cohort_retention(shop["sales"])
    assert cohorts and all(c["retention"][0] == 100.0 for c in cohorts)


def test_overview_kpis_are_consistent(shop):
    result = overview(shop["sales"], shop["events"], shop["today"], days=30)
    k = result["kpis"]
    assert k["orders"] > 0 and abs(k["avgOrderValue"] - k["revenue"] / k["orders"]) < 0.01
    assert len(result["heatmap"]) == 7 * 24
    stages = [f["users"] for f in result["funnel"]]
    assert stages == sorted(stages, reverse=True)  # a funnel only narrows


def test_overview_handles_a_seller_with_no_sales(shop):
    empty = shop["sales"].iloc[0:0]
    result = overview(empty, shop["events"].iloc[0:0], shop["today"], days=30)
    assert result["kpis"]["orders"] == 0 and result["topProducts"] == []


def test_recommender_suggests_unbought_related_products(shop):
    ids = shop["products"]["product_id"].tolist()
    model = recommender.build(shop["events"], ids)
    user = int(shop["sales"]["user_id"].value_counts().index[0])
    picks = recommender.for_user(model, user, k=5)
    bought = set(shop["events"].query("type == 'purchase' and userId == @user")["productId"])
    assert picks and not ({p["productId"] for p in picks} & bought)
    assert recommender.for_user(model, None) == []


def test_support_classifier_and_triage():
    assert classifier_info()["crossValidatedAccuracy"] > 0.7
    ticket = triage("Double charge", "I was charged twice and nobody is helping, this is a scam!!", "Asha Rao", 42)
    assert ticket["category"] == "payment" and ticket["priority"] == "high"
    assert "Asha" in ticket["suggestedReply"] and "#42" in ticket["suggestedReply"]
    assert triage("Where is my parcel", "My package has not arrived yet")["category"] == "delivery"


def test_sentiment_understands_negation():
    assert sentiment("The product is good") > 0
    assert sentiment("The product is not good") < 0
    assert sentiment("very bad, terrible experience!!") < sentiment("bad experience")
    assert priority("delivery", 0.5, "thanks!") == "low"


def test_negation_stops_at_the_end_of_a_sentence():
    # Regression: "not" used to flip "disappointed" in the next sentence, scoring this as positive
    assert sentiment("I returned my headphones and the refund is still not credited. Very disappointed!") < -0.4
    assert sentiment("The delivery was not late, but the box was damaged") < 0


def test_listing_score_rewards_complete_listings():
    from app.ml.growth import listing_score

    bare, bare_fixes = listing_score({"name": "Thing", "category": "electronics", "price": 100, "image": "x.jpg"})
    full, full_fixes = listing_score(
        {
            "name": "Thing",
            "category": "electronics",
            "price": 100,
            "mrp": 150,
            "brand": "Volt",
            "images": ["a", "b", "c"],
            "videos": ["v.mp4"],
            "images360": ["1", "2", "3", "4"],
            "tags": ["a", "b", "c"],
            "description": "x" * 200,
        }
    )
    assert full == 100 and not full_fixes
    assert bare < 40 and any("photo" in f for f in bare_fixes) and any("video" in f for f in bare_fixes)
