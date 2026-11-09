"""The features shared with the Vercel store API (api/): coupons, returns & refunds, payment history, complaint
threads, the admin's catalog editor, review photos and the festive home section. Real databases, like test_api.py.
"""

import io
import os
import time

import pytest
from PIL import Image

from tests.test_api import _register
from tests.test_orders_real import _admin, _delivered_order, _placed_order, gateway  # noqa: F401 - gateway is a fixture

pytestmark = pytest.mark.skipif(
    not (os.getenv("TEST_DATABASE_URL") and os.getenv("TEST_MONGO_URI")),
    reason="set TEST_DATABASE_URL and TEST_MONGO_URI to run API tests",
)

UPI = {"reasonCode": "damaged", "details": "Screen cracked", "refundTo": "upi", "upi": "asha@okhdfcbank"}


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (8, 8), "red").save(out, "PNG")
    return out.getvalue()


@pytest.fixture(autouse=True)
def _fresh_rate_limits():
    from app.core.rate_limit import reset_all

    reset_all()


def _sql(client, statement, *args):
    from app.db.postgres import get_pool

    async def run():
        return await get_pool().execute(statement, *args)

    return client.portal.call(run)


def _events(client, headers, order_id):
    return [e["status"] for e in client.get(f"/api/orders/{order_id}", headers=headers).json()["events"]]


def test_cash_return_step_by_step_with_a_bank_transfer_refund(client):
    headers, order, product, seller = _placed_order(client)
    for step in ("shipped", "delivered"):
        client.patch(f"/api/seller/orders/{order['id']}", json={"fulfilment": step}, headers=seller)
    stock = client.get(f"/api/products/{product['_id']}").json()["stock"]
    ask = {
        "reasonCode": "wrong_item",
        "refundTo": "bank",
        "accountName": "Asha Rao",
        "accountNumber": "1234 5678 9012",
        "ifsc": "hdfc0001234",
    }
    assert client.post(f"/api/orders/{order['id']}/return", json={**ask, "ifsc": "BAD"}, headers=headers).status_code == 400
    made = client.post(f"/api/orders/{order['id']}/return", json=ask, headers=headers)
    assert made.status_code == 201, made.text
    assert made.json()["refund_bank"] == {"name": "Asha Rao", "last4": "9012", "ifsc": "HDFC0001234"}

    # The seller of every item handles it; moving the order's delivery steps is blocked meanwhile
    queue = client.get("/api/seller/returns", headers=seller).json()
    assert [r["order_id"] for r in queue if r["order_id"] == order["id"]] == [order["id"]]
    assert client.patch(f"/api/seller/returns/{order['id']}", json={"action": "receive"}, headers=seller).status_code == 409
    assert client.patch(f"/api/seller/returns/{order['id']}", json={"action": "approve"}, headers=seller).json()["status"] == "approved"
    assert client.patch(f"/api/seller/orders/{order['id']}", json={"fulfilment": "shipped"}, headers=seller).status_code == 400
    assert client.delete(f"/api/orders/{order['id']}/return", headers=headers).status_code == 400  # too late to withdraw
    received = client.patch(f"/api/seller/returns/{order['id']}", json={"action": "receive"}, headers=seller).json()
    assert (received["status"], received["refund"]) == ("received", "cod_manual")
    assert client.get(f"/api/products/{product['_id']}").json()["stock"] == stock + 1

    # Only the admin records the manual transfer, and then sees the full account number to make it
    utr = {"action": "refund", "reference": "utr123456789"}
    assert client.patch(f"/api/seller/returns/{order['id']}", json=utr, headers=seller).status_code == 403
    admin = _admin(client)
    due = next(r for r in client.get("/api/seller/returns", headers=admin).json() if r["order_id"] == order["id"])
    assert due["refund_bank"]["number"] == "123456789012"
    paid = client.patch(f"/api/seller/returns/{order['id']}", json=utr, headers=admin).json()
    assert (paid["refund"], paid["refund_reference"]) == ("refunded", "UTR123456789")
    assert _events(client, headers, order["id"])[-4:] == ["return_approved", "returned", "refund_initiated", "refunded"]

    history = client.get("/api/payments/history", headers=headers).json()
    refund = next(e for e in history["entries"] if e["id"] == f"refund-{order['id']}")
    assert (refund["status"], refund["to"], refund["reference"]) == ("refunded", "Bank ••••9012", "UTR123456789")


