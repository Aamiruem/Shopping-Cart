"""End-to-end API tests against real databases.

Point them at throwaway databases (they create users, products and orders):

    TEST_DATABASE_URL=postgres://... TEST_MONGO_URI=mongodb://localhost:27017/shop_test pytest tests/test_api.py

Skipped automatically when those variables are not set.
"""

import os
import time

import pytest

pytestmark = pytest.mark.skipif(
    not (os.getenv("TEST_DATABASE_URL") and os.getenv("TEST_MONGO_URI")),
    reason="set TEST_DATABASE_URL and TEST_MONGO_URI to run API tests",
)

PASSWORD = "secret123"


@pytest.fixture(scope="module")
def client():
    os.environ.update(
        DATABASE_URL=os.environ["TEST_DATABASE_URL"],
        MONGO_URI=os.environ["TEST_MONGO_URI"],
        PG_STATEMENT_CACHE_SIZE=os.getenv("TEST_PG_STATEMENT_CACHE_SIZE", "100"),
        SMTP_HOST="",
        AI_SERVICE_URL="http://127.0.0.1:9",  # unreachable on purpose: features must degrade gracefully
    )
    from fastapi.testclient import TestClient

    from app.core.config import get_settings

    get_settings.cache_clear()
    from app.main import create_app

    with TestClient(create_app()) as test_client:
        yield test_client


def _register(client, name="Test Shopper"):
    email = f"pytest{time.time_ns()}@gmail.com"
    r = client.post("/api/auth/register", json={"name": name, "email": email, "password": PASSWORD})
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}, email


def _seller(client):
    headers, _ = _register(client, "Pytest Seller")
    r = client.post("/api/seller/register", json={"storeName": f"Pytest Store {time.time_ns()}"}, headers=headers)
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_health(client):
    assert client.get("/api/health").json() == {"ok": True}


def test_register_validates_input(client):
    r = client.post("/api/auth/register", json={"name": "A", "email": "a@b.co", "password": PASSWORD})
    assert r.status_code == 400 and "name" in r.json()["error"]
    r = client.post("/api/auth/register", json={"name": "Asha", "email": "asha@gmail.com", "password": "password"})
    assert r.status_code == 400 and "number" in r.json()["error"]


def test_login_and_profile(client):
    _, email = _register(client)
    r = client.post("/api/auth/login", json={"email": email.upper(), "password": PASSWORD})
    assert r.status_code == 200
    headers = {"Authorization": f"Bearer {r.json()['token']}"}
    assert client.get("/api/auth/me", headers=headers).json()["email"] == email
    assert client.post("/api/auth/login", json={"email": email, "password": "wrong-pass1"}).status_code == 401
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_seller_crud_and_checkout_flow(client):
    seller = _seller(client)
    other_seller = _seller(client)
    product = {"name": "Pytest Speaker", "category": "electronics", "brand": "Veyra", "price": 1999, "mrp": 2499, "stock": 5}

    # Create (seller) -> visible in the public catalog
    r = client.post("/api/seller/products", json=product, headers=seller)
    assert r.status_code == 201, r.text
    pid = r.json()["_id"]
    assert r.json()["discount"] == 20
    assert client.get(f"/api/products/{pid}").status_code == 200

    # Ownership is enforced
    assert client.put(f"/api/seller/products/{pid}", json={**product, "price": 1}, headers=other_seller).status_code == 403
    customer, _ = _register(client)
    assert client.get("/api/seller/products", headers=customer).status_code == 403

    # Shopper buys it with cash on delivery
    assert client.post("/api/cart", json={"productId": pid, "qty": 2}, headers=customer).json()["subtotal"] == 3998
    address = client.post(
        "/api/addresses",
        json={"name": "Asha", "phone": "9876543210", "line1": "1 MG Road", "city": "Pune", "state": "Maharashtra", "pincode": "411001"},
        headers=customer,
    ).json()
    assert client.post("/api/orders", json={"addressId": address["id"], "paymentMethod": "upi"}, headers=customer).status_code == 400
    r = client.post("/api/orders", json={"addressId": address["id"], "paymentMethod": "cod"}, headers=customer)
    assert r.status_code == 201, r.text
    assert client.get(f"/api/products/{pid}").json()["stock"] == 3

    # The seller sees the order and it shows up in their analytics
    orders = client.get("/api/seller/orders", headers=seller).json()
    assert orders[0]["id"] == r.json()["id"] and float(orders[0]["amount"]) == 3998
    kpis = client.get("/api/analytics/overview?days=7", headers=seller).json()["kpis"]
    assert kpis["orders"] == 1 and kpis["revenue"] == 3998

    # Update and delete
    assert client.patch(f"/api/seller/products/{pid}", json={"active": False}, headers=seller).json()["active"] is False
    assert client.get(f"/api/products/{pid}").status_code == 404
    assert client.delete(f"/api/seller/products/{pid}", headers=seller).status_code == 204


def test_online_payment_needs_otp(client):
    customer, _ = _register(client)
    pid = client.get("/api/products?limit=1&sort=popularity").json()[0]["_id"]
    client.post("/api/cart", json={"productId": pid}, headers=customer)
    address = client.post(
        "/api/addresses",
        json={"name": "Asha", "phone": "9876543210", "line1": "1 MG Road", "city": "Pune", "state": "Maharashtra", "pincode": "411001"},
        headers=customer,
    ).json()
    code = client.post("/api/orders/otp", headers=customer).json()["devCode"]
    body = {"addressId": address["id"], "paymentMethod": "card"}
    assert client.post("/api/orders", json={**body, "otp": "000000" if code != "000000" else "111111"}, headers=customer).status_code == 400
    assert client.post("/api/orders", json={**body, "otp": code}, headers=customer).status_code == 201


def test_support_ticket_is_triaged(client):
    customer, _ = _register(client)
    r = client.post(
        "/api/support/tickets", json={"subject": "Refund", "message": "I returned the shoes 2 weeks ago, still no refund"}, headers=customer
    )
    assert r.status_code == 201
    assert r.json()["category"] == "returns" and r.json()["suggested_reply"]


def test_recommendations_work_for_guests(client):
    r = client.get("/api/recommendations/for-you")
    assert r.status_code == 200 and r.json()["strategy"] in ("trending", "personalised")
