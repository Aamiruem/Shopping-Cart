// Courier integration (Shiprocket): delivery serviceability at checkout, booking shipments with a real AWB, and the
// courier's own tracking events. Nothing here is estimated or invented: without credentials, serviceability is
// "not checked" (and the shopper is told so), and no tracking number exists until the courier issues one.
//
// Environment (Vercel → Settings → Environment Variables):
//   SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD   an API user created in Shiprocket → Settings → API
//   SHIPROCKET_PICKUP_POSTCODE              the pickup (warehouse) pincode
//   SHIPROCKET_PICKUP_LOCATION              the pickup location's name exactly as in Shiprocket (default "Primary")
//   SHIPROCKET_WEBHOOK_TOKEN                the token you set on the Shiprocket tracking webhook (x-api-key)
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from './_auth.mjs';

const API = 'https://apiv2.shiprocket.in/v1/external';
const PINCODE_RE = /^[1-9]\d{5}$/;

export const shippingConfigured = (env = process.env) => Boolean(env.SHIPROCKET_EMAIL && env.SHIPROCKET_PASSWORD && PINCODE_RE.test(env.SHIPROCKET_PICKUP_POSTCODE || ''));

let token = null; // Shiprocket tokens last 10 days; refreshed a day early
async function auth(env, fetchImpl) {
  if (token && token.until > Date.now()) return token.value;
  const res = await fetchImpl(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: env.SHIPROCKET_EMAIL, password: env.SHIPROCKET_PASSWORD }), signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) throw new Error(`shiprocket login ${res.status}`);
  token = { value: body.token, until: Date.now() + 9 * 86_400_000 };
  return token.value;
}

