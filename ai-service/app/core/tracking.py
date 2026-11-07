"""Experiment tracking with MLflow: every training run records its settings and test scores.

Set MLFLOW_TRACKING_URI to turn it on. Tracking must never break a forecast, so any MLflow failure is only logged.
"""

import logging
import os
from collections.abc import Callable, Iterator
from contextlib import contextmanager

from .optional import has

log = logging.getLogger("tracking")
EXPERIMENT = "arvixa-store"


def _no_op(_: dict) -> None:
    return None


@contextmanager
def tracked_run(name: str, params: dict | None = None) -> Iterator[Callable[[dict], None]]:
    """with tracked_run("demand-lstm", {"lags": 14}) as log_metrics: ...; log_metrics({"mae": 1.2})"""
    uri = os.getenv("MLFLOW_TRACKING_URI", "")
    if not uri or not has("mlflow"):
        yield _no_op
        return

    import mlflow

    try:
        mlflow.set_tracking_uri(uri)
        mlflow.set_experiment(EXPERIMENT)
        run = mlflow.start_run(run_name=name)
        mlflow.log_params(params or {})
    except Exception:
        log.exception("MLflow is unavailable; training continues without tracking")
        yield _no_op
        return

    def log_metrics(metrics: dict) -> None:
        try:
            mlflow.log_metrics({k: float(v) for k, v in metrics.items() if v is not None})
        except Exception:
            log.exception("could not log metrics to MLflow")

    with run:
        yield log_metrics
