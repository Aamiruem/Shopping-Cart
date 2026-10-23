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


@pytest.fixture(autouse=True)
def _fresh_rate_limits():
    """Each test starts with clean rate-limit counters (the suite signs up more users than one IP may in 15 min)."""
    from app.core.rate_limit import reset_all

    reset_all()


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
    assert r.status_code == 202, r.text  # signup waits for the emailed code (returned as devCode without SMTP)
    r = client.post("/api/auth/register/verify", json={"email": email, "code": r.json()["devCode"]})
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
    product = {"name": "Pytest Speaker", "category": "electronics", "brand": "Arvixa", "price": 1999, "mrp": 2499, "stock": 5}

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


def test_fashion_audience_filter_and_360_view(client):
    seller = _seller(client)
    frames = [f"https://example.com/dress/{i}.webp" for i in range(1, 5)]
    dress = {"name": f"Pytest Dress {time.time_ns()}", "category": "fashion", "audience": "women", "price": 999, "stock": 3}
    dress["images"] = frames[:1]

    # A 360° view needs at least 4 frames; unknown audiences are rejected
    assert client.post("/api/seller/products", json={**dress, "images360": frames[:3]}, headers=seller).status_code == 400
    assert client.post("/api/seller/products", json={**dress, "audience": "kids"}, headers=seller).status_code == 400

    r = client.post("/api/seller/products", json={**dress, "images360": frames}, headers=seller)
    assert r.status_code == 201, r.text
    pid = r.json()["_id"]
    assert client.get(f"/api/products/{pid}").json()["images360"] == frames

    in_women = {p["_id"] for p in client.get("/api/products", params={"category": "fashion", "audience": "women"}).json()}
    in_men = {p["_id"] for p in client.get("/api/products", params={"category": "fashion", "audience": "men"}).json()}
    assert pid in in_women and pid not in in_men
    assert client.delete(f"/api/seller/products/{pid}", headers=seller).status_code == 204


def test_daily_and_general_use_groups(client):
    daily = client.get("/api/products", params={"use": "daily"}).json()
    general = client.get("/api/products", params={"use": "general"}).json()
    assert daily and general
    assert {p["category"] for p in daily} <= {"grocery", "kitchen", "beauty"}
    assert not {p["category"] for p in general} & {"grocery", "kitchen", "beauty"}
    # An explicit category wins over the group
    assert {p["category"] for p in client.get("/api/products", params={"use": "daily", "category": "mobiles"}).json()} == {"mobiles"}


def test_subcategories_and_aisle_filter(client):
    rows = client.get("/api/products/subcategories", params={"category": "fashion"}).json()
    assert rows and all(r["id"] and r["count"] > 0 for r in rows)
    total = len(client.get("/api/products", params={"category": "fashion"}).json())
    assert sum(r["count"] for r in rows) <= total
    first = rows[0]
    in_aisle = client.get("/api/products", params={"category": "fashion", "subCategory": first["id"]}).json()
    assert len(in_aisle) == first["count"] and {p["subCategory"] for p in in_aisle} == {first["id"]}


def _seller_product(client, seller, **extra):
    body = {"name": f"Pytest Item {time.time_ns()}", "category": "electronics", "price": 500, "stock": 20, **extra}
    r = client.post("/api/seller/products", json=body, headers=seller)
    assert r.status_code == 201, r.text
    return r.json()


def _customer_with_cart(client, product_id):
    customer, _ = _register(client)
    assert client.post("/api/cart", json={"productId": product_id, "qty": 1}, headers=customer).status_code in (200, 201)
    address = client.post(
        "/api/addresses",
        json={"name": "Asha", "phone": "9876543210", "line1": "1 MG Road", "city": "Pune", "state": "Maharashtra", "pincode": "411001"},
        headers=customer,
    ).json()
    return customer, address


