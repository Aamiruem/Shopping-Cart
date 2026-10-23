"""The data analyst's SQL guard: normal analytics SQL passes, anything that could write, escape the reporting
views, lift the seller scope or reveal server details is rejected."""

import pytest

from app.agents.sql_guard import UnsafeSQL, validate

ALLOWED = [
    "SELECT category, SUM(line_total) FROM order_items GROUP BY 1",
    "WITH m AS (SELECT date_trunc('month', created_at) AS m, SUM(total) t FROM orders GROUP BY 1) "
    "SELECT m, t, lag(t) OVER (ORDER BY m) FROM m",
    "SELECT city FROM customers UNION SELECT store_name FROM sellers",
    "SELECT to_char(created_at,'YYYY-MM'), percentile_cont(0.5) WITHIN GROUP (ORDER BY total) FROM orders GROUP BY 1",
    "SELECT EXTRACT(ISODOW FROM created_at), COUNT(*) FROM orders WHERE created_at >= now() - interval '30 days' GROUP BY 1",
    "SELECT CASE WHEN total > 1000 THEN 'big' ELSE 'small' END AS size, COUNT(*) FROM orders GROUP BY 1",
    "SELECT c.city, COUNT(*) FROM orders o JOIN customers c ON c.id = o.customer_id "
    "WHERE o.total > (SELECT AVG(total) FROM orders) GROUP BY 1",
    "SELECT COUNT(*) FROM orders WHERE created_at::date = current_date",
]

REJECTED = [
    "SELECT email, password_hash FROM users",  # raw table
    'SELECT * FROM "users"',
    "SELECT * FROM shop.users",  # schema-qualified
    "SELECT * FROM public.users",
    "SELECT * FROM information_schema.tables",
    "SELECT * FROM pg_catalog.pg_user",
    "SELECT * FROM pg_user",
    "WITH x AS (SELECT * FROM users) SELECT * FROM x",
    "SELECT set_config('arvixa.seller_id', '', true), * FROM orders",  # lifting the seller scope
    "SELECT current_setting('arvixa.seller_id')",
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT pg_sleep(100)",
    "SELECT * FROM dblink('host=x', 'select 1') AS t(a int)",
    "SELECT lo_import('/etc/passwd')",
    "SELECT query_to_xml('select * from users', true, true, '')",
    "SELECT version()",  # server details
    "SELECT current_user",
    "SELECT session_user",
    "SELECT current_database()",
    "SELECT user",
    "SELECT inet_server_addr()",
    "SELECT 1 FROM orders; DROP TABLE orders",  # writes and multiple statements
    "DELETE FROM orders",
    "WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d",
    "SELECT * INTO copy_of_orders FROM orders",
    "SELECT * FROM orders FOR UPDATE",
    "COPY orders TO '/tmp/x'",
    "SET search_path TO shop",
    "SELEC nonsense",
]


@pytest.mark.parametrize("sql", ALLOWED)
def test_allows_analytics_sql(sql):
    assert validate(sql).upper().startswith(("SELECT", "WITH"))


@pytest.mark.parametrize("sql", REJECTED)
def test_rejects_unsafe_sql(sql):
    with pytest.raises(UnsafeSQL):
        validate(sql)


def test_executes_the_regenerated_query_not_the_original_text():
    assert "--" not in validate("SELECT COUNT(*) FROM orders -- ; DROP TABLE orders")
