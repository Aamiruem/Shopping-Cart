# Veyra: full-stack marketplace with analytics and machine learning

Veyra is a multi-seller marketplace in the style of the big Indian e-commerce sites: a React storefront,
a Python (FastAPI) API on PostgreSQL + MongoDB, a seller hub with product management, and a layer of
analytics and machine learning that helps sellers sell more and helps shoppers get faster support.

**Veyra is a working name**; check trademark, company-name and domain availability before launch.

| Layer | Tech | Folder |
|---|---|---|
| Storefront & seller hub | React 18, Vite, React Router, Recharts | `frontend/` |
| API | Python 3.12, FastAPI, asyncpg, PyMongo (async), JWT, bcrypt | `backend/` |
| Analytics & ML | pandas, NumPy, scikit-learn | `backend/app/ml/` |
| AI assistant | FastAPI + Claude: RAG Q&A and a tool-using shopping agent | `ai-service/` |
| Databases | PostgreSQL (users, sellers, orders, tickets) + MongoDB (catalog, carts, wishlists, behaviour events) | `backend/app/db/` |
| Deploy | Docker Compose locally; AWS (CloudFront, S3, ECS Fargate, ALB, RDS, Secrets Manager) | `docker-compose.yml`, `infra/aws/` |
| CI | GitHub Actions: lint, tests against real databases, build, template check | `.github/workflows/ci.yml` |
| Previous API | The original Node/Express backend, kept for reference only | `backend-node/` |

## Features

**Shoppers:** search with suggestions, filters and sorting, product pages with gallery, cart, wishlist,
saved addresses, 4-step checkout (UPI and card payments confirmed with an emailed OTP, or cash on
delivery), orders and cancellation, Google sign-in, AI chat assistant, and a help centre where support
tickets are triaged by ML.

**Sellers (Seller Hub at `/seller`):** onboarding (store name, GSTIN), product CRUD with image upload
(S3 or local), inline price/stock edits, list/unlist, orders containing their products, CSV exports,
and the analytics & AI dashboard. **Admins** see the whole marketplace and can filter by store.

## Analytics and machine learning

Every model is trained on the shop's own data and shows how well it performs, measured on data it did not see.

| Where | What it does | How |
|---|---|---|
| Dashboard → Overview | KPIs with period-over-period change, revenue trend, category mix, weekday × hour heatmap, conversion funnel, new vs returning, order-value distribution, payment mix, cities, top products | pandas aggregations |
| Dashboard → Sales forecast | Revenue for the next 30 days with a 95% range | Huber regression on trend + weekday + monthly cycle, recent days weighted more; validated on the last 28 days against "same weekday last week" |
| Dashboard → Best-seller prediction | Which products will sell most next month, what is trending up, what to restock, what drives sales | Gradient-boosted trees on sales, momentum, views, add-to-carts, conversion, price, discount and rating; time-based validation, R² and top-10 hit rate |
| Dashboard → Customers & churn | RFM segments (Champions, Loyal, Needs attention, At risk) with advice, churn probability per customer, win-back list, cohort retention | K-Means on RFM; random forest for churn (AUC, precision, recall); cohort matrix |
| Dashboard → Support (admin) | Ticket topics, sentiment, volume, resolution time, prioritised queue | — |
| Home → "Recommended for you" | Personalised picks with the reason shown ("Because you looked at …") | Item-to-item collaborative filtering on views / add-to-carts / purchases |
| Product page → "Frequently bought together" | Products that appear in the same orders | Co-occurrence with lift; falls back to "customers also viewed" |
| Help → Contact support | Routes the ticket to the right team, sets urgency, gives an instant answer | TF-IDF + logistic regression classifier (5-fold cross-validated), negation-aware sentiment, urgency rules, RAG answer from the AI service |

The analysis is also available as CSV (`/api/analytics/export`) for Excel, pandas or Power BI.

## Project structure

