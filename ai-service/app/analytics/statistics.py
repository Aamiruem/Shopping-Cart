"""Exploratory data analysis and statistical tests on the store's sales (NumPy, pandas, SciPy).

Each insight answers a business question and returns: the numbers, a plain-English finding, whether the result
is statistically significant (alpha = 0.05), the method used, and a chart. All functions take DataFrames and
are pure, so they are easy to test and reuse in a notebook.
"""

import numpy as np
import pandas as pd
from scipy import stats

from .charts import chart, inr, records

ALPHA = 0.05
RNG = np.random.default_rng(7)  # fixed seed: bootstrap intervals are reproducible
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def _rupees(x: float) -> str:
    return inr(x)


def _insight(id_: str, title: str, finding: str, method: str, significant: bool | None, stats_: dict, chart_: dict | None) -> dict:
    return {
        "id": id_,
        "title": title,
        "finding": finding,
        "method": method,
        "significant": significant,
        "stats": {k: (round(float(v), 4) if isinstance(v, int | float | np.floating | np.integer) else v) for k, v in stats_.items()},
        "chart": chart_,
    }


# ---------- Exploratory data analysis ----------


def overview(orders: pd.DataFrame, daily: pd.DataFrame) -> dict:
    """Dataset profile: size, date range, missing values, and the shape of order values."""
    totals = orders["total"].astype(float)
    counts, edges = np.histogram(totals, bins=min(20, max(totals.nunique(), 1)))
    histogram = pd.DataFrame(
        {"range": [f"{_rupees(a)}–{_rupees(b)}" for a, b in zip(edges[:-1], edges[1:], strict=True)], "orders": counts}
    )
    days = daily.groupby("day", as_index=False).agg(revenue=("revenue", "sum"), orders=("orders", "sum")).sort_values("day")
    days["rolling_7d"] = days["revenue"].rolling(7, min_periods=1).mean().round(0)
    return {
        "rows": {"orders": len(orders), "days": int(days["day"].nunique())},
        "dateRange": [str(orders["created_at"].min())[:10], str(orders["created_at"].max())[:10]] if len(orders) else None,
        "missing": {c: int(n) for c, n in orders.isna().sum().items() if n},
        "orderValue": {
            "mean": round(float(totals.mean()), 2),
            "median": round(float(totals.median()), 2),
            "std": round(float(totals.std()), 2),
            "skew": round(float(stats.skew(totals)), 3),
            "kurtosis": round(float(stats.kurtosis(totals)), 3),
            "p90": round(float(totals.quantile(0.9)), 2),
        },
        "charts": [
            chart("bar", "Distribution of order values", histogram, "range", ["orders"]),
            chart("line", "Daily revenue with 7-day moving average", days, "day", ["revenue", "rolling_7d"]),
        ],
    }


def correlations(products: pd.DataFrame) -> dict:
    """Spearman rank correlation between product-level measures (robust to outliers and skew)."""
    cols = [c for c in ("price", "units", "revenue", "orders") if c in products]
    matrix = products[cols].astype(float).corr(method="spearman").round(3)
    return {"columns": cols, "matrix": matrix.values.tolist()}


# ---------- Inferential statistics ----------


