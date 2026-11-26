import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { crm } from '../../api/client';
import Icon from '../../components/common/Icon';
import { AssignSelect, Badge, count, date, ErrorBox, ExportMenu, Field, Loading, Modal, money, PageHead, Pager, Table, useAction, useCrm, useCrmData } from '../../components/crm/ui';
import { parseCsv } from '../../utils/exporters';

const EXPORT_COLUMNS = [
  { key: 'customerId', label: 'Customer ID' }, { key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' }, { key: 'status', label: 'Status' },
  { key: 'segment', label: 'Segment' }, { key: 'orders', label: 'Orders' }, { key: 'spent', label: 'Total spent (₹)' }, { key: 'averageOrder', label: 'Average order (₹)' },
  { key: 'lastOrder', label: 'Last order' }, { key: 'joined', label: 'Joined' }, { key: 'tags', label: 'Tags' }, { key: 'assignedTo', label: 'Owner' },
  { key: 'emailOptIn', label: 'Email consent' }, { key: 'smsOptIn', label: 'SMS consent' }, { key: 'whatsappOptIn', label: 'WhatsApp consent' },
];

export function CustomerForm({ initial = {}, onSave, onCancel, busy }) {
  const [f, setF] = useState({ name: '', email: '', phone: '', tags: '', birthday: '', anniversary: '', emailOptIn: false, smsOptIn: false, whatsappOptIn: false, consentConfirmed: false, assignedTo: null, ...initial });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const anyConsent = f.emailOptIn || f.smsOptIn || f.whatsappOptIn;
  const submit = (e) => {
    e.preventDefault();
    onSave({ ...f, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean), birthday: f.birthday || null, anniversary: f.anniversary || null });
  };
  return (
    <form className="stack" onSubmit={submit}>
      <div className="grid2">
        <Field label="Full name"><input required minLength={2} value={f.name} onChange={set('name')} /></Field>
        <Field label="Email"><input type="email" required={!initial.id} disabled={Boolean(initial.id)} value={f.email} onChange={set('email')} /></Field>
        <Field label="Mobile" hint="10 digits"><input inputMode="tel" value={f.phone ?? ''} onChange={set('phone')} /></Field>
        <Field label="Tags" hint="Comma separated"><input value={f.tags} onChange={set('tags')} placeholder="wholesale, vip" /></Field>
        <Field label="Birthday"><input type="date" value={f.birthday ?? ''} onChange={set('birthday')} /></Field>
        <Field label="Anniversary"><input type="date" value={f.anniversary ?? ''} onChange={set('anniversary')} /></Field>
        <Field label="Owner"><AssignSelect value={f.assignedTo} onChange={(v) => setF({ ...f, assignedTo: v })} permission="customers.view" /></Field>
      </div>
      <fieldset className="card" style={{ padding: 12 }}>
        <legend className="small muted">Marketing consent</legend>
        <div className="row">
          <label className="check"><input type="checkbox" checked={f.emailOptIn} onChange={set('emailOptIn')} /> Email</label>
          <label className="check"><input type="checkbox" checked={f.smsOptIn} onChange={set('smsOptIn')} /> SMS</label>
          <label className="check"><input type="checkbox" checked={f.whatsappOptIn} onChange={set('whatsappOptIn')} /> WhatsApp</label>
        </div>
        {anyConsent && <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={f.consentConfirmed} onChange={set('consentConfirmed')} required /> The customer agreed to this themselves (recorded with the date)</label>}
      </fieldset>
      <div className="crm-modal-foot">
        <button type="button" className="b" onClick={onCancel}>Cancel</button>
        <button type="submit" className="b primary" disabled={busy}>{busy ? 'Saving…' : 'Save customer'}</button>
      </div>
    </form>
  );
}

