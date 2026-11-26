// CRM → Catalog: product verification and publication. Nothing is assumed genuine: a product can only be shown or
// sold (available, out of stock, coming soon) after an admin has worked through every check below and recorded the
// supplier and the evidence they saw. Every decision is in the audit log.
import { PRODUCT_STATUSES, PUBLIC_STATUSES, statusOf, storeCatalog, verificationRequired } from './_catalog.mjs';
import { syncCatalogState } from './_inventory.mjs';
import { syncSellerProducts } from './_seller.mjs';
import { audit, fail, need, pageOf, paging, text } from './_crm_core.mjs';

export const CHECKS = {
  name: 'Product name matches the item and its packaging',
  description: 'Description is accurate and complete',
  images: 'Photos are of the real item (not stock or another product)',
  supplier: 'Manufacturer or supplier identified',
  price: 'Selling price is the real price we charge',
  inventory: 'Stock count was physically checked or confirmed by the supplier',
  condition: 'Condition (new / refurbished / used) confirmed',
  specifications: 'Specifications checked against the manufacturer',
  warranty: 'Warranty terms confirmed (or “no warranty” stated)',
  shipping: 'Can be shipped by our courier (size, weight, restrictions)',
  returns: 'Return eligibility decided',
  authenticity: 'Authenticity proven by an invoice, authorisation or GST bill from the supplier',
};
const ID_RE = /^[0-9a-f]{24}$/;
const CONDITIONS = ['new', 'refurbished', 'used'];

async function allProducts(db) {
  const store = storeCatalog().map((p) => ({ ...p, source: 'store' }));
  const sellers = await db(`SELECT p.id, p.seller_id, p.data, p.created_at, p.updated_at, s.store_name FROM seller_products p LEFT JOIN sellers s ON s.user_id = p.seller_id`);
  const seller = sellers.map((r) => {
    const p = { ...r.data, _id: r.id, sellerId: r.seller_id, seller: r.store_name, createdAt: r.created_at };
    const status = statusOf(p);
    return { ...p, status, availability: status === 'available' && !(p.stock > 0) ? 'out_of_stock' : status, source: 'seller' };
  });
  return [...store, ...seller];
}

const complete = (v) => v && Object.keys(CHECKS).every((k) => v.checks?.[k] === true) && text(v.supplier).length >= 2 && text(v.evidence).length >= 10 && CONDITIONS.includes(v.condition);

export async function listCatalog({ db, params }) {
  const products = await allProducts(db);
  const verifications = new Map((await db('SELECT * FROM product_verifications')).map((v) => [v.product_id, v]));
  const q = text(params.q, 80).toLowerCase();
  const items = products
    .filter((p) => (!params.status || p.status === params.status) && (!params.source || p.source === params.source) && (!q || `${p.name} ${p.brand} ${p._id} ${p.seller || ''}`.toLowerCase().includes(q))
      && (params.stock !== 'low' || (p.stock > 0 && p.stock < 10)) && (params.stock !== 'out' || !(p.stock > 0)))
    .map((p) => {
      const v = verifications.get(p._id);
      const done = v ? Object.keys(CHECKS).filter((k) => v.checks?.[k] === true).length : 0;
      return { _id: p._id, name: p.name, brand: p.brand, category: p.category, image: p.image, price: p.price, stock: p.stock, source: p.source, seller: p.seller || null,
        status: p.status, availability: p.availability, checksDone: done, checksTotal: Object.keys(CHECKS).length, verifiedComplete: complete(v), decision: v?.decision ?? null, verifiedAt: v?.verified_at ?? null };
    })
    .sort((a, b) => (a.status === 'pending_verification' ? 0 : 1) - (b.status === 'pending_verification' ? 0 : 1) || a.name.localeCompare(b.name));
  const counts = Object.fromEntries(PRODUCT_STATUSES.map((s) => [s, products.filter((p) => p.status === s).length]));
  const p = paging(params);
  return { body: { ...pageOf(items.slice(p.offset, p.offset + p.limit), p, items.length), counts, requireVerification: verificationRequired(), checks: CHECKS } };
}

async function findProduct(db, id) {
  if (!ID_RE.test(String(id))) fail('Product not found', 404);
  const p = (await allProducts(db)).find((x) => x._id === id);
  if (!p) fail('Product not found', 404);
  return p;
}

export async function getCatalogProduct({ db, id }) {
  const p = await findProduct(db, id);
  const [v] = await db('SELECT v.*, a.name AS verified_by_name, b.name AS updated_by_name FROM product_verifications v LEFT JOIN users a ON a.id = v.verified_by LEFT JOIN users b ON b.id = v.updated_by WHERE v.product_id = $1', [p._id]);
  const history = await db(`SELECT action, actor_name, details, created_at FROM crm_audit_log WHERE entity = 'product' AND entity_id = $1 ORDER BY created_at DESC LIMIT 50`, [p._id]);
  return { body: { product: p, verification: v ?? null, complete: complete(v), checks: CHECKS, history } };
}

