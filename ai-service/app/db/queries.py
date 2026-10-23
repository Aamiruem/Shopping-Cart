"""Hand-written, parameterised SQL over the reporting views (see backend/app/db/schema.sql).

Used by the statistics and forecasting modules, and by the data analyst when no LLM is configured.
Dates are local (the session TimeZone is set to Asia/Kolkata), cancelled orders are excluded.
"""

# One row per order with the buyer's city: order value analysis and hypothesis tests
ORDERS = """
SELECT o.id, o.total, o.payment_method, o.source, o.created_at, c.city,
       EXTRACT(ISODOW FROM o.created_at)::int AS weekday
  FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
 WHERE o.status <> 'cancelled' AND o.created_at >= now() - make_interval(days => %(days)s)
"""

# Daily revenue / units / orders, per category
DAILY_SALES = """
SELECT ordered_at::date AS day, category, SUM(line_total) AS revenue, SUM(qty) AS units,
       COUNT(DISTINCT order_id) AS orders
  FROM order_items
 WHERE order_status <> 'cancelled' AND ordered_at >= now() - make_interval(days => %(days)s)
 GROUP BY 1, 2
 ORDER BY 1, 2
"""

# One row per product: price vs demand
PRODUCT_SALES = """
SELECT product_id, MAX(product_name) AS product_name, MAX(category) AS category, AVG(price) AS price,
       SUM(qty) AS units, SUM(line_total) AS revenue, COUNT(DISTINCT order_id) AS orders
  FROM order_items
 WHERE order_status <> 'cancelled' AND ordered_at >= now() - make_interval(days => %(days)s)
 GROUP BY product_id
"""

# Category x buyer city, for the chi-square test of independence
CATEGORY_CITY = """
SELECT i.category, c.city, SUM(i.qty) AS units
  FROM order_items i JOIN orders o ON o.id = i.order_id JOIN customers c ON c.id = o.customer_id
 WHERE i.order_status <> 'cancelled' AND c.city IS NOT NULL AND i.ordered_at >= now() - make_interval(days => %(days)s)
 GROUP BY 1, 2
"""

# Questions the analyst can answer without an LLM: (keywords, title, sql, chart: type, x, y)
TEMPLATES = [
    (
        {"category", "categories", "department"},
        "Revenue by category (last 90 days)",
        """SELECT category, ROUND(SUM(line_total)) AS revenue, SUM(qty) AS units
             FROM order_items WHERE order_status <> 'cancelled' AND ordered_at >= now() - interval '90 days'
            GROUP BY category ORDER BY revenue DESC""",
        ("bar", "category", ["revenue"]),
    ),
    (
        {"top", "best", "selling", "bestseller", "bestsellers", "products", "product"},
        "Top 10 products by revenue (last 90 days)",
        """SELECT product_name, ROUND(SUM(line_total)) AS revenue, SUM(qty) AS units
             FROM order_items WHERE order_status <> 'cancelled' AND ordered_at >= now() - interval '90 days'
            GROUP BY product_name ORDER BY revenue DESC LIMIT 10""",
        ("bar", "product_name", ["revenue"]),
    ),
    (
        {"daily", "trend", "day", "days", "over", "time", "growth"},
        "Daily revenue (last 60 days)",
        """SELECT ordered_at::date AS day, ROUND(SUM(line_total)) AS revenue, COUNT(DISTINCT order_id) AS orders
             FROM order_items WHERE order_status <> 'cancelled' AND ordered_at >= now() - interval '60 days'
            GROUP BY 1 ORDER BY 1""",
        ("line", "day", ["revenue"]),
    ),
    (
        {"monthly", "month", "months", "aov", "average", "basket"},
        "Orders and average order value by month",
        """SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, COUNT(*) AS orders,
                  ROUND(AVG(total)) AS avg_order_value
             FROM orders WHERE status <> 'cancelled' GROUP BY 1 ORDER BY 1""",
        ("bar", "month", ["orders"]),
    ),
    (
        {"payment", "payments", "upi", "cod", "card", "method", "methods"},
        "Orders by payment method (last 90 days)",
        """SELECT payment_method, COUNT(*) AS orders, ROUND(AVG(total)) AS avg_order_value
             FROM orders WHERE status <> 'cancelled' AND created_at >= now() - interval '90 days'
            GROUP BY 1 ORDER BY orders DESC""",
        ("pie", "payment_method", ["orders"]),
    ),
    (
        {"city", "cities", "where", "location", "region"},
        "Revenue by buyer city (last 90 days)",
        """SELECT c.city, ROUND(SUM(o.total)) AS revenue, COUNT(*) AS orders
             FROM orders o JOIN customers c ON c.id = o.customer_id
            WHERE o.status <> 'cancelled' AND c.city IS NOT NULL AND o.created_at >= now() - interval '90 days'
            GROUP BY c.city ORDER BY revenue DESC LIMIT 12""",
        ("bar", "city", ["revenue"]),
    ),
    (
        {"weekday", "weekend", "week", "busiest", "monday", "sunday"},
        "Orders by day of week (last 90 days)",
        """SELECT to_char(created_at, 'Dy') AS weekday, EXTRACT(ISODOW FROM created_at)::int AS n,
                  COUNT(*) AS orders, ROUND(SUM(total)) AS revenue
             FROM orders WHERE status <> 'cancelled' AND created_at >= now() - interval '90 days'
            GROUP BY 1, 2 ORDER BY 2""",
        ("bar", "weekday", ["orders"]),
    ),
    (
        {"customers", "customer", "repeat", "loyal", "buyers"},
        "Customers by number of orders",
        """SELECT CASE WHEN n = 1 THEN '1 order' WHEN n <= 3 THEN '2-3 orders' WHEN n <= 6 THEN '4-6 orders'
                       ELSE '7+ orders' END AS segment, COUNT(*) AS customers
             FROM (SELECT customer_id, COUNT(*) AS n FROM orders WHERE status <> 'cancelled' GROUP BY 1) t
            GROUP BY 1 ORDER BY MIN(n)""",
        ("bar", "segment", ["customers"]),
    ),
    (
        {"support", "tickets", "ticket", "complaints", "complaint"},
        "Support tickets by category",
        """SELECT category, COUNT(*) AS tickets, ROUND(AVG(sentiment)::numeric, 2) AS avg_sentiment
             FROM support_tickets GROUP BY 1 ORDER BY tickets DESC""",
        ("bar", "category", ["tickets"]),
    ),
]
