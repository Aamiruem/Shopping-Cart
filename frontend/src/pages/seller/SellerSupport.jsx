import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../../api/client';
import { ErrorMessage, Spinner } from '../../components/common/Feedback';
import Icon from '../../components/common/Icon';
import TicketThread, { TICKET_STATUS } from '../../components/support/TicketThread';
import { useAuth } from '../../context/AuthContext';
import useApi from '../../hooks/useApi';
import { formatDate } from '../../utils/format';

const PRIORITY_TONE = { high: 'error', medium: 'warn', low: 'ok' };

// Admin only: every customer complaint, unresolved and most urgent first. Open one to reply or resolve it.
export default function SellerSupport() {
  const { user } = useAuth();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(null);
  const { data: tickets, error, loading, reload } = useApi(() => api.tickets({ status }), [status]);
  if (user.role !== 'admin') return <Navigate to="/seller/orders" replace />;

  return (
    <div className="panel seller-products">
      <header className="seller-head">
        <div>
          <h1>Complaints</h1>
          <p className="muted small">Customer tickets, with the team and urgency picked from what they wrote. Your replies show on their account page.</p>
        </div>
        <div className="segmented" role="group" aria-label="Ticket status">
          {[['', 'All'], ...Object.entries(TICKET_STATUS)].map(([id, label]) => (
            <button key={id} type="button" className={status === id ? 'active' : ''} onClick={() => setStatus(id)}>{label}</button>
          ))}
        </div>
      </header>
      <ErrorMessage message={error} onRetry={reload} />
      {loading && !tickets ? <Spinner /> : (
        <ul className="address-list ticket-cards">
          {(tickets || []).map((t) => (
            <li key={t.id}>
              <button type="button" className="ticket-toggle" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}>
                <span className={`status-pill tone-${PRIORITY_TONE[t.priority]}`}>{t.priority}</span>
                <span>
                  <strong>#{t.id} {t.subject}</strong>
                  <span className="muted small block">{t.customer_name} · {t.categoryLabel}{t.order_id ? ` · Order #${t.order_id}` : ''} · {formatDate(t.updated_at || t.created_at)}</span>
                </span>
                <span className={`chip ticket-${t.status}`}>{TICKET_STATUS[t.status]}</span>
                {!t.last_from_staff && t.status !== 'resolved' && <span className="chip chip-new">Awaiting reply</span>}
                <Icon name={open === t.id ? 'chevronDown' : 'chevronRight'} size={16} />
              </button>
              {open === t.id && <TicketThread id={t.id} staff onChange={reload} />}
            </li>
          ))}
          {tickets && !tickets.length && <p className="muted">No tickets here.</p>}
        </ul>
      )}
    </div>
  );
}