function ImportModal({ onClose, onDone }) {
  const { run, busy } = useAction();
  const [rows, setRows] = useState(null);
  const [result, setResult] = useState(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const read = async (file) => {
    setError('');
    setResult(null);
    if (!file) return;
    if (file.size > 2_000_000) return setError('Please use a file under 2 MB (about 1,000 customers)');
    const parsed = parseCsv(await file.text());
    if (!parsed.length) return setError('No rows found. The first line must be the column names: name, email, phone, tags, birthday, emailOptIn');
    setRows(parsed);
    const out = await run(() => crm.post('/customers/import', { rows: parsed, dryRun: true, consentConfirmed: true }));
    if (out) setResult(out);
  };
  const needsConsent = rows?.some((r) => ['yes', 'true'].includes(String(r.emailOptIn).toLowerCase()));
  const commit = async () => {
    const out = await run(() => crm.post('/customers/import', { rows, consentConfirmed: consent }), (r) => `Imported ${r.counts.created || 0} customers`);
    if (out) {
      setResult(out);
      onDone();
    }
  };
  return (
    <Modal title="Import customers" onClose={onClose} size="lg">
      <p className="muted" style={{ marginTop: 0 }}>A CSV file with a header row: <code>name, email, phone, tags, birthday, emailOptIn</code>. Tags are separated by <code>;</code>. Existing emails are skipped, never overwritten. Nothing is saved until you confirm.</p>
      <input type="file" accept=".csv,text/csv" onChange={(e) => read(e.target.files?.[0])} />
      <ErrorBox error={error} />
      {result && (
        <div className="stack" style={{ marginTop: 12 }}>
          <div className="row">
            {Object.entries(result.counts).map(([k, v]) => <Badge key={k} tone={k === 'error' ? 'bad' : k === 'skipped' ? 'warn' : 'good'}>{v} {k === 'ok' ? 'ready' : k}</Badge>)}
            {result.dryRun && <span className="muted small">Check only: nothing saved yet</span>}
          </div>
          <Table columns={[{ key: 'line', label: 'Line' }, { key: 'email', label: 'Email' }, { key: 'result', label: 'Result', render: (r) => <Badge tone={r.result === 'error' ? 'bad' : 'warn'}>{r.result}</Badge> }, { key: 'reason', label: 'Why' }]}
            rows={result.results.filter((r) => r.result !== 'ok' && r.result !== 'created').slice(0, 50)} empty="Every row is valid" />
          {result.dryRun && needsConsent && <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Customers marked emailOptIn=yes agreed to marketing emails themselves</label>}
        </div>
      )}
      <div className="crm-modal-foot">
        <button type="button" className="b" onClick={onClose}>Close</button>
        {result?.dryRun && <button type="button" className="b primary" disabled={busy || !result.counts.ok || (needsConsent && !consent)} onClick={commit}>Import {result.counts.ok || 0} customers</button>}
      </div>
    </Modal>
  );
}

export default function Customers() {
  const { can, confirm } = useCrm();
  const navigate = useNavigate();
  const [params, setParams] = useState({ q: '', status: '', segment: '', tag: '', assigned: '', sort: 'joined', page: 1 });
  const { data, error, loading, reload } = useCrmData('/customers', params);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const { run, busy } = useAction();
  const set = (k) => (e) => setParams({ ...params, [k]: e.target.value, page: 1 });

  const create = async (body) => {
    let out = await run(() => crm.post('/customers', body), 'Customer added');
    if (!out && body.phone && (await confirm({ title: 'Same mobile number', message: 'If the message above says this number is on another customer, are they a different person? Add them anyway?', confirmLabel: 'Add anyway' }))) {
      out = await run(() => crm.post('/customers', { ...body, confirmDuplicatePhone: true }), 'Customer added');
    }
    if (out) navigate(`/crm/customers/${out.id}`);
  };

  return (
    <>
      <PageHead title="Customers" subtitle="Every account on the store, with orders and spend from the order history">
        {can('customers.import') && <button type="button" className="b" onClick={() => setImporting(true)}><Icon name="upload" size={15} /> Import</button>}
        {can('customers.export') && <ExportMenu name="customers" title="Customers" columns={EXPORT_COLUMNS} load={async () => (await crm.get('/customers/export', params)).rows} />}
        {can('customers.edit') && <button type="button" className="b primary" onClick={() => setAdding(true)}><Icon name="plus" size={15} /> Add customer</button>}
      </PageHead>
      <section className="card flush">
        <div className="toolbar">
          <input type="search" placeholder="Search name, email, phone or ID" value={params.q} onChange={set('q')} aria-label="Search customers" />
          <select value={params.segment} onChange={set('segment')} aria-label="Segment">
            <option value="">All segments</option>
            {Object.entries(data?.segments || {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={params.status} onChange={set('status')} aria-label="Status"><option value="">Active and inactive</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
          <select value={params.tag} onChange={set('tag')} aria-label="Tag"><option value="">Any tag</option>{(data?.tags || []).map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>)}</select>
          <select value={params.assigned} onChange={set('assigned')} aria-label="Owner"><option value="">Any owner</option><option value="me">Mine</option><option value="none">No owner</option></select>
        </div>
        <ErrorBox error={error} onRetry={reload} />
        {loading && !data ? <Loading /> : (
          <Table
            rows={data?.items}
            sort={params.sort}
            onSort={(sort) => setParams({ ...params, sort, page: 1 })}
            onRow={(c) => navigate(`/crm/customers/${c.id}`)}
            empty="No customers match"
            columns={[
              { key: 'name', label: 'Customer', sort: 'name', render: (c) => <>{c.name}<span className="sub">{c.customer_code} · {c.email}{c.phone ? ` · ${c.phone}` : ''}</span></> },
              { key: 'segment', label: 'Segment', render: (c) => <><Badge tone={c.segment === 'loyal' || c.segment === 'returning' ? 'good' : c.segment === 'at_risk' || c.segment === 'lost' ? 'bad' : c.segment === 'new' ? 'info' : 'none'}>{c.segmentLabel}</Badge>{c.status === 'inactive' && <> <Badge value="inactive" /></>}</> },
              { key: 'orders', label: 'Orders', num: true, sort: 'orders', render: (c) => count(c.orders) },
              { key: 'spent', label: 'Spent', num: true, sort: 'spent', render: (c) => <>{money(c.spent)}<span className="sub">avg {money(c.averageOrder)}</span></> },
              { key: 'last_order', label: 'Last order', sort: 'last_order', hideSm: true, render: (c) => date(c.last_order) },
              { key: 'created_at', label: 'Joined', sort: 'joined', hideSm: true, render: (c) => date(c.created_at) },
              { key: 'tags', label: 'Tags', hideSm: true, render: (c) => (c.tags || []).map((t) => <span key={t} className="badge" style={{ marginRight: 4 }}>{t}</span>) },
              { key: 'assignee_name', label: 'Owner', hideSm: true, render: (c) => c.assignee_name || '—' },
            ]}
          />
        )}
        <Pager data={data} onPage={(page) => setParams({ ...params, page })} />
      </section>
      {adding && <Modal title="Add customer" onClose={() => setAdding(false)} size="lg"><CustomerForm onSave={create} onCancel={() => setAdding(false)} busy={busy} /><p className="muted small">The customer can sign in with a one-time code, or set a password with “Forgot password”. Nobody, including admins, sets or sees their password.</p></Modal>}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={reload} />}
    </>
  );
}