def test_seller_profile_and_payout_details(client):
    seller = _seller(client)
    base = {"storeName": f"Pytest Profile {time.time_ns()}", "description": "Handmade goods"}
    bad_upi = client.put("/api/seller/profile", json={**base, "payoutUpi": "not-a-upi"}, headers=seller)
    assert bad_upi.status_code == 400 and "UPI" in bad_upi.json()["error"]
    bad_ifsc = client.put("/api/seller/profile", json={**base, "bankAccountNumber": "123456789012", "bankIfsc": "HDFC123"}, headers=seller)
    assert bad_ifsc.status_code == 400 and "IFSC" in bad_ifsc.json()["error"]

    ok = {
        **base,
        "payoutUpi": "mystore@okhdfcbank",
        "bankAccountName": "Asha",
        "bankAccountNumber": "123456789012",
        "bankIfsc": "hdfc0001234",
    }
    # Payout details are protected: the account password is required to change them
    no_password = client.put("/api/seller/profile", json=ok, headers=seller)
    assert no_password.status_code == 403 and "password" in no_password.json()["error"]
    wrong = client.put("/api/seller/profile", json={**ok, "currentPassword": "wrong-pass1"}, headers=seller)
    assert wrong.status_code == 403
    r = client.put("/api/seller/profile", json={**ok, "currentPassword": PASSWORD}, headers=seller)
    assert r.status_code == 200, r.text
    saved = r.json()
    assert saved["bank_account_number"].endswith("9012") and "1234567" not in saved["bank_account_number"]  # masked
    assert saved["bank_ifsc"] == "HDFC0001234" and saved["payout_upi"] == "mystore@okhdfcbank"
    # Saving again with the masked number keeps the real one
    again = client.put("/api/seller/profile", json={**ok, "bankAccountNumber": saved["bank_account_number"]}, headers=seller)
    assert again.json()["bank_account_number"] == saved["bank_account_number"]


def test_seller_bulk_actions_and_duplicate(client):
    seller = _seller(client)
    a, b = _seller_product(client, seller), _seller_product(client, seller, videos=["https://example.com/demo.mp4"])
    bulk = client.post("/api/seller/products/bulk", json={"ids": [a["_id"], b["_id"]], "action": "unlist"}, headers=seller)
    assert bulk.json()["updated"] == 2
    assert client.get(f"/api/products/{a['_id']}").status_code == 404
    client.post("/api/seller/products/bulk", json={"ids": [a["_id"]], "action": "stock", "stock": 7}, headers=seller)
    assert client.get(f"/api/seller/products/{a['_id']}", headers=seller).json()["stock"] == 7

    copy = client.post(f"/api/seller/products/{b['_id']}/duplicate", headers=seller)
    assert copy.status_code == 201 and copy.json()["name"].endswith("(copy)") and copy.json()["active"] is False
    assert copy.json()["videos"] == ["https://example.com/demo.mp4"]

    other = _seller(client)
    assert client.post("/api/seller/products/bulk", json={"ids": [a["_id"]], "action": "delete"}, headers=other).status_code == 403
    ids = [a["_id"], b["_id"], copy.json()["_id"]]
    assert client.post("/api/seller/products/bulk", json={"ids": ids, "action": "delete"}, headers=seller).json()["updated"] == 3
    # Media links must be https or uploaded files
    bad = {"name": "Bad media", "category": "electronics", "price": 1, "audio": "javascript:alert(1)"}
    assert client.post("/api/seller/products", json=bad, headers=seller).status_code == 400


def test_fulfilment_blocks_cancel_and_feeds_earnings(client):
    seller = _seller(client)
    product = _seller_product(client, seller)
    customer, address = _customer_with_cart(client, product["_id"])
    order = client.post("/api/orders", json={"addressId": address["id"], "paymentMethod": "cod"}, headers=customer).json()

    listed = client.get("/api/seller/orders", headers=seller).json()
    assert listed[0]["id"] == order["id"] and listed[0]["fulfilment"] == "pending"
    assert client.patch(f"/api/seller/orders/{order['id']}", json={"fulfilment": "shipped"}, headers=seller).status_code == 200
    assert client.get(f"/api/orders/{order['id']}", headers=customer).json()["items"][0]["fulfilment"] == "shipped"
    assert client.patch(f"/api/orders/{order['id']}/cancel", headers=customer).status_code == 400  # already shipped
    assert client.patch(f"/api/seller/orders/{order['id']}", json={"fulfilment": "delivered"}, headers=_seller(client)).status_code == 404

    totals = client.get("/api/seller/earnings", headers=seller).json()["totals"]
    assert float(totals["gross"]) == 500 and int(totals["orders"]) == 1