export async function saveVerification({ db, staff, id, body }) {
  need(staff, 'catalog.verify');
  const p = await findProduct(db, id);
  const checks = {};
  for (const k of Object.keys(CHECKS)) if (typeof body.checks?.[k] === 'boolean') checks[k] = body.checks[k];
  const condition = body.condition === undefined ? undefined : CONDITIONS.includes(body.condition) ? body.condition : fail('Condition must be new, refurbished or used');
  await db(
    `INSERT INTO product_verifications (product_id, checks, supplier, evidence, condition, warranty, returnable, ships, notes, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (product_id) DO UPDATE SET checks = product_verifications.checks || EXCLUDED.checks,
       supplier = COALESCE(EXCLUDED.supplier, product_verifications.supplier), evidence = COALESCE(EXCLUDED.evidence, product_verifications.evidence),
       condition = COALESCE(EXCLUDED.condition, product_verifications.condition), warranty = COALESCE(EXCLUDED.warranty, product_verifications.warranty),
       returnable = COALESCE(EXCLUDED.returnable, product_verifications.returnable), ships = COALESCE(EXCLUDED.ships, product_verifications.ships),
       notes = COALESCE(EXCLUDED.notes, product_verifications.notes), updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [p._id, JSON.stringify(checks), text(body.supplier, 160) || null, text(body.evidence, 4000) || null, condition ?? null, text(body.warranty, 200) || null,
      typeof body.returnable === 'boolean' ? body.returnable : null, typeof body.ships === 'boolean' ? body.ships : null, text(body.notes, 4000) || null, staff.id],
  );
  await audit(db, staff, 'product.verification', 'product', p._id, { checks, supplier: body.supplier ?? undefined, condition });
  return getCatalogProduct({ db, id: p._id });
}

/** Moves a product to a status. Public statuses need a complete verification; rejecting needs a reason. */
export async function setProductStatus({ db, staff, id, body }) {
  need(staff, 'catalog.verify');
  const p = await findProduct(db, id);
  const status = body.reject ? 'rejected' : body.status;
  if (!PRODUCT_STATUSES.includes(status)) fail('Unknown status');
  const reason = text(body.reason, 500);
  const [v] = await db('SELECT * FROM product_verifications WHERE product_id = $1', [p._id]);
  if ([...PUBLIC_STATUSES, 'approved'].includes(status) && !complete(v)) {
    fail('Finish the verification first: every check, the supplier, the evidence you saw and the condition. Unverified products can’t be shown or sold.', 409);
  }
  if (body.reject && reason.length < 5) fail('Please give the reason for rejecting');
  if (p.source === 'store') {
    await db(
      `INSERT INTO catalog_overrides (product_id, data, updated_by) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (product_id) DO UPDATE SET data = catalog_overrides.data || EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [p._id, JSON.stringify({ status, ...(PUBLIC_STATUSES.includes(status) ? { active: true } : {}) }), staff.id],
    );
  } else {
    await db(`UPDATE seller_products SET data = jsonb_set(data, '{status}', to_jsonb($2::text)), updated_at = NOW() WHERE id = $1`, [p._id, status]);
    if (body.reject || status === 'available') {
      // The seller hears the decision on their product (CRM → Settings → Notifications)
      const { notify } = await import('./_messaging.mjs');
      await notify(db, body.reject ? 'product_rejected' : 'product_approved', { userId: p.sellerId, reply: body.reject ? `${p.name}: ${reason}` : p.name }).catch(() => {});
    }
  }
  if (status === 'available' || body.reject) {
    await db(
      `INSERT INTO product_verifications (product_id, decision, decision_reason, verified_by, verified_at, updated_by) VALUES ($1, $2, $3, $4, NOW(), $4)
       ON CONFLICT (product_id) DO UPDATE SET decision = EXCLUDED.decision, decision_reason = EXCLUDED.decision_reason, verified_by = EXCLUDED.verified_by, verified_at = NOW(), updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [p._id, body.reject ? 'rejected' : 'approved', reason || null, staff.id],
    );
  }
  await syncCatalogState(db, Date.now(), true);
  await syncSellerProducts(db, Date.now(), true);
  await audit(db, staff, body.reject ? 'product.reject' : `product.${status}`, 'product', p._id, { from: p.status, to: status, reason: reason || undefined, name: p.name });
  return getCatalogProduct({ db, id: p._id });
}

/** Verification can be switched on (it is, for the live store), never off from here: that would sell unchecked products */
export async function catalogSettings({ db, staff, body, method }) {
  if (method === 'PUT') {
    need(staff, 'settings.manage');
    if (body.requireVerification !== true) fail('Product verification can’t be switched off: unverified products would become purchasable.', 409);
    await db(`INSERT INTO crm_settings (key, value, updated_by) VALUES ('catalog', '{"requireVerification": true}'::jsonb, $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`, [staff.id]);
    await syncCatalogState(db, Date.now(), true);
    await audit(db, staff, 'catalog.require_verification', 'settings', 'catalog', { requireVerification: true });
  }
  return { body: { requireVerification: verificationRequired() } };
}
