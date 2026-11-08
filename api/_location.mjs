// Indian pincode lookup for "Deliver to" and address forms. Port of backend/app/services/location.py: India Post's
// free public data, so a failure must never block shopping. Callers get found: null ("unknown") and carry on.
const PINCODE_API = 'https://api.postalpincode.in/pincode';
export const PINCODE_RE = /^[1-9]\d{5}$/;

/**
 * Estimated delivery days from the warehouse (WAREHOUSE_PINCODE). Indian pincodes get more local digit by digit,
 * so shared leading digits mean closer. Without a warehouse pincode, a general 3-7 days.
 */
export function deliveryDays(pincode, warehouse = process.env.WAREHOUSE_PINCODE || '') {
  if (!PINCODE_RE.test(warehouse)) return { min: 3, max: 7 };
  if (pincode.slice(0, 2) === warehouse.slice(0, 2)) return { min: 1, max: 2 };
  if (pincode[0] === warehouse[0]) return { min: 2, max: 4 };
  return { min: 4, max: 7 };
}

export async function lookupPincode(pincode, fetchImpl = fetch) {
  const days = deliveryDays(pincode);
  try {
    const res = await fetchImpl(`${PINCODE_API}/${pincode}`, { headers: { 'User-Agent': 'ArvixaStore/1.0' }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`India Post answered ${res.status}`);
    const body = await res.json();
    const result = Array.isArray(body) ? body[0] : null;
    // Anything but India Post's usual shape is an outage, not "no such pincode": that answer is cached for a month
    if (!result || typeof result !== 'object' || !('Status' in result)) throw new Error('unexpected India Post response');
    const offices = Array.isArray(result.PostOffice) ? result.PostOffice : [];
    if (result.Status !== 'Success' || !offices.length) return { pincode, found: false };
    return {
      pincode,
      found: true,
      city: String(offices[0].District).trim(),
      state: String(offices[0].State).trim(),
      areas: [...new Set(offices.map((o) => String(o.Name).trim()))].sort(),
      deliverable: offices.some((o) => o.DeliveryStatus === 'Delivery'),
      days,
    };
  } catch (err) {
    console.warn('pincode lookup failed', pincode, err.message);
    return { pincode, found: null, days };
  }
}