def test_razorpay_flow_with_mocked_gateway(client, monkeypatch):
    import hashlib
    import hmac

    from app.core.config import get_settings
    from app.services import razorpay

    settings = get_settings()
    monkeypatch.setattr(settings, "razorpay_key_id", "rzp_test_key")
    monkeypatch.setattr(settings, "razorpay_key_secret", "key-secret")
    created, refunds = {}, []

    async def fake_create_order(amount, receipt, notes=None):
        created["paise"] = round(amount * 100)
        return {"id": f"order_{time.time_ns()}", "amount": created["paise"], "currency": "INR"}

    async def fake_fetch(payment_id):
        return {"id": payment_id, "method": "netbanking", "amount": created["paise"]}

    async def fake_refund(payment_id, amount=None):
        refunds.append(payment_id)
        return {"id": "rfnd_1"}

    monkeypatch.setattr(razorpay, "create_order", fake_create_order)
    monkeypatch.setattr(razorpay, "fetch_payment", fake_fetch)
    monkeypatch.setattr(razorpay, "refund", fake_refund)

    assert client.get("/api/payments/config").json()["enabled"] is True
    seller = _seller(client)
    product = _seller_product(client, seller)
    customer, address = _customer_with_cart(client, product["_id"])
    # With a real gateway configured, the OTP demo is switched off
    demo = {"addressId": address["id"], "paymentMethod": "upi", "otp": "123456"}
    assert client.post("/api/orders", json=demo, headers=customer).status_code == 400

    start = client.post("/api/payments/razorpay/order", json={"addressId": address["id"]}, headers=customer).json()
    assert start["keyId"] == "rzp_test_key" and start["amount"] == created["paise"]
    paid = {"razorpay_order_id": start["orderId"], "razorpay_payment_id": "pay_123"}
    forged = client.post("/api/payments/razorpay/verify", json={**paid, "razorpay_signature": "0" * 64}, headers=customer)
    assert forged.status_code == 400

    # A fresh attempt with a genuine signature creates the order
    start = client.post("/api/payments/razorpay/order", json={"addressId": address["id"]}, headers=customer).json()
    paid = {"razorpay_order_id": start["orderId"], "razorpay_payment_id": "pay_456"}
    message = (paid["razorpay_order_id"] + "|pay_456").encode()
    signature = hmac.new(b"key-secret", message, hashlib.sha256).hexdigest()
    r = client.post("/api/payments/razorpay/verify", json={**paid, "razorpay_signature": signature}, headers=customer)
    assert r.status_code == 200, r.text
    order_id = r.json()["orderId"]
    assert client.get(f"/api/orders/{order_id}", headers=customer).json()["payment_method"] == "netbanking"
    assert client.get("/api/cart", headers=customer).json()["items"] == []

    # Cancelling a paid order refunds it
    cancelled = client.patch(f"/api/orders/{order_id}/cancel", headers=customer).json()
    assert cancelled["refund"] == "refunded" and refunds == ["pay_456"]
    history = client.get("/api/payments/mine", headers=customer).json()
    assert [p["status"] for p in history][:2] == ["refunded", "failed"]


