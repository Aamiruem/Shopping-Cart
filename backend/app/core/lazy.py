"""Deferred imports, so the API starts fast and stays small on machines that never use the analytics.

pandas, NumPy and scikit-learn add ~3 s and ~150 MB to startup; with lazy_import they load the first time
a seller dashboard, recommendation or support-ticket endpoint actually needs them.
"""

import importlib.util
import sys
from types import ModuleType


def lazy_import(name: str) -> ModuleType:
    """Returns the module `name`, executed only on first attribute access (stdlib importlib.util.LazyLoader)."""
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.find_spec(name)
    if spec is None or spec.loader is None:
        raise ModuleNotFoundError(f"No module named {name!r}", name=name)
    spec.loader = importlib.util.LazyLoader(spec.loader)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module