def test_paid_online_return_refunds_the_original_payment_and_retries(client, gateway):  # noqa: F811
    headers, order, _ = _delivered_order(client)
    _sql(client, "UPDATE orders SET payment_method = 'upi' WHERE id = $1", order["id"])
    _sql(
        client,
        """INSERT INTO payments (user_id, order_id, provider_order_id, provider_payment_id, method, amount, status, address)
           SELECT user_id, id, $2, 'pay_' || id, 'upi', total, 'paid', address FROM orders WHERE id = $1""",
        order["id"],
        f"order_t{time.time_ns()}",
    )
    made = client.post(f"/api/orders/{order['id']}/return", json={"reasonCode": "not_needed"}, headers=headers)
    assert made.json()["refund_to"] == "original"  # no account details needed
    admin = _admin(client)
    client.patch(f"/api/seller/returns/{order['id']}", json={"action": "approve"}, headers=admin)
    gateway["refund_fails"] = True
    assert (
        client.patch(f"/api/seller/returns/{order['id']}", json={"action": "receive"}, headers=admin).json()["refund"] == "refund_pending"
    )
    gateway["refund_fails"] = False
    assert client.patch(f"/api/seller/returns/{order['id']}", json={"action": "refund"}, headers=admin).json()["refund"] == "refunded"
    assert gateway["refunds"] == 1


def test_withdraw_then_ask_again_and_rejections_need_a_reason(client):
    headers, order, _ = _delivered_order(client)
    assert client.post(f"/api/orders/{order['id']}/return", json=UPI, headers=headers).status_code == 201
    assert client.delete(f"/api/orders/{order['id']}/return", headers=headers).status_code == 200
    assert client.get(f"/api/orders/{order['id']}", headers=headers).json()["return"] is None
    assert client.post(f"/api/orders/{order['id']}/return", json=UPI, headers=headers).status_code == 201
    admin = _admin(client)
    assert client.patch(f"/api/seller/returns/{order['id']}", json={"action": "reject"}, headers=admin).status_code == 400
    rejected = client.patch(f"/api/seller/returns/{order['id']}", json={"action": "reject", "note": "Seal opened"}, headers=admin)
    assert rejected.json()["status"] == "rejected"
    assert client.get(f"/api/orders/{order['id']}", headers=headers).json()["return"]["note"] == "Seal opened"


def test_coupons_discount_the_order_once_per_customer_and_come_back_on_cancel(client):
    code = f"PY{time.time_ns() % 10**8}"
    _sql(client, "INSERT INTO coupons (code, description, kind, value, min_order) VALUES ($1, '10% off', 'percent', 10, 0)", code)
    headers, order, product, seller_headers = _placed_order(client)  # a first order, without the coupon
    client.post("/api/cart", json={"productId": product["_id"], "qty": 1}, headers=headers)
    assert client.post("/api/cart/coupon", json={"code": "NOPE1"}, headers=headers).status_code == 404
    cart = client.post("/api/cart/coupon", json={"code": code.lower()}, headers=headers).json()
    assert (
        cart["couponDiscount"] == int(cart["subtotal"] * 0.1)
        and cart["total"] == cart["subtotal"] + cart["deliveryFee"] - cart["couponDiscount"]
    )
    assert any(c["code"] == code for c in client.get("/api/cart/coupons", headers=headers).json())
    address = client.get("/api/addresses", headers=headers).json()[0]["id"]
    placed = client.post("/api/orders", json={"addressId": address, "paymentMethod": "cod"}, headers=headers).json()
    assert (placed["coupon_code"], float(placed["total"])) == (code, cart["total"])

    client.post("/api/cart", json={"productId": product["_id"], "qty": 1}, headers=headers)
    assert "already used" in client.post("/api/cart/coupon", json={"code": code}, headers=headers).json()["error"]
    client.patch(f"/api/orders/{placed['id']}/cancel", headers=headers)
    assert client.post("/api/cart/coupon", json={"code": code}, headers=headers).status_code == 200  # given back
    assert client.delete("/api/cart/coupon", headers=headers).json()["coupon"] is None


