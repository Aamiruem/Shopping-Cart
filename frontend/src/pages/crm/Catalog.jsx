import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { crm } from '../../api/client';
import { Badge, count, dateTime, Drawer, ErrorBox, Field, label, Loading, money, PageHead, Pager, Table, useAction, useCrm, useCrmData } from '../../components/crm/ui';

export const STATUS = {
  draft: 'Draft', pending_verification: 'Pending verification', approved: 'Approved (not on sale)', available: 'Available', out_of_stock: 'Out of stock',
  coming_soon: 'Coming soon', discontinued: 'Discontinued', unavailable: 'Unavailable', rejected: 'Rejected',
};
const TONE = { draft: 'none', pending_verification: 'warn', approved: 'info', available: 'good', out_of_stock: 'warn', coming_soon: 'info', discontinued: 'bad', unavailable: 'bad', rejected: 'bad' };

function ProductDrawer({ id, onClose, onChange }) {
  const { can, confirm } = useCrm();
  const { data, error, reload, setData } = useCrmData(`/catalog/${id}`);
  const { run, busy } = useAction();
  const [form, setForm] = useState(null);
  useEffect(() => {
    if (data) {
      const v = data.verification || {};
      setForm({ checks: { ...(v.checks || {}) }, supplier: v.supplier || '', evidence: v.evidence || '', condition: v.condition || '', warranty: v.warranty || '', notes: v.notes || '', returnable: v.returnable ?? null, ships: v.ships ?? null });
    }
  }, [data]);
  const save = async () => {
    const out = await run(() => crm.post(`/catalog/${id}/verification`, { ...form, condition: form.condition || undefined }), 'Verification saved');
    if (out) setData(out);
    return out;
  };
  const move = async (status, opts = {}) => {
    let reason;
    if (opts.reject) {
      reason = await confirm({ title: 'Reject this product?', message: 'It stays hidden. The reason is recorded (and shown to the seller for seller products).', input: 'Why it was rejected', danger: true, confirmLabel: 'Reject' });
      if (!reason) return;
    } else if (!(await confirm({ title: `${STATUS[status]}?`, message: opts.message || `The product becomes “${STATUS[status]}”.`, confirmLabel: 'Confirm' }))) return;
    if (['available', 'coming_soon', 'out_of_stock'].includes(status) && !(await save())) return;
    const out = await run(() => crm.post(`/catalog/${id}/status`, { status, reason, reject: Boolean(opts.reject) }), `Now ${STATUS[status].toLowerCase()}`);
    if (out) {
      setData(out);
      onChange();
    }
  };
  const p = data?.product;
  const done = form ? Object.keys(data.checks).filter((k) => form.checks[k]).length : 0;
  const total = data ? Object.keys(data.checks).length : 12;
  const ready = form && done === total && form.supplier.trim().length >= 2 && form.evidence.trim().length >= 10 && form.condition;
  return (
    <Drawer title={p?.name || 'Product'} onClose={onClose}>
      <ErrorBox error={error} onRetry={reload} />
      {!data || !form ? <Loading /> : (
        <div className="stack">
          <div className="row">
            <Badge tone={TONE[p.status]}>{STATUS[p.status]}</Badge>
            <Badge tone="info">{p.source === 'seller' ? `Seller: ${p.seller || '—'}` : 'Store catalog'}</Badge>
            {data.verification?.decision && <Badge tone={data.verification.decision === 'approved' ? 'good' : 'bad'}>{label(data.verification.decision)} {data.verification.verified_by_name ? `by ${data.verification.verified_by_name}` : ''}</Badge>}
          </div>
          <section className="card row" style={{ alignItems: 'flex-start' }}>
            {p.image && <img src={p.image} alt="" style={{ width: 110, height: 110, objectFit: 'contain', borderRadius: 8, background: '#fff' }} />}
            <dl className="dl" style={{ flex: 1 }}>
              <dt>Brand</dt><dd>{p.brand || '—'}</dd>
              <dt>Price</dt><dd>{money(p.price)}{p.mrp ? ` (MRP ${money(p.mrp)})` : ''}</dd>
              <dt>Stock</dt><dd>{count(p.stock)}</dd>
              <dt>Category</dt><dd>{label(p.category)}</dd>
              <dt>ID</dt><dd><code>{p._id}</code></dd>
            </dl>
          </section>
          {p.description && <section className="card"><h3>Description shown to shoppers</h3><p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{p.description}</p></section>}
          {p.images?.length > 1 && <section className="card row">{p.images.slice(0, 8).map((src) => <img key={src} src={src} alt="" style={{ width: 70, height: 70, objectFit: 'contain', background: '#fff', borderRadius: 6 }} />)}</section>}
          <p className="muted small">To correct the name, description, price, stock or photos: {p.source === 'store' ? <Link to="/seller/catalog">Seller Hub → Store catalog</Link> : <Link to="/seller/products">Seller Hub → Products</Link>}. A seller’s full edit sends their product back for verification.</p>

          <section className="card stack">
            <h3 style={{ margin: 0 }}>Verification checklist ({done} of {total})</h3>
            {Object.entries(data.checks).map(([k, text]) => (
              <label key={k} className="check"><input type="checkbox" checked={Boolean(form.checks[k])} disabled={!can('catalog.verify')} onChange={(e) => setForm({ ...form, checks: { ...form.checks, [k]: e.target.checked } })} /> {text}</label>
            ))}
            <div className="grid2">
              <Field label="Manufacturer / supplier"><input value={form.supplier} onChange={(e) => setForm({ ...form, supplier: e.target.value })} /></Field>
              <Field label="Condition"><select value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })}><option value="">Choose…</option><option value="new">New</option><option value="refurbished">Refurbished</option><option value="used">Used</option></select></Field>
              <Field label="Warranty"><input value={form.warranty} onChange={(e) => setForm({ ...form, warranty: e.target.value })} placeholder="1 year manufacturer warranty / none" /></Field>
              <Field label="Returnable"><select value={form.returnable === null ? '' : String(form.returnable)} onChange={(e) => setForm({ ...form, returnable: e.target.value === '' ? null : e.target.value === 'true' })}><option value="">Not decided</option><option value="true">Yes, 7 days</option><option value="false">No</option></select></Field>
            </div>
            <Field label="Evidence you checked" hint="Invoice / authorisation / GST bill number and date, who confirmed stock. Kept in the record."><textarea rows={3} value={form.evidence} onChange={(e) => setForm({ ...form, evidence: e.target.value })} /></Field>
            <Field label="Notes"><textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
            {can('catalog.verify') && (
              <div className="row">
                <button type="button" className="b" onClick={save} disabled={busy}>Save progress</button>
                <button type="button" className="b primary" disabled={busy || !ready} onClick={() => move('available', { message: 'It becomes visible and can be ordered (while in stock).' })}>Approve & publish</button>
                <button type="button" className="b" disabled={busy || !ready} onClick={() => move('coming_soon', { message: 'Shoppers can see it in Coming soon but can’t order it.' })}>Approve as coming soon</button>
                <button type="button" className="b danger" disabled={busy} onClick={() => move('draft', { reject: true })}>Reject</button>
              </div>
            )}
            {!ready && <p className="muted small" style={{ margin: 0 }}>Approving needs every check ticked, the supplier, the condition and the evidence you saw.</p>}
          </section>

          {can('catalog.verify') && PUBLIC(p.status) && (
            <section className="card row">
              <strong>Change availability:</strong>
              {p.status !== 'out_of_stock' && <button type="button" className="b sm" onClick={() => move('out_of_stock')}>Mark out of stock</button>}
              {p.status !== 'available' && <button type="button" className="b sm" onClick={() => move('available')}>Back on sale</button>}
              {p.status !== 'coming_soon' && <button type="button" className="b sm" onClick={() => move('coming_soon')}>Coming soon</button>}
              <button type="button" className="b sm danger" onClick={() => move('unavailable', { message: 'It disappears from listings; its page says it’s unavailable. Nobody can order it.' })}>Disable</button>
              <button type="button" className="b sm danger" onClick={() => move('discontinued', { message: 'No longer sold. Its page says so.' })}>Discontinue</button>
            </section>
          )}
          {can('catalog.verify') && ['discontinued', 'unavailable', 'draft'].includes(p.status) && <div><button type="button" className="b sm" onClick={() => move('pending_verification', { message: 'It goes back into the verification queue.' })}>Send back for verification</button></div>}

          {data.history.length > 0 && <section className="card"><h3>History</h3><ul className="timeline">{data.history.map((h, i) => <li key={i}><div>{label(h.action.replace('product.', ''))} by {h.actor_name}{h.details?.reason ? `: ${h.details.reason}` : ''}<time>{dateTime(h.created_at)}</time></div></li>)}</ul></section>}
        </div>
      )}
    </Drawer>
  );
}
const PUBLIC = (s) => ['available', 'out_of_stock', 'coming_soon'].includes(s);