async function call(path, { method = 'GET', body, env = process.env, fetchImpl = fetch } = {}) {
  const t = await auth(env, fetchImpl);
  const res = await fetchImpl(`${API}${path}`, {
    method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) token = null;
  return { ok: res.ok, status: res.status, data };
}

/**
 * Can a courier deliver to this pincode, and when? { checked: false } when no courier is connected.
 * weightKg: the order's weight (products don't carry weights yet, so 0.5 kg per unit is assumed for the check only).
 */
export async function serviceability(pincode, { cod = false, weightKg = 0.5 } = {}, { env = process.env, fetchImpl = fetch } = {}) {
  if (!PINCODE_RE.test(String(pincode))) return { checked: true, serviceable: false, reason: 'Please enter a valid 6-digit pincode' };
  if (!shippingConfigured(env)) return { checked: false, provider: null };
  try {
    const q = new URLSearchParams({ pickup_postcode: env.SHIPROCKET_PICKUP_POSTCODE, delivery_postcode: pincode, weight: String(Math.max(0.1, weightKg)), cod: cod ? '1' : '0' });
    const { ok, status, data } = await call(`/courier/serviceability/?${q}`, { env, fetchImpl });
    const couriers = data?.data?.available_courier_companies || [];
    if (!ok && status !== 404) throw new Error(`shiprocket serviceability ${status}`);
    if (!couriers.length) return { checked: true, provider: 'shiprocket', serviceable: false, reason: cod ? 'No courier delivers cash-on-delivery orders to this pincode. Try paying online.' : 'Sorry, no courier delivers to this pincode yet.' };
    const days = couriers.map((c) => Number(c.estimated_delivery_days)).filter((d) => d > 0);
    const rates = couriers.map((c) => Number(c.rate)).filter((r) => r > 0);
    return {
      checked: true, provider: 'shiprocket', serviceable: true, couriers: couriers.length,
      days: days.length ? { min: Math.min(...days), max: Math.max(...days) } : null,
      etd: couriers.find((c) => Number(c.estimated_delivery_days) === Math.min(...days))?.etd ?? null,
      cheapestRate: rates.length ? Math.min(...rates) : null,
    };
  } catch (err) {
    console.error('serviceability check failed', err.message);
    return { checked: false, provider: 'shiprocket', error: 'The courier check is unavailable right now' };
  }
}

/** Throws when a connected courier says it can't deliver; returns what was checked (kept on the order). */
export async function assertDeliverable(address, { cod, units = 1 } = {}, opts = {}) {
  const pincode = String(address).match(/-\s*(\d{6})\b/)?.[1];
  const check = await serviceability(pincode, { cod, weightKg: 0.5 * units }, opts);
  if (check.checked && !check.serviceable) throw new ApiError(409, check.reason || 'We can’t deliver to this address yet.');
  return { ...check, pincode, at: new Date().toISOString() };
}

// "Name, line1, city, state - 560001. Phone: 98765..." → its parts (the order keeps the address as one line)
export function parseAddress(line) {
  const m = String(line).match(/^(.*?),\s*(.*),\s*([^,]+),\s*([^,]+?)\s*-\s*(\d{6})\.\s*Phone:\s*(\d{10})/);
  if (!m) return null;
  return { name: m[1].trim(), line1: m[2].trim(), city: m[3].trim(), state: m[4].trim(), pincode: m[5], phone: m[6] };
}

/** Books the order with Shiprocket and gets a real AWB from the courier. */
export async function createShipment(db, order, items, { weightKg, lengthCm, breadthCm, heightCm }, { env = process.env, fetchImpl = fetch } = {}) {
  if (!shippingConfigured(env)) throw new ApiError(503, 'No courier is connected yet: add SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD and SHIPROCKET_PICKUP_POSTCODE in Vercel.');
  const [existing] = await db('SELECT * FROM shipments WHERE order_id = $1', [order.id]);
  if (existing?.awb) throw new ApiError(409, `Already booked: AWB ${existing.awb} with ${existing.courier}`);
  const a = parseAddress(order.address);
  if (!a) throw new ApiError(400, 'The order’s address couldn’t be read for the courier');
  const dims = [weightKg, lengthCm, breadthCm, heightCm].map(Number);
  if (dims.some((d) => !(d > 0)) || dims[0] > 100) throw new ApiError(400, 'Enter the packed weight (kg) and box size (cm)');
  const [first, ...rest] = a.name.split(' ');
  let shipment = existing;
  if (!shipment) {
    const { ok, data } = await call('/orders/create/adhoc', {
      method: 'POST', env, fetchImpl,
      body: {
        order_id: order.order_number || String(order.id), order_date: new Date(order.created_at).toISOString().slice(0, 16).replace('T', ' '),
        pickup_location: env.SHIPROCKET_PICKUP_LOCATION || 'Primary',
        billing_customer_name: first, billing_last_name: rest.join(' '), billing_address: a.line1, billing_city: a.city, billing_pincode: a.pincode,
        billing_state: a.state, billing_country: 'India', billing_email: order.email, billing_phone: a.phone, shipping_is_billing: true,
        order_items: items.map((i) => ({ name: i.name.slice(0, 100), sku: i.product_id, units: i.qty, selling_price: Number(i.price) })),
        payment_method: order.payment_method === 'cod' ? 'COD' : 'Prepaid',
        shipping_charges: Number(order.delivery_fee), total_discount: Number(order.coupon_discount || 0), sub_total: Number(order.total),
        length: dims[1], breadth: dims[2], height: dims[3], weight: dims[0],
      },
    });
    if (!ok || !data.shipment_id) throw new ApiError(502, `Shiprocket didn’t accept the order: ${String(data.message || JSON.stringify(data.errors || data)).slice(0, 200)}`);
    [shipment] = await db(
      `INSERT INTO shipments (order_id, provider, provider_order_id, shipment_ref, status) VALUES ($1, 'shiprocket', $2, $3, 'created')
       ON CONFLICT (order_id) DO UPDATE SET provider_order_id = EXCLUDED.provider_order_id, shipment_ref = EXCLUDED.shipment_ref, updated_at = NOW() RETURNING *`,
      [order.id, String(data.order_id), String(data.shipment_id)],
    );
  }
  const awb = await call('/courier/assign/awb', { method: 'POST', body: { shipment_id: shipment.shipment_ref }, env, fetchImpl });
  const r = awb.data?.response?.data;
  if (!awb.ok || !r?.awb_code) throw new ApiError(502, `The courier didn’t assign a tracking number yet: ${String(awb.data?.message || '').slice(0, 200)}. Try again shortly.`);
  const [saved] = await db(
    `UPDATE shipments SET awb = $2, courier = $3, status = 'awb_assigned', tracking_url = $4, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [shipment.id, r.awb_code, r.courier_name || 'Courier', `https://shiprocket.co/tracking/${encodeURIComponent(r.awb_code)}`],
  );
  return saved;
}

// Shiprocket's current_status values → the steps shoppers see
const STATUS = {
  'PICKED UP': 'shipped', 'SHIPPED': 'shipped', 'IN TRANSIT': 'in_transit', 'REACHED AT DESTINATION HUB': 'in_transit',
  'OUT FOR DELIVERY': 'out_for_delivery', 'DELIVERED': 'delivered', 'UNDELIVERED': 'delivery_attempted',
  'RTO INITIATED': 'returning_to_seller', 'RTO DELIVERED': 'returned_to_seller', 'CANCELED': 'shipment_cancelled', 'LOST': 'lost_in_transit',
};
export const SHIPMENT_LABELS = {
  shipped: 'Shipped', in_transit: 'In transit', out_for_delivery: 'Out for delivery', delivered: 'Delivered', delivery_attempted: 'Delivery attempted',
  returning_to_seller: 'Returning to seller', returned_to_seller: 'Returned to seller', shipment_cancelled: 'Shipment cancelled', lost_in_transit: 'Lost in transit',
};

/** Tracking webhook: checks the token, records each event once, moves the order on. Returns { status, body }. */
export async function handleTracking(raw, headers, { db, env = process.env, deliver }) {
  const expected = env.SHIPROCKET_WEBHOOK_TOKEN || '';
  const given = String(headers['x-api-key'] || '');
  if (!expected || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return { status: 401, body: { error: 'Invalid token' } };
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: 'Invalid JSON' } };
  }
  const awb = String(event.awb || event.awb_code || '');
  const [shipment] = awb ? await db('SELECT * FROM shipments WHERE awb = $1', [awb]) : [];
  if (!shipment) return { status: 200, body: { ok: true, ignored: 'unknown AWB' } }; // not ours: acknowledged so it isn't retried
  const status = STATUS[String(event.current_status || '').toUpperCase()] || null;
  const when = event.current_timestamp ? new Date(String(event.current_timestamp).replace(/(\d{2}) (\w{3}) (\d{4})/, '$1 $2 $3')) : new Date();
  const at = Number.isNaN(when.getTime()) ? new Date() : when;
  if (!status) return { status: 200, body: { ok: true, ignored: event.current_status } };
  const [fresh] = await db(
    `INSERT INTO shipment_events (shipment_id, status, location, occurred_at, raw_key) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (shipment_id, raw_key) DO NOTHING RETURNING id`,
    [shipment.id, status, String(event.scans?.at(-1)?.location || event.location || '').slice(0, 120) || null, at.toISOString(), `${status}:${event.current_status_id ?? ''}:${event.current_timestamp ?? ''}`.slice(0, 120)],
  );
  if (!fresh) return { status: 200, body: { ok: true, duplicate: true } }; // the same event again: nothing changes
  await db('UPDATE shipments SET status = $2, eta = COALESCE($3::date, eta), last_event_at = $4, updated_at = NOW() WHERE id = $1',
    [shipment.id, status, /^\d{4}-\d{2}-\d{2}/.test(event.etd || '') ? event.etd.slice(0, 10) : null, at.toISOString()]);
  if (status === 'delivered') await deliver(shipment.order_id); // marks lines delivered and tells the customer
  else await db('INSERT INTO order_events (order_id, status, note) VALUES ($1, $2, $3)', [shipment.order_id, status, `${SHIPMENT_LABELS[status]}${event.scans?.at(-1)?.location ? ` · ${event.scans.at(-1).location}` : ''} (${shipment.courier}, AWB ${awb})`]);
  return { status: 200, body: { ok: true, status } };
}
