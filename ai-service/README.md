# Arvixa AI service

The AI and data-science half of Arvixa: a FastAPI service the backend calls for recommendations, RAG answers,
two AI agents, statistics and a neural-network forecast. Sellers see it in **Seller Hub -> Analytics -> AI insights**.

```
ai-service/
├── app/
│   ├── main.py              FastAPI app: health check + the routers below
│   ├── core/                config.py (settings from env) · security.py (JWT login check, seller scope)
│   ├── llm/                 client.py - Claude (Anthropic SDK): adaptive thinking, prompt caching,
│   │                        structured outputs, refusal fallbacks
│   ├── rag/                 Retrieval-augmented generation
│   │   ├── documents.py       catalog + knowledge/*.md -> chunked, citable passages
│   │   ├── retriever.py       hybrid search: TF-IDF + dense (LSA) embeddings, Reciprocal Rank Fusion
│   │   └── pipeline.py        retrieve -> Claude answers with [n] citations
│   ├── agents/              Agentic AI (Claude tool use, manual loop)
│   │   ├── shopping.py        shopping assistant: search, recommend, policies, view / add to cart
│   │   ├── analyst.py         data analyst: question -> SQL -> pandas -> answer + chart (self-correcting)
│   │   └── sql_guard.py       parses every generated query (sqlglot) and allows only safe SELECTs
│   ├── db/                  SQL layer
│   │   ├── postgres.py        read-only, time-limited, seller-scoped PostgreSQL sessions -> DataFrames
│   │   └── queries.py         hand-written parameterised SQL + the analyst's no-API-key templates
│   ├── analytics/           Data analysis & visualisation
│   │   ├── statistics.py      EDA, confidence intervals, hypothesis tests, regression, correlation
│   │   └── charts.py          chart specs (JSON) the storefront draws with Recharts; ₹ formatting
│   ├── ml/                  Machine learning: recommender.py (TF-IDF + cosine), registry.py (model cache)
│   ├── dl/                  Deep learning: demand_net.py (neural-network demand forecaster)
│   ├── services/            catalog.py (products from the backend API) · listing.py (AI listing writer)
│   └── api/                 schemas.py (request validation) · routes/ (catalog, agents, analytics, content)
├── knowledge/               store policies used by RAG
├── tests/                   60 tests - no database or API key needed
├── Dockerfile               non-root image; runs the tests during the build; health check
└── pyproject.toml           pytest + ruff settings
```

## Where each technology is used

| Skill | In this service |
|---|---|
| **Python** | the whole service: typed, small modules, dataclasses, context managers |
| **SQL** | `db/queries.py` (joins, aggregates, `date_trunc`, `make_interval`; the analyst also writes CTEs and window functions); the analyst writes its own SQL; `backend/app/db/schema.sql` defines the reporting views |
| **NumPy** | `rag/retriever.py` (vector maths, rank fusion), `analytics/statistics.py` (bootstrap resampling, histograms), `dl/demand_net.py` (feature windows) |
| **pandas** | `db/postgres.py` returns DataFrames; grouping, pivots, rolling averages, resampling to daily series |
| **Statistics** | `analytics/statistics.py`: t and bootstrap confidence intervals, Welch's t-test, Kruskal-Wallis, Mann-Whitney U, chi-square + Cramér's V, Spearman correlation, OLS trend, log-log elasticity, Tukey outliers, effect sizes |
| **Machine learning** | `ml/recommender.py` (content-based), `rag/retriever.py` (TF-IDF, truncated SVD embeddings) - plus the backend's forecasting, churn, segmentation and best-seller models |
| **Deep learning** | `dl/demand_net.py`: a multilayer perceptron (2 hidden ReLU layers, Adam, early stopping) with a held-out backtest against a seasonal-naive baseline |
| **LLMs** | `llm/client.py` (Claude Opus 5.5): RAG answers, the listing writer (structured JSON output), both agents |
| **RAG** | `rag/`: chunking -> hybrid retrieval -> grounded, cited generation |
| **Agentic AI** | `agents/shopping.py` and `agents/analyst.py`: Claude chooses tools, sees their results (including errors) and loops until it can answer |
| **FastAPI** | `main.py`, `api/routes/*`, pydantic request models, dependency-injected auth |
| **PostgreSQL** | read-only reporting views, `READ ONLY` transactions, `statement_timeout`, session settings for row-level seller scoping |
| **Authentication** | `core/security.py`: verifies the backend's HS256 JWTs; sellers can only ever see their own data |
| **Docker** | `Dockerfile` (tests in the build, non-root user, health check) · `docker-compose.yml` at the repo root |
| **Cloud** | `infra/aws/cloudformation.yml`: ECS Fargate task with RDS access and secrets from AWS Secrets Manager |
| **Data visualisation** | `analytics/charts.py` (specs) + `frontend/src/components/charts/SpecChart.jsx` (rendering) |

## Run it

```bash
cd ai-service
python -m venv .venv && .venv\Scripts\activate        # macOS / Linux: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env    # set DATABASE_URL, PG_SCHEMA and JWT_SECRET to the same values as backend/.env
uvicorn app.main:app --port 8100                     # docs: http://localhost:8100/docs
pytest                                               # 60 tests, no database or API key needed
```

`ANTHROPIC_API_KEY` is optional. Without it RAG returns the best passage, the analyst answers from built-in
report templates, the listing writer uses a template and only the shopping assistant is unavailable.

## Endpoints

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/health` | anyone | status, whether the LLM and analytics are configured |
| GET | `/recommend/{id}` · POST `/recommend/cart` | anyone | similar products / cart suggestions |
| POST | `/rag/ask` | anyone | store-policy and product Q&A with sources |
| POST | `/listing/generate` | via backend (sellers) | SEO title, description, highlights, tags |
| POST | `/agent/chat` | logged-in shopper | shopping assistant that can manage the shopper's cart |
| GET | `/analyst/suggestions` · POST `/analyst/ask` | seller / admin | ask-your-data: answer, SQL, table, chart |
| GET | `/analytics/insights?days=90` | seller / admin | EDA + statistical tests with charts |
| GET | `/analytics/forecast` | seller / admin | 14-day neural-network forecast with backtest |

Admins may add `sellerId` to see one store; sellers always see only their own sales.

## How the data analyst stays safe

An LLM writing SQL against a production database needs several independent guards - any one of them failing
still leaves the others:

1. **Views, not tables.** It queries five reporting views (`<PG_SCHEMA>_analytics`) with no names, emails, phones,
   passwords, bank details or codes. The session's `search_path` contains only those views.
2. **Parsed and allow-listed.** `sql_guard.py` parses each query: exactly one `SELECT`, only those views, only
   allow-listed functions (`set_config`, `pg_*`, `dblink`, `version()`... are rejected). The SQL that runs is
   regenerated from the checked syntax tree.
3. **Read-only and time-limited.** `SET TRANSACTION READ ONLY` and a `statement_timeout` (5 s), at most 500 rows.
4. **Seller scope.** The session sets `arvixa.seller_id` before any query; the views then return only that
   seller's rows, and the guard blocks the functions that could change it.

For defence in depth in production, also connect the AI service as a PostgreSQL role that can only `SELECT`
from the analytics schema (`GRANT USAGE ON SCHEMA ... ; GRANT SELECT ON ALL TABLES IN SCHEMA ...`).