def test_complaint_thread_between_shopper_and_store_team(client):
    headers, order, _, _ = _placed_order(client)
    made = client.post(
        "/api/support/tickets",
        json={"subject": "Order late", "message": "My parcel has not arrived yet", "orderId": order["id"]},
        headers=headers,
    )
    assert made.status_code == 201, made.text
    ticket = made.json()["id"]
    admin = _admin(client)
    answered = client.post(f"/api/support/tickets/{ticket}/messages", json={"message": "Arriving tomorrow."}, headers=admin).json()
    assert answered["status"] == "in_progress" and answered["messages"][0]["author"] == "Arvixa support"
    assert client.patch(f"/api/support/tickets/{ticket}", json={"status": "resolved"}, headers=admin).status_code == 200
    reopened = client.post(f"/api/support/tickets/{ticket}/messages", json={"message": "Still not here."}, headers=headers).json()
    assert (reopened["status"], len(reopened["messages"]), "customer_email" in reopened) == ("open", 2, False)
    stranger, _ = _register(client, "Someone Else")
    assert client.get(f"/api/support/tickets/{ticket}", headers=stranger).status_code == 404


def test_admin_edits_the_catalog_and_sellers_cannot(client):
    admin = _admin(client)
    _, _, product, seller = _placed_order(client)
    assert client.get("/api/seller/catalog", headers=seller).status_code == 403
    listed = client.get("/api/seller/catalog?limit=5", headers=admin).json()
    assert listed["total"] > 0 and len(listed["items"]) == 5
    pid = product["_id"]
    assert client.patch(f"/api/seller/catalog/{pid}", json={"price": 500, "mrp": 100}, headers=admin).status_code == 400
    edited = client.patch(f"/api/seller/catalog/{pid}", json={"price": 499, "stock": 3}, headers=admin).json()
    assert (edited["price"], edited["stock"]) == (499, 3)
    assert any(p["_id"] == pid for p in client.get("/api/seller/catalog?status=low_stock&limit=200", headers=admin).json()["items"])
    assert client.get(f"/api/products/{pid}").json()["price"] == 499


def test_review_photos_only_from_buyers_and_only_uploaded_ones(client):
    stranger, _ = _register(client, "No Orders Yet")
    files = {"file": ("p.png", _png(), "image/png")}
    assert client.post("/api/uploads?kind=review", files=files, headers=stranger).status_code == 403
    headers, _, product = _delivered_order(client)
    uploaded = client.post("/api/uploads?kind=review", files=files, headers=headers)
    assert uploaded.status_code == 201, uploaded.text
    url = uploaded.json()["url"]
    review = {"rating": 4, "title": "Good", "body": "Works", "photos": ["https://evil.example/x.jpg"]}
    assert client.post(f"/api/products/{product['_id']}/reviews", json=review, headers=headers).status_code == 400
    assert client.post(f"/api/products/{product['_id']}/reviews", json={**review, "photos": [url]}, headers=headers).status_code == 201
    listed = client.get(f"/api/products/{product['_id']}/reviews?photos=true").json()
    assert (listed["written"], listed["withPhotos"], listed["items"][0]["photos"]) == (1, 1, [url])


def test_festive_section_and_view_events(client):
    festive = client.get("/api/recommendations/festive").json()
    assert festive["season"]["name"] and festive["signal"] in ("demand", "popularity")
    assert all(c["to"].startswith("/products?") and len(c["images"]) <= 4 for c in festive["collections"])
    assert client.post("/api/events/view", json={"productId": "x", "visitor": "v-123456789"}).status_code == 204
