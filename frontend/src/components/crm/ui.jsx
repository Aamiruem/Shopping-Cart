import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { crm } from '../../api/client';
import { downloadCsv, downloadXlsx, printTable } from '../../utils/exporters';
import Icon from '../common/Icon';

// ---------- Context: who is signed in, what they may do, toasts, confirmations ----------
export const CrmContext = createContext(null);
export const useCrm = () => useContext(CrmContext);

export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const show = useCallback((message, type = 'success') => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-3), { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  const view = (
    <div className="crm-toasts" aria-live="polite">
      {toasts.map((t) => <div key={t.id} className={`crm-toast ${t.type}`} role={t.type === 'error' ? 'alert' : 'status'}>{t.message}</div>)}
    </div>
  );
  return { show, view };
}

/** confirm({ title, message, confirmLabel, danger, input }) → Promise<false | true | string> */
export function useConfirm() {
  const [ask, setAsk] = useState(null);
  const confirm = useCallback((opts) => new Promise((resolve) => setAsk({ ...opts, resolve })), []);
  const [value, setValue] = useState('');
  const close = (result) => {
    ask?.resolve(result);
    setAsk(null);
    setValue('');
  };
  const view = ask && (
    <Modal title={ask.title} onClose={() => close(false)}>
      <p style={{ marginTop: 0 }}>{ask.message}</p>
      {ask.input && <label className="f">{ask.input}<textarea rows={3} value={value} onChange={(e) => setValue(e.target.value)} autoFocus /></label>}
      <div className="crm-modal-foot">
        <button type="button" className="b" onClick={() => close(false)}>Cancel</button>
        <button type="button" className={`b ${ask.danger ? 'danger solid' : 'primary'}`} disabled={ask.input && value.trim().length < 3} onClick={() => close(ask.input ? value.trim() : true)}>
          {ask.confirmLabel || 'Confirm'}
        </button>
      </div>
    </Modal>
  );
  return { confirm, view };
}

// ---------- Data ----------
/** Loads `path` with `params`; reloads when they change. Returns { data, error, loading, reload, setData }. */
export function useCrmData(path, params = null, { skip = false } = {}) {
  const key = JSON.stringify(params);
  const [state, setState] = useState({ data: null, error: '', loading: !skip });
  const seq = useRef(0);
  const reload = useCallback(() => {
    if (skip || !path) return;
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: '' }));
    crm.get(path, params || undefined)
      .then((data) => mine === seq.current && setState({ data, error: '', loading: false }))
      .catch((err) => mine === seq.current && setState((s) => ({ ...s, error: err.message, loading: false })));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key stands in for params
  }, [path, key, skip]);
  useEffect(reload, [reload]);
  return { ...state, reload, setData: (d) => setState((s) => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) };
}

/** Runs a change, shows its outcome, and returns the result (or null on failure) */
export function useAction() {
  const { toast } = useCrm();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, success) => {
    setBusy(true);
    try {
      const out = await fn();
      if (success) toast(typeof success === 'function' ? success(out) : success);
      return out ?? true;
    } catch (err) {
      toast(err.message, 'error');
      return null;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { run, busy };
}

// ---------- Formatting ----------
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
export const money = (v) => (v === null || v === undefined ? '—' : inr.format(Number(v) || 0));
export const count = (v) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('en-IN').format(v));
export const date = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const dateTime = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export function ago(v) {
  if (!v) return '—';
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return date(v);
}
export const label = (s) => (s ? String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '—');
export const pctText = (v) => (v === null || v === undefined ? '—' : `${v}%`);

const TONES = {
  good: ['won', 'completed', 'delivered', 'paid', 'active', 'resolved', 'closed', 'accepted', 'opened', 'clicked', 'sent', 'collected', 'refunded', 'received', 'healthy', 'low'],
  warn: ['pending', 'in_progress', 'waiting', 'contacted', 'qualified', 'proposal', 'negotiation', 'queued', 'sending', 'cod_pending', 'packed', 'shipped', 'approved', 'requested', 'refund_pending', 'medium', 'draft', 'warm'],
  bad: ['lost', 'cancelled', 'failed', 'bounced', 'overdue', 'inactive', 'high', 'rejected', 'hot', 'returned'],
  info: ['new', 'open', 'placed'],
};
export function Badge({ value, tone, children }) {
  const t = tone || Object.entries(TONES).find(([, list]) => list.includes(value))?.[0] || '';
  return <span className={`badge ${t}`}>{children ?? label(value)}</span>;
}

// ---------- Layout pieces ----------
export function PageHead({ title, subtitle, children }) {
  return (
    <div className="crm-page-head">
      <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      {children && <div className="crm-actions">{children}</div>}
    </div>
  );
}

export function Kpi({ label: l, value, sub, delta }) {
  return (
    <div className="kpi">
      <span className="label">{l}</span>
      <span className="value">{value}</span>
      {(sub || delta !== undefined) && (
        <span className="sub">
          {delta !== undefined && delta !== null && <span className={`delta ${delta >= 0 ? 'up' : 'down'}`}>{delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}% </span>}
          {sub}
        </span>
      )}
    </div>
  );
}

