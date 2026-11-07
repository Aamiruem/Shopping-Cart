"""Real-money safety: stock, payments, returns and verified reviews, end to end against real databases.

Same setup as test_api.py: set TEST_DATABASE_URL and TEST_MONGO_URI, otherwise these skip.
"""

import asyncio
import json
import os

import pytest
from bson import ObjectId

from tests.test_api import _customer_with_cart, _register, _seller, _seller_product

pytestmark = pytest.mark.skipif(
    not (os.getenv("TEST_DATABASE_URL") and os.getenv("TEST_MONGO_URI")),
    reason="set TEST_DATABASE_URL and TEST_MONGO_URI to run API tests",
)


@pytest.fixture(autouse=True)
def _fresh_rate_limits():
    from app.core.rate_limit import reset_all

    reset_all()


@pytest.fixture
def gateway(monkeypatch):
    """A fake Razorpay: payments succeed unless a test says otherwise, and refunds are counted."""
    from app.core.config import get_settings
    from app.services import razorpay

    settings = get_settings()
    monkeypatch.setattr(settings, "razorpay_key_id", "rzp_test_x")
    monkeypatch.setattr(settings, "razorpay_key_secret", "secret")
    monkeypatch.setattr(settings, "razorpay_webhook_secret", "hook")
    state = {"refunds": 0, "captures": 0, "status": "captured", "refund_fails": False, "amount": None}

    async def create_order(amount, receipt, notes=None):
        state["amount"] = round(amount * 100)
        return {"id": f"order_{ObjectId()}", "amount": state["amount"], "currency": "INR"}

    async def fetch_payment(payment_id):
        return {"id": payment_id, "method": "upi", "status": state["status"], "amount": state["amount"]}

    async def capture(payment_id, amount):
        state["captures"] += 1

    async def refund(payment_id, amount=None):
        if state["refund_fails"]:
            from app.core.errors import ApiError

            raise ApiError(502, "gateway down")
        state["refunds"] += 1

    monkeypatch.setattr(razorpay, "create_order", create_order)
    monkeypatch.setattr(razorpay, "fetch_payment", fetch_payment)
    monkeypatch.setattr(razorpay, "capture", capture)
    monkeypatch.setattr(razorpay, "refund", refund)
    monkeypatch.setattr(razorpay, "verify_payment_signature", lambda *_: True)
    monkeypatch.setattr(razorpay, "verify_webhook_signature", lambda *_: True)
    return state


def _in_stock_product(client, min_price=1):
    products = client.get("/api/products?limit=50&sort=popularity").json()
    return next(p for p in products if p["stock"] >= 2 and p["price"] >= min_price)


def _cart_with_address(client, headers, product_id):
    assert client.post("/api/cart", json={"productId": product_id, "qty": 1}, headers=headers).status_code in (200, 201)
    address = {"name": "Test", "phone": "9876543210", "line1": "12 MG Road", "city": "Bengaluru", "state": "Karnataka", "pincode": "560001"}
    return client.post("/api/addresses", json=address, headers=headers).json()["id"]