// `inventory`: the same products by stock level (CRM → Inventory); stock is edited in Seller Hub → Store catalog
export default function Catalog({ inventory = false }) {
  const [search, setSearch] = useSearchParams();
  const [params, setParams] = useState({ q: '', status: inventory ? '' : 'pending_verification', source: '', stock: inventory ? 'low' : '', page: 1 });
  const { data, error, loading, reload } = useCrmData('/catalog', params);
  const set = (k) => (e) => setParams({ ...params, [k]: e.target.value, page: 1 });
  const openId = search.get('product');
  return (
    <>
      <PageHead title={inventory ? 'Inventory' : 'Product verification'} subtitle={inventory ? 'Stock levels from the database: stock taken by orders and put back by cancellations and returns. Change stock in Seller Hub → Store catalog (or the seller’s own Products page).' : 'Only products an admin has verified can be shown or sold. Nothing is treated as genuine automatically.'} />
      {data && !data.requireVerification && <div className="alert warn">Verification isn’t enforced on this database yet: run <code>npm run db:setup</code> (it switches it on), or turn it on in Settings.</div>}
      {data && (
        <div className="kpis">
          {Object.entries(STATUS).map(([k, v]) => (
            <button key={k} type="button" className="kpi" style={{ textAlign: 'left', cursor: 'pointer', outline: params.status === k ? '2px solid var(--c-brand)' : 'none' }} onClick={() => setParams({ ...params, status: k, page: 1 })}>
              <span className="label">{v}</span><span className="value">{count(data.counts[k])}</span>
            </button>
          ))}
        </div>
      )}
      <section className="card flush">
        <div className="toolbar">
          <input type="search" placeholder="Search name, brand, seller or ID" value={params.q} onChange={set('q')} aria-label="Search products" />
          <select value={params.status} onChange={set('status')} aria-label="Status"><option value="">Every status</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <select value={params.source} onChange={set('source')} aria-label="Source"><option value="">Store and sellers</option><option value="store">Store catalog</option><option value="seller">Seller products</option></select>
          {inventory && <select value={params.stock} onChange={set('stock')} aria-label="Stock"><option value="">Any stock</option><option value="low">Low (1–9)</option><option value="out">Out of stock</option></select>}
        </div>
        <ErrorBox error={error} onRetry={reload} />
        {loading && !data ? <Loading /> : (
          <Table rows={data?.items.map((p) => ({ ...p, id: p._id }))} onRow={(p) => setSearch({ product: p._id })} empty="No products with this status" columns={[
            { key: 'name', label: 'Product', render: (p) => <span className="row" style={{ flexWrap: 'nowrap' }}>{p.image && <img src={p.image} alt="" width={40} height={40} style={{ objectFit: 'contain', background: '#fff', borderRadius: 6 }} />}<span>{p.name}<span className="sub">{p.brand} · {label(p.category)}{p.seller ? ` · ${p.seller}` : ''}</span></span></span> },
            { key: 'status', label: 'Status', render: (p) => <Badge tone={TONE[p.status]}>{STATUS[p.status]}</Badge> },
            { key: 'checks', label: 'Checks', num: true, render: (p) => `${p.checksDone}/${p.checksTotal}` },
            { key: 'price', label: 'Price', num: true, hideSm: true, render: (p) => money(p.price) },
            { key: 'stock', label: 'Stock', num: true, hideSm: true, render: (p) => count(p.stock) },
          ]} />
        )}
        <Pager data={data} onPage={(page) => setParams({ ...params, page })} />
      </section>
      {openId && <ProductDrawer id={openId} onClose={() => setSearch({})} onChange={reload} />}
    </>
  );
}
