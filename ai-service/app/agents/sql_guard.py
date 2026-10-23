"""Validates SQL written by the data analyst agent before it runs.

The SQL is parsed into a syntax tree (sqlglot, PostgreSQL dialect) and rejected unless it is exactly one
read-only SELECT over the reporting views, using only allow-listed functions. The query that is executed is
regenerated from the checked tree, so what runs is precisely what was checked (comments and tricks dropped).

This is one layer of several: the database session is also READ ONLY, time-limited, and its search_path
contains only the views (see db/postgres.py).
"""

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError

ALLOWED_TABLES = {"orders", "order_items", "customers", "sellers", "support_tickets"}

# Functions sqlglot doesn't model as specific expressions arrive as exp.Anonymous: only these are allowed.
# Notably absent: set_config / current_setting (would lift the seller scope), pg_* system functions,
# dblink, lo_* (large objects), query_to_xml and friends.
SAFE_FUNCTIONS = {
    "to_char", "date_part", "date_trunc", "extract", "percentile_cont", "percentile_disc", "mode", "width_bucket",
    "greatest", "least", "nullif", "coalesce", "round", "ceil", "ceiling", "floor", "abs", "sign", "sqrt", "power",
    "ln", "log", "exp", "stddev", "stddev_samp", "stddev_pop", "variance", "var_samp", "var_pop", "corr",
    "covar_pop", "covar_samp", "regr_slope", "regr_intercept", "regr_r2", "string_agg", "array_agg", "bool_and",
    "bool_or", "every", "count", "sum", "avg", "min", "max", "lower", "upper", "initcap", "length", "trim",
    "substring", "split_part", "concat", "replace", "left", "right", "make_interval", "age", "now",
    "rank", "dense_rank", "row_number", "ntile", "lag", "lead", "first_value", "last_value", "cume_dist",
    "percent_rank", "generate_series", "to_date", "date", "justify_interval", "isodow",
}
# Statement and expression types that never belong in a read-only report
FORBIDDEN = (
    exp.Insert, exp.Update, exp.Delete, exp.Merge, exp.Create, exp.Drop, exp.Alter, exp.Command,
    exp.TruncateTable, exp.Into, exp.Lock, exp.Set, exp.Copy, exp.Grant,
)  # fmt: skip
# Built-ins that reveal server details (version(), current_user, current_database()...); dates stay allowed
SAFE_CURRENT = {"current_date", "current_time", "current_timestamp", "current_datetime"}
# Bare keywords Postgres answers with the login name although they parse as column references
IDENTITY_KEYWORDS = {"user", "current_user", "current_role", "session_user", "current_catalog", "current_schema"}


class UnsafeSQL(ValueError):
    """The query was rejected; the message explains why, so the model can fix it."""


def _function_name(node: exp.Func) -> str:
    return (node.name if isinstance(node, exp.Anonymous) else node.sql_name()).lower()


def validate(sql: str) -> str:
    """Returns the safe, normalised SQL to execute, or raises UnsafeSQL."""
    try:
        statements = [s for s in sqlglot.parse(sql, read="postgres") if s is not None]
    except ParseError as e:
        raise UnsafeSQL(f"SQL syntax error: {str(e).splitlines()[0]}") from None
    if len(statements) != 1:
        raise UnsafeSQL("Send exactly one SELECT statement")
    tree = statements[0]
    if not isinstance(tree, exp.Query):
        raise UnsafeSQL("Only SELECT queries are allowed")

    for node in tree.walk():
        if isinstance(node, FORBIDDEN):
            raise UnsafeSQL(f"{node.key.upper()} is not allowed - this is a read-only report")
        if isinstance(node, exp.Anonymous) and _function_name(node) not in SAFE_FUNCTIONS:
            raise UnsafeSQL(f"Function {node.name}() is not allowed")
        if isinstance(node, exp.Func):
            name = _function_name(node)
            if name.startswith(("pg_", "set_config", "dblink", "lo_")) or name == "session_user" or (
                name.startswith("current_") and name not in SAFE_CURRENT
            ):
                raise UnsafeSQL(f"Function {name}() is not allowed")
        if isinstance(node, exp.Column) and not node.table and node.name.lower() in IDENTITY_KEYWORDS:
            raise UnsafeSQL(f"{node.name} is not available in reports")

    ctes = {cte.alias_or_name.lower() for cte in tree.find_all(exp.CTE)}
    for table in tree.find_all(exp.Table):
        if not table.name:  # e.g. generate_series(...) used as a table source
            continue
        if table.db or table.catalog:
            raise UnsafeSQL(f"Use the view name alone, not {table.sql(dialect='postgres')}")
        name = table.name.lower()
        if name not in ALLOWED_TABLES and name not in ctes:
            raise UnsafeSQL(f"Unknown table {table.name!r}. Available: {', '.join(sorted(ALLOWED_TABLES))}")
    return tree.sql(dialect="postgres")
