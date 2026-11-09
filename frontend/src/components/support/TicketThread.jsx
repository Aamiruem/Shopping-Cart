import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import useApi from '../../hooks/useApi';
import { formatDate } from '../../utils/format';
import { ErrorMessage, Spinner } from '../common/Feedback';
import Icon from '../common/Icon';

export const TICKET_STATUS = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };
const when = (d) => formatDate(d, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// One complaint and its conversation. `staff` (the admin) can also change its status.
export default function TicketThread({ id, staff = false, onChange }) {
  const toast = useToast();
  const { data: ticket, error, loading, reload } = useApi(() => api.ticket(id), [id]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  if (error) return <ErrorMessage message={error} onRetry={reload} />;
  if (loading && !ticket) return <Spinner />; // a reload keeps the conversation on screen

  const send = async (e) => {
    e.preventDefault();
    if (message.trim().length < 2) return;
    setBusy(true);
    try {
      await api.replyTicket(id, message.trim());
      setMessage('');
      reload();
      onChange?.();
    } catch (err) {
      toast.show(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status) => {
    try {
      await api.updateTicket(id, status);
      toast.show(`Ticket #${id} marked ${TICKET_STATUS[status].toLowerCase()}`);
      reload();
      onChange?.();
    } catch (err) {
      toast.show(err.message, 'error');
    }
  };

  return (
    <div className="ticket-thread">
      <p className="muted small">
        {ticket.categoryLabel} · {TICKET_STATUS[ticket.status]}
        {ticket.order_id && <> · {staff ? `Order #${ticket.order_id}` : <Link to={`/orders/${ticket.order_id}`}>Order #{ticket.order_id}</Link>}</>}
        {staff && <> · {ticket.customer_name}{ticket.customer_email ? ` (${ticket.customer_email})` : ''} · {ticket.priority} priority</>}
      </p>
      <ol className="thread">
        <li className="msg mine-customer">
          <span className="msg-meta">{staff ? ticket.customer_name : 'You'} · {when(ticket.created_at)}</span>
          <p>{ticket.message}</p>
        </li>
        {ticket.suggested_reply && (
          <li className="msg from-staff auto">
            <span className="msg-meta"><Icon name="zap" size={12} /> Instant answer</span>
            <p>{ticket.suggested_reply}</p>
          </li>
        )}
        {(ticket.messages || []).map((m) => (
          <li key={m.id} className={`msg ${m.staff ? 'from-staff' : 'mine-customer'}`}>
            <span className="msg-meta">{m.staff ? 'Arvixa support' : staff ? m.author : 'You'} · {when(m.created_at)}</span>
            <p>{m.body}</p>
          </li>
        ))}
      </ol>
      <form className="thread-reply" onSubmit={send}>
        <label className="field">
          {staff ? 'Reply to the customer' : ticket.status === 'resolved' ? 'Still need help? Reply to reopen this ticket' : 'Add a reply'}
          <textarea rows={2} maxLength={4000} value={message} onChange={(e) => setMessage(e.target.value)} />
        </label>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || message.trim().length < 2}>
            <Icon name="send" size={14} /> {busy ? 'Sending…' : 'Send'}
          </button>
          {staff && Object.entries(TICKET_STATUS).filter(([s]) => s !== ticket.status).map(([s, label]) => (
            <button key={s} type="button" className="btn-text" onClick={() => setStatus(s)}>Mark {label.toLowerCase()}</button>
          ))}
        </div>
      </form>
    </div>
  );
}