```text
backend/
  app/
    main.py              FastAPI app, routers, error handling, static uploads
    core/                settings, JWT + bcrypt, errors, rate limiting
    db/                  asyncpg pool + schema.sql (idempotent), MongoDB client + indexes
    routers/             auth, products, cart, wishlist, addresses, orders, seller, analytics,
                         recommendations, support, ai (proxy)
    services/            validation, cart pricing, OTP, email, S3/local image storage, behaviour events
    ml/                  data loading, forecasting, bestsellers, customers (RFM, churn, cohorts),
                         recommender, support triage, overview analytics, model cache
    schemas/             request validation (Pydantic)
    data/products.json   184-product demo catalog
  scripts/seed.py        catalog, demo accounts, sellers and 6 months of simulated history
  tests/                 ML unit tests (no database) + API integration tests
frontend/src/
  pages/                 store pages + pages/seller (layout, onboarding, dashboard, products, orders)
  components/            layout, product, cart, checkout, account, seller, chat, charts, analytics tabs
  context/ hooks/ utils/ styles/
ai-service/              RAG, agent, content-based recommendations (unchanged API)
infra/aws/               cloudformation.yml, deploy.sh, seed.sh, guide
```

## Run locally with Docker

```bash
cp .env.example .env                 # optionally add ANTHROPIC_API_KEY, GOOGLE_CLIENT_ID, SMTP_*
docker compose up --build
docker compose exec backend python -m scripts.seed
```

Open http://localhost:8080. API docs: http://localhost:5000/docs.

## Run locally without Docker

Needs Python 3.12, Node 20+, PostgreSQL and MongoDB.

```bash
# API (http://localhost:5000, docs at /docs)
cd backend
python -m venv .venv && .venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                                      # set DATABASE_URL to your PostgreSQL user/password
python -m scripts.seed
uvicorn app.main:app --reload --port 5000

# Storefront (http://localhost:5173)
cd frontend && npm install && npm run dev

# AI assistant (optional)
cd ai-service && python -m venv .venv && .venv\Scripts\activate && pip install -r requirements.txt
uvicorn app.main:app --port 8100                         # 8100: port 8000 is often used by other local apps
```

### Demo accounts (created by the seed)

| Role | Email | Password |
|---|---|---|
| Shopper (has history, so recommendations are personalised) | demo@shop.local | demo123 |
| Seller: TechHub Retail (mobiles, electronics) | seller@shop.local | seller123 |
| Seller: StyleStreet / HomeNest / DailyFresh & Sports | style@ / home@ / fresh@shop.local | seller123 |
| Admin (whole marketplace + support queue) | admin@shop.local | admin123 |

The seed also creates 650 simulated shoppers, ~2,800 orders, ~30,000 behaviour events and 320 support
tickets over 180 days. Simulated data is marked and is replaced on every re-run; real orders are never touched.
`python -m scripts.seed --no-history` gives a clean store.

## Tests

```bash
cd backend && pytest                              # ML unit tests (API tests skip without databases)
TEST_DATABASE_URL=postgres://... TEST_MONGO_URI=mongodb://localhost:27017/shop_test pytest   # everything
ruff check . && ruff format --check .
cd ai-service && pytest
```

## API overview

Full interactive docs at `/docs`. Errors always come back as `{"error": "message"}`.

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/register`, `/login`, `/google` · `GET/PUT /api/auth/me` · `PUT /api/auth/password` · `GET /api/auth/config` |
| Catalog | `GET /api/products` (q, category, brand, minPrice, maxPrice, minRating, sort) · `/categories` · `/facets` · `/{id}` |
| Shopping | `/api/cart` · `/api/wishlist` · `/api/addresses` · `POST /api/orders/otp` · `/api/orders` · `PATCH /api/orders/{id}/cancel` |
| Seller | `POST /api/seller/register` · `GET/POST /api/seller/products` · `PUT/PATCH/DELETE /api/seller/products/{id}` · `POST /api/seller/uploads` · `GET /api/seller/orders` |
| Analytics | `GET /api/analytics/overview` · `/forecast` · `/bestsellers` · `/customers` · `/support` · `/export` · `POST /retrain` |
| Recommendations | `GET /api/recommendations/for-you` · `/together/{productId}` · `/trending` |
| Support | `POST/GET /api/support/tickets` · `PATCH /api/support/tickets/{id}` |
| AI assistant | `POST /api/ai/ask` · `POST /api/ai/agent` · `GET /api/ai/recommend/{id}` |

## Deploy to AWS

See [infra/aws/README.md](infra/aws/README.md): one CloudFormation stack, `deploy.sh` to build and release,
`seed.sh` for demo data. About US$65/month at low traffic.

## Next steps

Real payments (Razorpay or Stripe) for UPI and card; product reviews feeding the rating and sentiment
models; a Redis cache shared between API replicas; embeddings-based search.
