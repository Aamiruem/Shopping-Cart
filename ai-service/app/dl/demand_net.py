"""Deep learning: a neural-network demand forecaster.

A multilayer perceptron (feed-forward neural network: 2 hidden ReLU layers, trained by backpropagation with the
Adam optimiser and early stopping) learns daily units sold from:
  * the last 14 days of sales (lag features),
  * the 7-day moving average,
  * the day of the week (one-hot), since Indian shoppers buy more at weekends.

It is evaluated honestly: trained on all but the last 14 days, scored on those unseen days, and compared with a
seasonal-naive baseline ("same as 7 days ago"). Then it is refit on all data and forecasts the next 14 days
recursively (each prediction becomes an input for the next day).

scikit-learn's MLPRegressor keeps the service light (no 1 GB+ PyTorch install). The same feature pipeline
drops into a PyTorch / Keras LSTM unchanged if the catalog grows enough to need one.
"""

import numpy as np
import pandas as pd
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from ..analytics.charts import chart

LAGS = 14
HORIZON = 14
MIN_DAYS = LAGS + HORIZON + 14  # enough history to train on and still hold out two weeks


def _features(series: np.ndarray, t: int, weekday: int) -> list[float]:
    lags = series[t - LAGS : t][::-1]  # yesterday first
    return [*lags, series[t - 7 : t].mean(), *np.eye(7)[weekday]]


def _dataset(series: np.ndarray, weekdays: np.ndarray, start: int, end: int):
    X = [_features(series, t, weekdays[t]) for t in range(start, end)]
    return np.array(X), series[start:end]


def _network(seed: int = 0):
    return make_pipeline(
        StandardScaler(),
        MLPRegressor(
            hidden_layer_sizes=(64, 32),
            activation="relu",
            solver="adam",
            alpha=1e-3,
            learning_rate_init=1e-3,
            max_iter=2000,
            early_stopping=True,
            validation_fraction=0.15,
            n_iter_no_change=40,
            random_state=seed,
        ),
    )


def _mae(a, b) -> float:
    return float(np.mean(np.abs(np.asarray(a) - np.asarray(b))))


def forecast_units(daily: pd.DataFrame) -> dict:
    """daily: rows of (day, units) - several rows per day are summed. Returns metrics, the forecast and a chart."""
    if daily.empty:
        return {"ready": False, "reason": "No sales yet"}
    s = daily.groupby("day")["units"].sum()
    s.index = pd.to_datetime(s.index)
    s = s.asfreq("D", fill_value=0).astype(float)  # days with no sales count as zero
    if len(s) < MIN_DAYS:
        return {"ready": False, "reason": f"Needs at least {MIN_DAYS} days of sales; have {len(s)}"}
    series, weekdays = s.to_numpy(), s.index.day_of_week.to_numpy()

    # 1) Honest evaluation on the last HORIZON days, never seen during training
    split = len(series) - HORIZON
    X_train, y_train = _dataset(series, weekdays, LAGS, split)
    model = _network().fit(X_train, y_train)
    history = series[:split].tolist()
    test_pred = []
    for t in range(split, len(series)):  # recursive, exactly like a real forecast
        y = max(0.0, float(model.predict([_features(np.array(history), t, weekdays[t])])[0]))
        test_pred.append(y)
        history.append(y)
    actual = series[split:]
    naive = series[split - 7 : len(series) - 7]  # seasonal naive: same weekday last week
    mae, naive_mae = _mae(actual, test_pred), _mae(actual, naive)

    # 2) Refit on everything and forecast the next HORIZON days
    X_all, y_all = _dataset(series, weekdays, LAGS, len(series))
    model = _network().fit(X_all, y_all)
    history = series.tolist()
    future_days = pd.date_range(s.index[-1] + pd.Timedelta(days=1), periods=HORIZON, freq="D")
    future = []
    for i, day in enumerate(future_days):
        y = max(0.0, float(model.predict([_features(np.array(history), len(series) + i, day.day_of_week)])[0]))
        future.append(y)
        history.append(y)

    net = model.named_steps["mlpregressor"]
    frame = (
        pd.concat(
            [
                pd.DataFrame({"day": s.index[-60:].strftime("%Y-%m-%d"), "actual": series[-60:].round(1)}),
                pd.DataFrame({"day": s.index[split:].strftime("%Y-%m-%d"), "backtest": np.round(test_pred, 1)}),
                pd.DataFrame({"day": future_days.strftime("%Y-%m-%d"), "forecast": np.round(future, 1)}),
            ]
        )
        .groupby("day", as_index=False)
        .first()
    )
    better = mae < naive_mae
    return {
        "ready": True,
        "model": f"Neural network (MLP {'-'.join(map(str, net.hidden_layer_sizes))}, ReLU, Adam), {net.n_iter_} epochs",
        "features": f"{LAGS} lag days, 7-day average, day of week",
        "metrics": {
            "mae": round(mae, 2),
            "naive_mae": round(naive_mae, 2),
            "improvement": round(1 - mae / naive_mae, 3) if naive_mae else None,
            "test_days": HORIZON,
            "train_days": int(split - LAGS),
        },
        "summary": (
            f"On the last {HORIZON} days (held out), the network's forecasts were off by {mae:.1f} units/day on average, "
            + (f"{1 - mae / naive_mae:.0%} better than" if better and naive_mae else "not better than")
            + f" the 'same as last week' baseline ({naive_mae:.1f}). Next {HORIZON} days: about {sum(future):,.0f} units."
        ),
        "forecast": [{"day": d.strftime("%Y-%m-%d"), "units": round(v, 1)} for d, v in zip(future_days, future, strict=True)],
        "chart": chart(
            "line", "Units sold: actual, backtest and 14-day neural-network forecast", frame, "day", ["actual", "backtest", "forecast"]
        ),
    }