def test_signup_needs_email_code(client):
    email = f"pytest{time.time_ns()}@gmail.com"
    body = {"name": "Verify Me", "email": email, "password": PASSWORD}
    assert client.post("/api/auth/register", json={**body, "email": "someone@mailinator.com"}).status_code == 400  # disposable inbox
    start = client.post("/api/auth/register", json=body)
    assert start.status_code == 202 and start.json()["verify"] == "email" and "*" in start.json()["sentTo"]
    # No account until the code is confirmed
    assert client.post("/api/auth/login", json={"email": email, "password": PASSWORD}).status_code == 401
    wrong = "000000" if start.json()["devCode"] != "000000" else "111111"
    bad = client.post("/api/auth/register/verify", json={"email": email, "code": wrong})
    assert bad.status_code == 400 and "attempt" in bad.json()["error"]
    ok = client.post("/api/auth/register/verify", json={"email": email, "code": start.json()["devCode"]})
    assert ok.status_code == 201 and ok.json()["user"]["emailVerified"] is True
    # The code is single-use and the email is now taken
    assert client.post("/api/auth/register/verify", json={"email": email, "code": start.json()["devCode"]}).status_code == 400
    assert client.post("/api/auth/register", json=body).status_code == 409


def test_phone_verification_by_sms_and_whatsapp(client):
    headers, _ = _register(client)
    phone = f"9{time.time_ns() % 1_000_000_000:09d}"
    assert client.post("/api/auth/phone/otp", json={"phone": "12345"}, headers=headers).status_code == 400
    sent = client.post("/api/auth/phone/otp", json={"phone": phone, "channel": "whatsapp"}, headers=headers).json()
    assert sent["channel"] == "whatsapp" and sent["sentTo"].endswith(phone[-4:])
    user = client.post("/api/auth/phone/verify", json={"phone": phone, "code": sent["devCode"]}, headers=headers).json()
    assert user["phone"] == phone and user["phoneVerified"] is True
    # Another account can't claim a verified number
    other, _ = _register(client)
    assert client.post("/api/auth/phone/otp", json={"phone": phone, "channel": "sms"}, headers=other).status_code == 409
    # Changing the number on the profile resets verification
    changed = client.put("/api/auth/me", json={"name": "Test Shopper", "phone": "9876500000"}, headers=headers).json()
    assert changed["phoneVerified"] is False


def test_growth_advisor_reports_each_product(client):
    seller = _seller(client)
    product = _seller_product(client, seller)
    customer, address = _customer_with_cart(client, product["_id"])
    client.get(f"/api/products/{product['_id']}", headers=customer)  # a view
    client.post("/api/orders", json={"addressId": address["id"], "paymentMethod": "cod"}, headers=customer)
    report = client.get("/api/analytics/growth", headers=seller).json()
    row = next(r for r in report["products"] if r["productId"] == product["_id"])
    assert row["views"] >= 1 and row["purchases"] == 1 and row["revenue30"] == 500
    assert 0 <= row["listingScore"] <= 100 and isinstance(row["tips"], list)
    assert report["summary"]["products"] == 1 and report["summary"]["revenue30"] == 500
    customer_only, _ = _register(client)
    assert client.get("/api/analytics/growth", headers=customer_only).status_code == 403