def _start_payment(client, headers, address_id):
    r = client.post("/api/payments/razorpay/order", json={"addressId": address_id}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()["orderId"]


def _verify(client, headers, order_id, payment_id="pay_1"):
    body = {"razorpay_order_id": order_id, "razorpay_payment_id": payment_id, "razorpay_signature": "sig"}
    return client.post("/api/payments/razorpay/verify", json=body, headers=headers)


def _captured_event(order_id, amount):
    entity = {"id": "pay_hook", "order_id": order_id, "amount": amount, "method": "upi", "status": "captured"}
    return json.dumps({"event": "payment.captured", "payload": {"payment": {"entity": entity}}})


def _orders(client, headers):
    return client.get("/api/orders", headers=headers).json()


def test_verifying_twice_creates_one_order(client, gateway):
    headers, _ = _register(client)
    address_id = _cart_with_address(client, headers, _in_stock_product(client)["_id"])
    order_id = _start_payment(client, headers, address_id)
    first, second = _verify(client, headers, order_id), _verify(client, headers, order_id)
    assert first.status_code == 200, first.text
    assert second.json()["orderId"] == first.json()["orderId"]
    assert len(_orders(client, headers)) == 1
    assert _orders(client, headers)[0]["payment_status"] == "paid"
    assert client.get(f"/api/orders/{first.json()['orderId']}", headers=headers).json()["payment_status"] == "paid"


def test_closed_tab_after_paying_still_places_the_order(client, gateway):
    """The webhook does the shopper's work: the money was taken, so the order must exist."""
    headers, _ = _register(client)
    address_id = _cart_with_address(client, headers, _in_stock_product(client)["_id"])
    order_id = _start_payment(client, headers, address_id)
    r = client.post("/api/payments/razorpay/webhook", content=_captured_event(order_id, gateway["amount"]))
    assert r.status_code == 200, r.text
    assert len(_orders(client, headers)) == 1
    assert _verify(client, headers, order_id).status_code == 200  # the page coming back later changes nothing
    assert len(_orders(client, headers)) == 1


def test_authorised_payment_is_captured_before_the_order(client, gateway):
    gateway["status"] = "authorized"
    headers, _ = _register(client)
    address_id = _cart_with_address(client, headers, _in_stock_product(client)["_id"])
    assert _verify(client, headers, _start_payment(client, headers, address_id)).status_code == 200
    assert gateway["captures"] == 1


def test_unfinished_payment_places_no_order_and_can_be_retried(client, gateway):
    gateway["status"] = "failed"
    headers, _ = _register(client)
    address_id = _cart_with_address(client, headers, _in_stock_product(client)["_id"])
    order_id = _start_payment(client, headers, address_id)
    assert _verify(client, headers, order_id).status_code == 402
    assert _orders(client, headers) == []
    gateway["status"] = "captured"
    assert _verify(client, headers, order_id).status_code == 200


def test_sold_out_during_payment_refunds_automatically(client, gateway):
    from app.db import mongo

    headers, _ = _register(client)
    product = _in_stock_product(client)
    address_id = _cart_with_address(client, headers, product["_id"])
    order_id = _start_payment(client, headers, address_id)

    async def set_stock(value):
        await mongo.get_db().products.update_one({"_id": ObjectId(product["_id"])}, {"$set": {"stock": value}})

    client.portal.call(set_stock, 0)
    try:
        r = _verify(client, headers, order_id)
    finally:
        client.portal.call(set_stock, product["stock"])
    assert r.status_code == 409
    assert gateway["refunds"] == 1
    assert _orders(client, headers) == []


def test_failed_refund_is_recorded_not_lost(client, gateway):
    from app.db import postgres

    gateway["refund_fails"] = True
    headers, _ = _register(client)
    product = _in_stock_product(client)
    address_id = _cart_with_address(client, headers, product["_id"])
    order_id = _start_payment(client, headers, address_id)
    gateway["amount"] += 100  # the amount paid no longer matches the cart
    assert _verify(client, headers, order_id).status_code == 409

    async def status():
        return await postgres.get_pool().fetchval("SELECT status FROM payments WHERE provider_order_id = $1", order_id)

    assert client.portal.call(status) == "refund_pending"


def test_last_item_cannot_be_sold_twice(client):
    from app.db import mongo
    from app.services import orders

    product = _in_stock_product(client)
    oid = ObjectId(product["_id"])

    async def race():
        db = mongo.get_db()
        await db.products.update_one({"_id": oid}, {"$set": {"stock": 1}})
        line = {"product": {"_id": oid, "name": product["name"]}, "qty": 1}
        outcomes = await asyncio.gather(*[orders._reserve_stock([line]) for _ in range(5)], return_exceptions=True)
        stock = (await db.products.find_one({"_id": oid}))["stock"]
        await db.products.update_one({"_id": oid}, {"$set": {"stock": product["stock"]}})
        return outcomes, stock

    outcomes, stock = client.portal.call(race)
    assert sum(o is None for o in outcomes) == 1
    assert stock == 0


def test_demo_payment_is_refused_in_production(client, monkeypatch):
    from app.core.config import get_settings

    headers, _ = _register(client)
    address_id = _cart_with_address(client, headers, _in_stock_product(client)["_id"])
    monkeypatch.setattr(get_settings(), "app_env", "production")
    r = client.post("/api/orders", json={"addressId": address_id, "paymentMethod": "upi", "otp": "000000"}, headers=headers)
    assert r.status_code == 503
    assert _orders(client, headers) == []


def _admin(client):
    r = client.post("/api/auth/login", json={"email": "admin@shop.local", "password": "admin123"})  # from scripts.seed
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def _placed_order(client):
    """A shopper's cash-on-delivery order, with the seller who has to ship it."""
    seller_headers = _seller(client)
    product = _seller_product(client, seller_headers)
    headers, address = _customer_with_cart(client, product["_id"])
    r = client.post("/api/orders", json={"addressId": address["id"], "paymentMethod": "cod"}, headers=headers)
    assert r.status_code == 201, r.text
    return headers, r.json(), product, seller_headers


def _delivered_order(client):
    headers, order, product, seller_headers = _placed_order(client)
    shipment = {"fulfilment": "shipped", "courier": "Blue Dart", "trackingNumber": "AWB123"}
    assert client.patch(f"/api/seller/orders/{order['id']}", json=shipment, headers=seller_headers).status_code == 200
    r = client.patch(f"/api/seller/orders/{order['id']}", json={"fulfilment": "delivered"}, headers=seller_headers)
    assert r.status_code == 200, r.text
    return headers, order, product


def test_order_page_shows_the_timeline_and_tracking(client):
    headers, order, _ = _delivered_order(client)
    detail = client.get(f"/api/orders/{order['id']}", headers=headers).json()
    assert [e["status"] for e in detail["events"]] == ["placed", "shipped", "delivered"]
    assert "AWB123" in detail["events"][1]["note"]
    assert detail["items"][0]["tracking_number"] == "AWB123"
    assert detail["payment_status"] is None and detail["payment_method"] == "cod"  # cash has no gateway payment
    assert detail["items"][0]["product_id"]


def test_seller_sees_which_customer_placed_an_order(client):
    headers, order, _, seller_headers = _placed_order(client)
    customer = client.get("/api/auth/me", headers=headers).json()
    row = next(o for o in client.get("/api/seller/orders", headers=seller_headers).json() if o["id"] == order["id"])
    assert row["customer_id"] == customer["id"]


def test_return_flow_restores_stock(client):
    headers, order, product = _delivered_order(client)
    before = client.get(f"/api/products/{product['_id']}").json()["stock"]
    assert client.post(f"/api/orders/{order['id']}/return", json={"reason": "Wrong size"}, headers=headers).status_code == 201
    assert client.post(f"/api/orders/{order['id']}/return", json={"reason": "Again please"}, headers=headers).status_code == 409

    admin = _admin(client)
    assert any(r["order_id"] == order["id"] for r in client.get("/api/orders/returns/pending", headers=admin).json())
    r = client.patch(f"/api/orders/{order['id']}/return", json={"approve": True}, headers=admin)
    assert r.status_code == 200, r.text
    assert r.json()["refund"] == "cod_manual"
    assert client.get(f"/api/orders/{order['id']}", headers=headers).json()["status"] == "returned"
    assert client.get(f"/api/products/{product['_id']}").json()["stock"] == before + 1


def test_undelivered_order_cannot_be_returned(client):
    headers, order, _, _ = _placed_order(client)
    assert client.post(f"/api/orders/{order['id']}/return", json={"reason": "Changed mind"}, headers=headers).status_code == 400


def test_shoppers_cannot_decide_their_own_return(client):
    headers, order, _ = _delivered_order(client)
    client.post(f"/api/orders/{order['id']}/return", json={"reason": "Wrong size"}, headers=headers)
    assert client.patch(f"/api/orders/{order['id']}/return", json={"approve": True}, headers=headers).status_code == 403


def test_only_buyers_can_review_and_ratings_update_the_product(client):
    headers, _, product = _delivered_order(client)
    stranger, _ = _register(client, name="Stranger Danger")
    review = {"rating": 5, "title": "Great", "body": "Really good quality"}
    assert client.post(f"/api/products/{product['_id']}/reviews", json=review, headers=stranger).status_code == 403
    assert client.post(f"/api/products/{product['_id']}/reviews", json=review).status_code == 401
    assert client.post(f"/api/products/{product['_id']}/reviews", json={**review, "rating": 9}, headers=headers).status_code == 400

    assert client.post(f"/api/products/{product['_id']}/reviews", json=review, headers=headers).status_code == 201
    changed = {**review, "rating": 3}
    assert (
        client.post(f"/api/products/{product['_id']}/reviews", json=changed, headers=headers).status_code == 201
    )  # replaces, never doubles

    listing = client.get(f"/api/products/{product['_id']}/reviews", headers=headers).json()
    assert listing["count"] == 1 and listing["average"] == 3 and listing["canReview"]
    assert listing["items"][0]["mine"] and "@" not in listing["items"][0]["author"]
    detail = client.get(f"/api/products/{product['_id']}").json()
    assert detail["reviewRating"] == 3 and detail["reviewCount"] == 1

    assert client.delete(f"/api/products/{product['_id']}/reviews/mine", headers=headers).status_code == 204
    assert client.get(f"/api/products/{product['_id']}").json()["reviewCount"] == 0


def test_pincode_lookup_degrades_when_the_service_is_down(client, monkeypatch):
    import httpx

    from app.services import location

    assert client.get("/api/location/pincode/12").status_code == 400

    async def down(_):
        raise httpx.ConnectError("no network")

    monkeypatch.setattr(location, "_fetch_pincode", down)
    r = client.get("/api/location/pincode/999999")
    assert r.status_code == 200
    assert r.json()["found"] is None  # unknown, never "we don't deliver there"


def test_reverse_geocoding_only_accepts_india(client):
    assert client.get("/api/location/reverse?lat=51.5&lon=-0.12").status_code == 400


def test_automation_needs_its_key(client, monkeypatch):
    from app.core.config import get_settings

    assert client.post("/api/automation/run").status_code == 404  # off until a key is set
    monkeypatch.setattr(get_settings(), "automation_key", "scheduler-key")
    assert client.post("/api/automation/run", headers={"X-Automation-Key": "wrong"}).status_code == 403
    r = client.post("/api/automation/run", headers={"X-Automation-Key": "scheduler-key"})
    assert r.status_code == 200, r.text
    assert set(r.json()) == {"refunds", "payments", "lowStock", "lateOrders"}
    assert not any(job.get("error") for job in r.json().values())


def test_automation_retries_a_refund_that_failed(client, gateway, monkeypatch):
    from app.core.config import get_settings
    from app.db import postgres

    gateway["refund_fails"] = True
    headers, _ = _register(client)
    address_id = _cart_with_address(client, headers, _in_stock_product(client)["_id"])
    order_id = _start_payment(client, headers, address_id)
    gateway["amount"] += 100
    assert _verify(client, headers, order_id).status_code == 409

    gateway["refund_fails"] = False
    monkeypatch.setattr(get_settings(), "automation_key", "scheduler-key")
    result = client.post("/api/automation/run", headers={"X-Automation-Key": "scheduler-key"}).json()
    assert result["refunds"]["refunded"] >= 1

    async def status():
        return await postgres.get_pool().fetchval("SELECT status FROM payments WHERE provider_order_id = $1", order_id)

    assert client.portal.call(status) == "refunded"


def test_catalog_feed_returns_every_product(client):
    assert len(client.get("/api/products?limit=1000").json()) == 200
    assert len(client.get("/api/products/feed").json()) > 200


def test_search_falls_back_to_meaning_when_keywords_find_little(client, monkeypatch):
    from app.core.cache import invalidate
    from app.routers import products

    wanted = client.get("/api/products?limit=1").json()[0]

    async def by_meaning(query):
        return [wanted]

    monkeypatch.setattr(products, "semantic_search", by_meaning)
    invalidate("catalog:")
    assert client.get("/api/products", params={"q": "zzz-nothing-matches"}).json()[0]["_id"] == wanted["_id"]
    invalidate("catalog:")


def test_search_still_works_with_the_ai_service_down(client):
    from app.core.cache import invalidate

    invalidate("catalog:")
    assert client.get("/api/products", params={"q": "zzz-nothing-matches-either"}).json() == []
