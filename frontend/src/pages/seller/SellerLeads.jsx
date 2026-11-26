import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorMessage, Spinner } from '../../components/common/Feedback';
import Icon from '../../components/common/Icon';
import { useAuth } from '../../context/AuthContext';
import useApi from '../../hooks/useApi';
import { formatDate, formatPrice } from '../../utils/format';

export const LEAD_STATUS = { new: 'New', contacted: 'Contacted', qualified: 'Qualified', proposal: 'Proposal sent', negotiation: 'Negotiation', won: 'Won', lost: 'Lost', unsubscribed: 'Unsubscribed' };
const INTENT_TONE = { high: 'error', medium: 'warn', low: 'ok' };
const INTENT_LABEL = { high: 'Hot', medium: 'Warm', low: 'Cold' };
const FILTERS = [['open', 'Open'], ['', 'All'], ['won', 'Won'], ['lost', 'Lost']];
const KINDS = [['', 'All kinds'], ['product_enquiry', 'Product enquiries'], ['quote', 'Bulk / quotes'], ['business', 'Business'], ['support', 'Support'], ['newsletter', 'Newsletter']];

const productPath = (p) => `/products/${p._id}`;

// One enquiry: what they asked, what's in stock for it right now, a reply to start from, and the follow-up controls
function LeadDetail({ lead, team, onChange }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async (patch) => {
    setBusy(true);
    setError('');
    try {
      await api.updateLead(lead.id, patch);
      if (patch.note) setNote('');
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteLead(lead.id);
      onChange();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="lead-detail">
      <dl className="lead-facts">
        {lead.email && <div><dt>Email</dt><dd>{lead.email}</dd></div>}
        {lead.phone && <div><dt>Mobile</dt><dd>{lead.phone}</dd></div>}
        {lead.budget && <div><dt>Budget</dt><dd>up to {formatPrice(lead.budget)}</dd></div>}
        {lead.quantity && <div><dt>Quantity</dt><dd>{lead.quantity.toLocaleString('en-IN')} units</dd></div>}
        <div><dt>Marketing emails</dt><dd>{lead.marketing_consent ? 'Agreed' : 'No'}</dd></div>
        <div><dt>Received</dt><dd>{formatDate(lead.created_at)}</dd></div>
        {lead.converted_order_id && <div><dt>Converted</dt><dd className="text-success">Order #{lead.converted_order_id}</dd></div>}
      </dl>
      {lead.message && <blockquote className="lead-message">{lead.message}</blockquote>}
      {lead.product && <p className="small">About: <Link to={productPath(lead.product)} className="btn-link">{lead.product.name}</Link> · {formatPrice(lead.product.price)} · {lead.product.stock > 0 ? `${lead.product.stock} in stock` : 'out of stock'}</p>}

      {['product_enquiry', 'quote'].includes(lead.kind) && (
        <div className="lead-matches">
          <p className="small"><strong>In stock now{lead.budget ? ` within budget` : ''}</strong> <span className="muted">(live catalog prices)</span></p>
          {lead.matches.length ? (
            <ul>
              {lead.matches.map((p) => (
                <li key={p._id}><Link to={productPath(p)} className="btn-link">{p.name}</Link> <span className="muted small">{formatPrice(p.price)} · {p.stock} in stock</span></li>
              ))}
            </ul>
          ) : <p className="muted small">Nothing in the catalog matches this enquiry{lead.budget ? ' within the budget' : ''}.</p>}
        </div>
      )}

      {lead.suggestedReply && (
        <div className="suggested-reply">
          <p className="small"><Icon name="zap" size={12} /> <strong>Suggested reply</strong> <span className="muted">(not sent; copy it into your email or WhatsApp)</span></p>
          <p>{lead.suggestedReply}</p>
        </div>
      )}

      <div className="lead-controls">
        <label className="field">Status
          <select value={lead.status} disabled={busy} onChange={(e) => save({ status: e.target.value })}>
            {Object.entries(LEAD_STATUS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label className="field">Assigned to
          <select value={lead.assigned_to ?? ''} disabled={busy} onChange={(e) => save({ assignedTo: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Nobody</option>
            {team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label className="field">Follow up on
          <input type="date" value={lead.follow_up_on || ''} disabled={busy} onChange={(e) => save({ followUpOn: e.target.value || null })} />
        </label>
      </div>

      <form className="lead-note" onSubmit={(e) => { e.preventDefault(); if (note.trim()) save({ note }); }}>
        <label className="field">Add a note<input value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Called, sending a quote tomorrow" /></label>
        <button type="submit" className="btn btn-outline btn-sm" disabled={busy || !note.trim()}>Save note</button>
      </form>
      {error && <p className="alert alert-error" role="alert">{error}</p>}

      {lead.notes.length > 0 && (
        <ol className="lead-timeline">
          {[...lead.notes].reverse().map((n, i) => <li key={`${n.at}-${i}`}><span className="muted small">{formatDate(n.at)} · {n.by}</span> {n.text}</li>)}
        </ol>
      )}

      <div className="lead-danger">
        {confirmDelete ? (
          <>
            <span className="small">Delete this enquiry and the contact details in it? This can’t be undone.</span>
            <button type="button" className="btn btn-sm btn-outline danger" disabled={busy} onClick={remove}>Delete</button>
            <button type="button" className="btn btn-sm btn-outline" onClick={() => setConfirmDelete(false)}>Keep</button>
          </>
        ) : (
          <button type="button" className="btn-link small" onClick={() => setConfirmDelete(true)}><Icon name="trash" size={13} /> Delete (e.g. when the person asks)</button>
        )}
      </div>
    </div>
  );
}

// Admin only: enquiries and newsletter sign-ups people sent through the store, most promising first
export default function SellerLeads() {
  const { user } = useAuth();
  const [status, setStatus] = useState('open');
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const isAdmin = user.role === 'admin';
  const { data: leads, error, loading, reload } = useApi(() => (isAdmin ? api.leads({ status, kind, q }) : Promise.resolve([])), [status, kind, q, isAdmin]);
  const { data: summary, reload: reloadSummary } = useApi(() => (isAdmin ? api.leadSummary() : Promise.resolve(null)), [isAdmin]);
  if (!isAdmin) return <Navigate to="/seller/orders" replace />;

  const team = summary?.team || [];
  const refresh = () => {
    reload();
    reloadSummary();
  };
  const cards = summary ? [
    { key: 'new', label: 'New enquiries', value: summary.new, icon: 'mail', tone: 'blue' },
    { key: 'hot', label: 'Hot (open)', value: summary.hot, icon: 'zap', tone: 'orange' },
    { key: 'due', label: 'Follow-ups due', value: summary.due, icon: 'clock', tone: 'purple' },
    { key: 'conv', label: 'Became orders', value: summary.conversionRate === null ? '—' : `${summary.conversionRate}%`, note: `${summary.converted} of ${summary.enquiries} · ${summary.subscribers} subscribers`, icon: 'shoppingBag', tone: 'green' },
  ] : [];

  return (
    <div className="panel seller-products seller-leads">
      <header className="seller-head">
        <div>
          <h1>Leads &amp; enquiries</h1>
          <p className="muted small">What people asked through the contact, product and newsletter forms, with their consent. Kind and “hot / warm / cold” are keyword rules; product matches are your live catalog.</p>
        </div>
      </header>
      {cards.length > 0 && (
        <div className="stat-cards">
          {cards.map((c) => (
            <div key={c.key} className={`stat-card tone-${c.tone}`}>
              <span className="nav-chip"><Icon name={c.icon} size={18} /></span>
              <div><span>{c.label}</span><strong>{c.value}</strong>{c.note && <small>{c.note}</small>}</div>
            </div>
          ))}
        </div>
      )}
      <div className="lead-filters">
        <div className="segmented" role="group" aria-label="Lead status">
          {FILTERS.map(([id, label]) => <button key={id} type="button" className={status === id ? 'active' : ''} onClick={() => setStatus(id)}>{label}</button>)}
        </div>
        <select aria-label="Kind of enquiry" value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <form role="search" onSubmit={(e) => { e.preventDefault(); setQ(search.trim()); }}>
          <input type="search" aria-label="Search leads" placeholder="Name, email, phone or words" value={search} onChange={(e) => setSearch(e.target.value)} />
        </form>
      </div>
      <ErrorMessage message={error} onRetry={reload} />
      {loading && !leads ? <Spinner /> : (
        <ul className="address-list ticket-cards">
          {(leads || []).map((l) => (
            <li key={l.id}>
              <button type="button" className="ticket-toggle" aria-expanded={open === l.id} onClick={() => setOpen(open === l.id ? null : l.id)}>
                <span className={`status-pill tone-${INTENT_TONE[l.intent]}`}>{INTENT_LABEL[l.intent]}</span>
                <span>
                  <strong>{l.name || l.email || l.phone}</strong>
                  <span className="muted small block">{l.summary}</span>
                  <span className="muted small block">{l.kindLabel} · {formatDate(l.created_at)}{l.assignee_name ? ` · ${l.assignee_name}` : ''}{l.follow_up_on ? ` · follow up ${l.follow_up_on}` : ''}</span>
                </span>
                {l.converted_order_id && <span className="chip ticket-resolved">Ordered</span>}
                <span className={`chip lead-${l.status}`}>{LEAD_STATUS[l.status]}</span>
                <Icon name={open === l.id ? 'chevronDown' : 'chevronRight'} size={16} />
              </button>
              {open === l.id && <LeadDetail lead={l} team={team} onChange={refresh} />}
            </li>
          ))}
          {leads && !leads.length && <p className="muted">No enquiries here yet.</p>}
        </ul>
      )}
    </div>
  );
}