export function Loading({ text = 'Loading…' }) {
  return <div className="empty" role="status"><span className="spinner" /> <span>{text}</span></div>;
}
export function Empty({ title, children }) {
  return <div className="empty"><strong>{title}</strong>{children}</div>;
}
export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return <div className="alert" role="alert">{error} {onRetry && <button type="button" className="b sm" onClick={onRetry}>Try again</button>}</div>;
}

export function Modal({ title, onClose, children, size }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="crm-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`crm-modal ${size || ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="crm-modal-head"><h2 style={{ margin: 0 }}>{title}</h2><button type="button" className="b ghost" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button></div>
        {children}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children, actions }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="crm-overlay drawer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="crm-drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="crm-modal-head"><h2 style={{ margin: 0 }}>{title}</h2><div className="row">{actions}<button type="button" className="b ghost" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button></div></div>
        {children}
      </aside>
    </div>
  );
}

export function Pager({ data, onPage }) {
  if (!data || data.total === undefined) return null;
  const from = data.total ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = Math.min(data.page * data.pageSize, data.total);
  return (
    <div className="pager">
      <span>{from}–{to} of {count(data.total)}</span>
      <span className="row">
        <button type="button" className="b sm" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>Previous</button>
        <span>Page {data.page} of {data.pages}</span>
        <button type="button" className="b sm" disabled={data.page >= data.pages} onClick={() => onPage(data.page + 1)}>Next</button>
      </span>
    </div>
  );
}

/** columns: [{ key, label, render?, num?, hideSm?, sort? }] */
export function Table({ columns, rows, onRow, sort, onSort, empty = 'Nothing here yet' }) {
  if (!rows?.length) return <Empty title={empty} />;
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={`${c.num ? 'num' : ''} ${c.hideSm ? 'hide-sm' : ''}`} aria-sort={sort === c.sort ? 'descending' : undefined}>
                {c.sort && onSort ? <button type="button" onClick={() => onSort(c.sort)}>{c.label}{sort === c.sort ? ' ▾' : ''}</button> : c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? i} className={onRow ? 'click' : ''} onClick={onRow ? () => onRow(r) : undefined} tabIndex={onRow ? 0 : undefined} onKeyDown={onRow ? (e) => e.key === 'Enter' && onRow(r) : undefined}>
              {columns.map((c) => <td key={c.key} className={`${c.num ? 'num' : ''} ${c.hideSm ? 'hide-sm' : ''}`}>{c.render ? c.render(r) : r[c.key] ?? '—'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** CSV / Excel / PDF for a set of rows. `load` fetches all rows (server-side filters), `columns` [{ key, label }]. */
export function ExportMenu({ name, title, columns, load, disabled }) {
  const { toast } = useCrm();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async (kind) => {
    setBusy(true);
    try {
      const rows = await load();
      if (!rows.length) return toast('Nothing to export', 'error');
      const stamp = new Date().toISOString().slice(0, 10);
      if (kind === 'csv') downloadCsv(`${name}-${stamp}`, columns, rows);
      if (kind === 'xlsx') downloadXlsx(`${name}-${stamp}`, columns, rows, title);
      if (kind === 'pdf' && !printTable(title, columns, rows, `${rows.length} rows`)) toast('Allow pop-ups to print or save as PDF', 'error');
      if (kind !== 'pdf') toast(`Downloaded ${rows.length} rows`);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };
  return (
    <span style={{ position: 'relative' }}>
      <button type="button" className="b" onClick={() => setOpen((o) => !o)} disabled={disabled || busy} aria-expanded={open}><Icon name="download" size={15} /> {busy ? 'Preparing…' : 'Export'}</button>
      {open && (
        <span className="crm-feed" style={{ width: 200 }}>
          {[['csv', 'CSV'], ['xlsx', 'Excel (.xlsx)'], ['pdf', 'PDF (print)']].map(([k, l]) => (
            <a key={k} href="#export" onClick={(e) => { e.preventDefault(); go(k); }}>{l}</a>
          ))}
        </span>
      )}
    </span>
  );
}

export function DateRange({ value, onChange }) {
  const presets = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '12 months']];
  const iso = (d) => d.toISOString().slice(0, 10);
  const set = (days) => onChange({ from: iso(new Date(Date.now() - (days - 1) * 86_400_000)), to: iso(new Date()) });
  return (
    <span className="row">
      {presets.map(([d, l]) => <button key={d} type="button" className="b sm" onClick={() => set(d)}>{l}</button>)}
      <input type="date" value={value.from} max={value.to} onChange={(e) => onChange({ ...value, from: e.target.value })} aria-label="From" />
      <input type="date" value={value.to} min={value.from} onChange={(e) => onChange({ ...value, to: e.target.value })} aria-label="To" />
    </span>
  );
}
export const defaultRange = (days = 30) => ({ from: new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) });

export function Field({ label: l, children, hint }) {
  return <label className="f">{l}{children}{hint && <span className="muted small" style={{ fontWeight: 400 }}>{hint}</span>}</label>;
}

/** Team members a record can be assigned to (filtered by the permission the work needs) */
export function useTeam(permission) {
  const { data } = useCrmData('/team', permission ? { permission } : null);
  return data || [];
}

export function AssignSelect({ value, onChange, permission, disabled, allowNone = true }) {
  const team = useTeam(permission);
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)} disabled={disabled} aria-label="Assigned to">
      {allowNone && <option value="">Unassigned</option>}
      {team.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.roleName})</option>)}
    </select>
  );
}