def test_sizes_colours_and_age_groups_flow_to_the_order(client):
    seller = _seller(client)
    shirt = _seller_product(
        client,
        seller,
        name=f"Pytest Shirt {time.time_ns()}",
        category="fashion",
        audience="men",
        sizes=["S", "M", "L"],
        colors=["Navy", "White"],
        ageGroups=["18-25", "26-35"],
        material="Cotton",
        fit="Slim",
    )
    customer, address = _customer_with_cart(client, _seller_product(client, seller)["_id"])
    assert client.post("/api/cart", json={"productId": shirt["_id"], "qty": 1}, headers=customer).status_code == 400  # size needed
    assert client.post("/api/cart", json={"productId": shirt["_id"], "size": "XXL"}, headers=customer).status_code == 400
    client.post("/api/cart", json={"productId": shirt["_id"], "size": "M"}, headers=customer)
    cart = client.post("/api/cart", json={"productId": shirt["_id"], "size": "L", "color": "White"}, headers=customer).json()
    lines = [i for i in cart["items"] if i["productId"] == shirt["_id"]]
    assert {(i["size"], i["color"]) for i in lines} == {("M", "Navy"), ("L", "White")}  # colour defaults to the first one
    m_line = next(i for i in lines if i["size"] == "M")
    cart = client.put(f"/api/cart/{m_line['lineId']}", json={"qty": 2}, headers=customer).json()
    assert next(i for i in cart["items"] if i["lineId"] == m_line["lineId"])["qty"] == 2

    # Filters see the attributes
    by_size = client.get("/api/products", params={"category": "fashion", "size": "M", "ageGroup": "18-25"}).json()
    assert shirt["_id"] in {p["_id"] for p in by_size}
    assert "M" in client.get("/api/products/facets", params={"category": "fashion"}).json()["sizes"]

    order = client.post("/api/orders", json={"addressId": address["id"], "paymentMethod": "cod"}, headers=customer).json()
    items = client.get(f"/api/orders/{order['id']}", headers=customer).json()["items"]
    assert sorted((i.get("options") or {}).get("size", "") for i in items if i["product_id"] == shirt["_id"]) == ["L", "M"]
    seller_view = next(o for o in client.get("/api/seller/orders", headers=seller).json() if o["id"] == order["id"])
    assert {(i["options"] or {}).get("size") for i in seller_view["items"] if i["productId"] == shirt["_id"]} == {"M", "L"}


def test_bulk_import_from_sheet_and_zip(client):
    import io
    import zipfile

    from PIL import Image

    seller = _seller(client)
    photo = io.BytesIO()
    Image.new("RGB", (2400, 3200), (20, 40, 160)).save(photo, "JPEG")
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as z:
        for name in ("jeans-front.jpg", "jeans-back.jpg", "kurta-front.jpg"):
            z.writestr(f"photos/{name}", photo.getvalue())
        z.writestr("walk.mp4", b"\x00\x00\x00\x18ftypmp42" + b"0" * 100)
    tag = time.time_ns()
    sheet = (
        "name,brand,category,audience,ageGroups,sizes,colors,price,mrp,stock,images,video,tags\n"
        f"Pytest Jeans {tag},Urban Thread,fashion,men,18-25|26-35,30|32|34,Blue,1299,2499,50,"
        "jeans-front.jpg|JEANS-BACK.jpg,walk.mp4,jeans|denim\n"
        f"Pytest Kurta {tag},Ethnix,fashion,women,26-35,S|M|L,Teal,799,1599,40,kurta-front.jpg,,kurta\n"
        f"Pytest Broken {tag},,fashion,women,,,,,,,missing.jpg,,\n"
    ).encode()
    files = lambda: {"sheet": ("products.csv", sheet, "text/csv"), "media": ("media.zip", archive.getvalue(), "application/zip")}  # noqa: E731

    check = client.post("/api/seller/imports", files=files(), data={"dryRun": "true"}, headers=seller).json()
    assert check["dryRun"] and check["ok"] == 2
    assert "missing.jpg" in next(r for r in check["results"] if r["status"] == "error")["error"]

    job = client.post("/api/seller/imports", files=files(), headers=seller).json()
    for _ in range(100):
        status = client.get(f"/api/seller/imports/{job['jobId']}", headers=seller).json()
        if status["status"] != "running":
            break
        time.sleep(0.1)
    assert status["status"] == "finished" and status["created"] == 2
    jeans_id = next(r["productId"] for r in status["results"] if r["name"].startswith("Pytest Jeans"))
    jeans = client.get(f"/api/seller/products/{jeans_id}", headers=seller).json()
    assert len(jeans["images"]) == 2 and all(u.endswith(".webp") for u in jeans["images"])  # optimised on the way in
    assert jeans["videos"] and jeans["sizes"] == ["30", "32", "34"] and jeans["ageGroups"] == ["18-25", "26-35"]
    assert client.get(f"/api/seller/imports/{job['jobId']}", headers=_seller(client)).status_code == 404  # other sellers can't see it
    assert "name,brand" in client.get("/api/seller/imports/template", headers=seller).text
