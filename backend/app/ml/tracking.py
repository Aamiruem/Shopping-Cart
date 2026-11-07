"""MLflow experiment tracking for the backend's models. Set MLFLOW_TRACKING_URI to turn it on.

Tracking must never break a dashboard, so any MLflow failure is only logged.
"""

import importlib.util
import logging
import os
from collections.abc import Callable, Iterator
from contextlib import contextmanager

log = logging.getLogger("tracking")
EXPERIMENT = "arvixa-store"


def _no_op(_: dict) -> None:
    return None


@contextmanager
def tracked_run(name: str, params: dict | None = None) -> Iterator[Callable[[dict], None]]:
    uri = os.getenv("MLFLOW_TRACKING_URI", "")
    if not uri or importlib.util.find_spec("mlflow") is None:
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