def order_value_interval(orders: pd.DataFrame) -> dict:
    """How precisely do we know the average order value? t-interval vs bootstrap percentile interval."""
    x = orders["total"].astype(float).to_numpy()
    mean, sem = x.mean(), stats.sem(x)
    t_low, t_high = stats.t.interval(0.95, len(x) - 1, loc=mean, scale=sem)
    resamples = max(200, min(2000, 20_000_000 // max(len(x), 1)))  # keeps the resample matrix under ~160 MB
    boots = RNG.choice(x, size=(resamples, len(x)), replace=True).mean(axis=1)
    b_low, b_high = np.percentile(boots, [2.5, 97.5])
    finding = (
        f"The average order is {_rupees(mean)}; with 95% confidence the true average lies between "
        f"{_rupees(t_low)} and {_rupees(t_high)} (bootstrap: {_rupees(b_low)}–{_rupees(b_high)})."
    )
    return _insight(
        "aov-ci",
        "Average order value",
        finding,
        "Student's t interval and bootstrap resampling",
        None,
        {"mean": mean, "ci_low": t_low, "ci_high": t_high, "bootstrap_low": b_low, "bootstrap_high": b_high, "n": len(x)},
        None,
    )


def payment_method_effect(orders: pd.DataFrame) -> dict | None:
    """Do customers who pay differently spend differently? Kruskal-Wallis across methods, Welch's t-test +
    Cohen's d between the two most common."""
    groups = {m: g["total"].astype(float).to_numpy() for m, g in orders.groupby("payment_method") if len(g) >= 20}
    if len(groups) < 2:
        return None
    top = sorted(groups, key=lambda m: -len(groups[m]))[:2]
    a, b = groups[top[0]], groups[top[1]]
    welch = stats.ttest_ind(a, b, equal_var=False)
    kruskal = stats.kruskal(*groups.values())
    pooled = np.sqrt((a.var(ddof=1) + b.var(ddof=1)) / 2)
    d = (a.mean() - b.mean()) / pooled if pooled else 0.0
    significant = bool(kruskal.pvalue < ALPHA)
    size = "negligible" if abs(d) < 0.2 else "small" if abs(d) < 0.5 else "medium" if abs(d) < 0.8 else "large"
    finding = (
        f"{top[0].upper()} orders average {_rupees(a.mean())} vs {_rupees(b.mean())} for {top[1].upper()}. "
        + (
            "The difference across payment methods is statistically significant"
            if significant
            else "The difference is not statistically significant - likely chance"
        )
        + f" (Kruskal-Wallis p = {kruskal.pvalue:.3g}); effect size is {size} (Cohen's d = {d:.2f})."
    )
    by_method = orders.groupby("payment_method", as_index=False).agg(avg_order_value=("total", "mean"), orders=("total", "size"))
    by_method["avg_order_value"] = by_method["avg_order_value"].round(0)
    return _insight(
        "payment-aov",
        "Order value by payment method",
        finding,
        "Kruskal-Wallis H test, Welch's t-test, Cohen's d",
        significant,
        {"kruskal_p": kruskal.pvalue, "welch_t": welch.statistic, "welch_p": welch.pvalue, "cohens_d": d},
        chart("bar", "Average order value by payment method", by_method, "payment_method", ["avg_order_value"]),
    )


def weekend_effect(daily: pd.DataFrame) -> dict | None:
    """Do weekends sell more? Mann-Whitney U on daily revenue (no normality assumption)."""
    days = daily.groupby("day", as_index=False)["revenue"].sum()
    days["weekday"] = pd.to_datetime(days["day"]).dt.day_of_week
    weekend, weekday = days[days["weekday"] >= 5]["revenue"], days[days["weekday"] < 5]["revenue"]
    if len(weekend) < 4 or len(weekday) < 4:
        return None
    test = stats.mannwhitneyu(weekend, weekday, alternative="two-sided")
    lift = weekend.median() / weekday.median() - 1 if weekday.median() else 0.0
    significant = bool(test.pvalue < ALPHA)
    finding = (
        f"A typical weekend day brings {_rupees(weekend.median())} vs {_rupees(weekday.median())} on weekdays "
        f"({lift:+.0%}). "
        + ("That gap is statistically significant." if significant else "That gap is within normal day-to-day noise.")
        + f" (Mann-Whitney U p = {test.pvalue:.3g})"
    )
    by_day = days.groupby("weekday", as_index=False)["revenue"].median().round(0)
    by_day["day"] = by_day["weekday"].map(dict(enumerate(WEEKDAYS)))
    return _insight(
        "weekend",
        "Weekend vs weekday sales",
        finding,
        "Mann-Whitney U test on daily revenue",
        significant,
        {"u": test.statistic, "p": test.pvalue, "weekend_median": weekend.median(), "weekday_median": weekday.median(), "lift": lift},
        chart("bar", "Median daily revenue by day of week", by_day, "day", ["revenue"]),
    )


def revenue_trend(daily: pd.DataFrame) -> dict | None:
    """Is revenue growing? Ordinary least squares on daily revenue vs time."""
    days = daily.groupby("day", as_index=False)["revenue"].sum().sort_values("day")
    if len(days) < 10:
        return None
    t = np.arange(len(days))
    fit = stats.linregress(t, days["revenue"].astype(float))
    per_month = fit.slope * 30
    significant = bool(fit.pvalue < ALPHA)
    direction = "growing" if fit.slope > 0 else "declining"
    finding = (
        f"Daily revenue is {direction} by about {_rupees(abs(per_month))} per month "
        + ("- a statistically significant trend" if significant else "- but the trend is not statistically significant")
        + f" (p = {fit.pvalue:.3g}, R² = {fit.rvalue**2:.2f})."
    )
    days["trend"] = (fit.intercept + fit.slope * t).round(0)
    return _insight(
        "trend",
        "Revenue trend",
        finding,
        "Linear regression (least squares)",
        significant,
        {"slope_per_day": fit.slope, "p": fit.pvalue, "r2": fit.rvalue**2},
        chart("line", "Daily revenue and fitted trend", days, "day", ["revenue", "trend"]),
    )


def price_sensitivity(products: pd.DataFrame) -> dict | None:
    """Do cheaper products sell more? Spearman correlation and a log-log slope (price elasticity estimate)."""
    p = products[(products["price"] > 0) & (products["units"] > 0)]
    if len(p) < 10:
        return None
    rho = stats.spearmanr(p["price"], p["units"])
    fit = stats.linregress(np.log(p["price"].astype(float)), np.log(p["units"].astype(float)))
    significant = bool(rho.pvalue < ALPHA)
    finding = (
        f"Across {len(p)} products, price and units sold have a Spearman correlation of {rho.statistic:.2f}"
        f" (p = {rho.pvalue:.3g}). The log-log slope suggests a 10% higher price goes with "
        f"{abs(fit.slope) * 10:.1f}% {'fewer' if fit.slope < 0 else 'more'} units sold."
    )
    sample = p.nlargest(150, "revenue")[["price", "units"]].round(0)
    return _insight(
        "price",
        "Price vs demand",
        finding,
        "Spearman rank correlation, log-log regression (elasticity)",
        significant,
        {"spearman_rho": rho.statistic, "p": rho.pvalue, "elasticity": fit.slope},
        chart("scatter", "Price vs units sold (top products)", sample, "price", ["units"]),
    )


def category_city_dependence(category_city: pd.DataFrame) -> dict | None:
    """Do shoppers in different cities buy different categories? Chi-square test of independence + Cramér's V."""
    if category_city.empty:
        return None
    top_cities = category_city.groupby("city")["units"].sum().nlargest(6).index
    table = category_city[category_city["city"].isin(top_cities)].pivot_table(
        index="category", columns="city", values="units", aggfunc="sum", fill_value=0
    )
    table = table.loc[table.sum(axis=1) > 0]
    if table.shape[0] < 2 or table.shape[1] < 2:
        return None
    chi2, p, dof, _ = stats.chi2_contingency(table.to_numpy())
    n = table.to_numpy().sum()
    v = np.sqrt(chi2 / (n * (min(table.shape) - 1)))
    significant = bool(p < ALPHA)
    strength = "very weak" if v < 0.1 else "weak" if v < 0.2 else "moderate" if v < 0.3 else "strong"
    finding = (
        "The category mix differs by city" if significant else "Cities buy a similar category mix"
    ) + f" (chi-square p = {p:.3g}); the association is {strength} (Cramér's V = {v:.2f})."
    shares = (table / table.sum(axis=0)).mul(100).round(1).reset_index()
    return _insight(
        "city-mix",
        "Category mix by city",
        finding,
        "Chi-square test of independence, Cramér's V",
        significant,
        {"chi2": chi2, "p": p, "dof": dof, "cramers_v": v},
        {**chart("bar", "Category share of units by city (%)", shares, "category", [str(c) for c in table.columns]), "stacked": False},
    )


def outliers(orders: pd.DataFrame) -> dict:
    """Unusually large orders, by Tukey's IQR rule."""
    x = orders["total"].astype(float)
    q1, q3 = x.quantile([0.25, 0.75])
    fence = q3 + 1.5 * (q3 - q1)
    big = orders[x > fence].nlargest(10, "total")[["id", "total", "payment_method", "city"]]
    finding = (
        f"{int((x > fence).sum())} orders ({(x > fence).mean():.1%}) are unusually large (above {_rupees(fence)}); "
        "worth checking for bulk buyers or fraud."
    )
    return {
        **_insight(
            "outliers",
            "Unusually large orders",
            finding,
            "Tukey's IQR rule (Q3 + 1.5 × IQR)",
            None,
            {"q1": q1, "q3": q3, "upper_fence": fence, "count": int((x > fence).sum())},
            None,
        ),
        "rows": records(big),
    }


def insights(orders: pd.DataFrame, daily: pd.DataFrame, products: pd.DataFrame, category_city: pd.DataFrame) -> list[dict]:
    if orders.empty:
        return []
    found = [
        order_value_interval(orders),
        revenue_trend(daily),
        weekend_effect(daily),
        payment_method_effect(orders),
        price_sensitivity(products),
        category_city_dependence(category_city),
        outliers(orders),
    ]
    return [i for i in found if i]
