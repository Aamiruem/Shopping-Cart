import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorMessage, Spinner } from '../../components/common/Feedback';
import Icon from '../../components/common/Icon';
import { useAuth } from '../../context/AuthContext';
import useApi from '../../hooks/useApi';
import { formatDate, formatPrice } from '../../utils/format';

const INTENT_TONE = { high: 'error', medium: 'warn', low: 'ok' };
const STATUS = { new: 'New', contacted: 'Contacted', qualified: 'Qualified', won: 'Won', lost: 'Lost' };
const SOURCE = { contact: 'Contact form', product: 'Product enquiry', quote: 'Quote request', newsletter: 'Newsletter', assistant: 'Shopping assistant' };
const KIND = { purchase: 'Wants to buy', product_enquiry: 'Product question', support: 'Support', business: 'Business', newsletter: 'Newsletter' };

function LeadDetail({ lead, onSaved }) {
  const [notes, setNotes] = useState(lead.notes || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async (patch) => {
    setBusy(true);
    setError('');
    try {
      await api.updateLead(lead.id, patch);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="lead-detail">
      {lead.message && <blockquote className="lead-message">{lead.message}</blockquote>}
      <dl className="lead-facts">
        <div><dt>Contact</dt><dd>{[lead.name, lead.email, lead.phone].filter(Boolean).join(' · ') || 'None given'}{lead.consent ? ' (agreed to be contacted)' : ''}</dd></div>
        {lead.product && <div><dt>Product</dt><dd><Link to={`/products/${lead.product.id}`}>{lead.product.name || lead.product.id}</Link></dd></div>}
        {lead.budget !== null && <div><dt>Budget</dt><dd>{formatPrice(lead.budget)}</dd></div>}
        <div><dt>Next step</dt><dd>{lead.nextStep}</dd></div>
        {lead.recommended.length > 0 && (
          <div>
            <dt>In stock that fits</dt>
            <dd>{lead.recommended.map((p, i) => (
              <span key={p.id}>{i > 0 && ', '}<Link to={`/products/${p.id}`}>{p.name}</Link> {formatPrice(p.price)}{p.inStock ? '' : ' (now sold out)'}</span>
            ))}</dd>
          </div>
        )}
        {lead.convertedOrder && <div><dt>Ordered</dt><dd>Order #{lead.convertedOrder.id}, {formatPrice(lead.convertedOrder.total)} on {formatDate(lead.convertedOrder.at)}</dd></div>}
      </dl>
      <label className="field">Notes
        <textarea rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Called, sent options, follow up on Friday…" />
      </label>
      <div className="lead-actions">
        <div className="segmented" role="group" aria-label="Lead status">
          {Object.entries(STATUS).map(([id, label]) => (
            <button key={id} type="button" disabled={busy} className={lead.status === id ? 'active' : ''} onClick={() => save({ status: id, notes })}>{label}</button>
          ))}
        </div>
        <button type="button" className="btn btn-outline" disabled={busy || notes === (lead.notes || '')} onClick={() => save({ notes })}>Save notes</button>
      </div>
      <ErrorMessage message={error} />
    </div>
  );
}

// Admin only: enquiries from forms, quote requests, the newsletter and the shopping assistant, scored by purchase intent
export default function SellerLeads() {
  const { user } = useAuth();
  const [intent, setIntent] = useState('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(null);
  const { data, error, loading, reload } = useApi(() => api.leads({ intent, status }), [intent, status]);
  if (user.role !== 'admin') return <Navigate to="/seller/orders" replace />;
  const stats = data?.stats;

  return (
    <div className="panel seller-products">
      <header className="seller-head">
        <div>
          <h1>Leads</h1>
          <p className="muted small">Enquiries people sent, with what they need, how ready they are to buy, and in-stock products that fit. Contact details are only what they gave, with consent.</p>
        </div>
        <div className="segmented" role="group" aria-label="Purchase intent">
          {[['', 'All'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']].map(([id, label]) => (
            <button key={id} type="button" className={intent === id ? 'active' : ''} onClick={() => setIntent(id)}>{label}</button>
          ))}
        </div>
      </header>
      {stats && (
        <div className="lead-stats">
          <div><strong>{stats.total}</strong><span>leads</span></div>
          <div><strong>{stats.high}</strong><span>high intent</span></div>
          <div><strong>{stats.new}</strong><span>not yet contacted</span></div>
          <div><strong>{stats.converted}</strong><span>ordered afterwards</span></div>
          <div><strong>{stats.conversionRate === null ? '—' : `${stats.conversionRate}%`}</strong><span>conversion (contactable)</span></div>
        </div>
      )}
      <div className="segmented lead-status-filter" role="group" aria-label="Lead status">
        {[['', 'Any status'], ...Object.entries(STATUS)].map(([id, label]) => (
          <button key={id} type="button" className={status === id ? 'active' : ''} onClick={() => setStatus(id)}>{label}</button>
        ))}
      </div>
      <ErrorMessage message={error} onRetry={reload} />
      {loading && !data ? <Spinner /> : (
        <ul className="address-list ticket-cards">
          {(data?.leads || []).map((l) => (
            <li key={l.id}>
              <button type="button" className="ticket-toggle" aria-expanded={open === l.id} onClick={() => setOpen(open === l.id ? null : l.id)}>
                <span className={`status-pill tone-${INTENT_TONE[l.intent]}`}>{l.intent}</span>
                <span>
                  <strong>{l.summary}</strong>
                  <span className="muted small block">{SOURCE[l.source]} · {KIND[l.kind]}{l.name ? ` · ${l.name}` : ''} · {formatDate(l.createdAt)}</span>
                </span>
                <span className="chip">{STATUS[l.status]}</span>
                {l.convertedOrder && <span className="chip chip-new">Ordered</span>}
                <Icon name={open === l.id ? 'chevronDown' : 'chevronRight'} size={16} />
              </button>
              {open === l.id && <LeadDetail lead={l} onSaved={reload} />}
            </li>
          ))}
          {data && !data.leads.length && <p className="muted">No leads here yet.</p>}
        </ul>
      )}
    </div>
  );
}
