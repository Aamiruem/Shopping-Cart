import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { crm } from '../../api/client';
import Icon from '../../components/common/Icon';
import { TaskModal } from '../../components/crm/shared';
import { ago, AssignSelect, Badge, dateTime, Drawer, ErrorBox, Field, Kpi, label, Loading, Modal, PageHead, Pager, Table, useAction, useCrm, useCrmData } from '../../components/crm/ui';

export const TICKET_STATUS = { open: 'Open', in_progress: 'In progress', waiting: 'Waiting for customer', resolved: 'Resolved', closed: 'Closed' };

function TicketDrawer({ id, onClose, onChange }) {
  const { can } = useCrm();
  const { data: t, error, reload } = useCrmData(`/tickets/${id}`);
  const { run, busy } = useAction();
  const [reply, setReply] = useState({ message: '', internal: false, status: '' });
  const [task, setTask] = useState(false);
  const update = async (body, msg) => {
    if (await run(() => crm.patch(`/tickets/${id}`, body), msg)) {
      reload();
      onChange();
    }
  };
  const send = async (e) => {
    e.preventDefault();
    const out = await run(() => crm.post(`/tickets/${id}/messages`, { message: reply.message, internal: reply.internal, ...(reply.status ? { status: reply.status } : {}) }), reply.internal ? 'Internal note added' : 'Reply sent to the customer');
    if (out) {
      setReply({ message: '', internal: false, status: '' });
      reload();
      onChange();
    }
  };
  return (
    <Drawer title={t ? `#${t.id} ${t.subject}` : 'Ticket'} onClose={onClose} actions={t && <button type="button" className="b sm" onClick={() => setTask(true)}>Follow-up task</button>}>
      <ErrorBox error={error} onRetry={reload} />
      {!t ? <Loading /> : (
        <div className="stack">
          <div className="row">
            <Badge value={t.status}>{TICKET_STATUS[t.status]}</Badge><Badge value={t.priority}>{t.priority} priority</Badge><Badge tone="info">{t.categoryLabel}</Badge>
            {t.responseBreached && <Badge tone="bad">First response overdue</Badge>}
            <span className="muted small">Opened {dateTime(t.created_at)}{t.firstResponseHours !== null ? ` · first reply after ${t.firstResponseHours} h` : t.firstResponseDue ? ` · reply due ${dateTime(t.firstResponseDue)}` : ''}</span>
          </div>
          <section className="card">
            <dl className="dl">
              <dt>Customer</dt><dd>{t.user_id ? <Link to={`/crm/customers/${t.user_id}`}>{t.customer}</Link> : '—'} · {t.email}</dd>
              {t.order && <><dt>Order</dt><dd><Link to={`/crm/sales?order=${t.order.id}`}>#{t.order.id}</Link> · {label(t.order.status)} · ₹{Math.round(t.order.total).toLocaleString('en-IN')}</dd></>}
              <dt>Mood</dt><dd>{t.sentiment < -0.2 ? 'Upset' : t.sentiment > 0.2 ? 'Positive' : 'Neutral'} ({t.sentiment}) <span className="muted small">word-list estimate</span></dd>
            </dl>
          </section>
          {can('support.edit') && (
            <section className="card grid3">
              <Field label="Status"><select value={t.status} onChange={(e) => update({ status: e.target.value }, 'Status updated')} disabled={busy}>{Object.entries(TICKET_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              <Field label="Priority"><select value={t.priority} onChange={(e) => update({ priority: e.target.value }, 'Priority updated')} disabled={busy}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></Field>
              <Field label="Agent"><AssignSelect value={t.assigned_to} permission="support.edit" onChange={(v) => update({ assignedTo: v }, 'Assigned')} disabled={busy} /></Field>
            </section>
          )}
          <div className="msg"><header><strong>{t.customer}</strong><span>{dateTime(t.created_at)}</span></header><p>{t.message}</p></div>
          {t.messages.map((m) => (
            <div key={m.id} className={`msg ${m.internal ? 'internal' : m.staff ? 'staff' : ''}`}>
              <header><strong>{m.internal ? `Internal note · ${m.author}` : m.staff ? `${m.author} (team)` : m.author}</strong><span>{dateTime(m.created_at)}</span></header>
              <p>{m.body}</p>
            </div>
          ))}
          {can('support.edit') && (
            <form className="card stack" onSubmit={send}>
              <div className="row">
                <button type="button" className={`b sm ${!reply.internal ? 'primary' : ''}`} onClick={() => setReply({ ...reply, internal: false })}>Reply to customer</button>
                <button type="button" className={`b sm ${reply.internal ? 'primary' : ''}`} onClick={() => setReply({ ...reply, internal: true })}>Internal note</button>
                {t.suggested_reply && !reply.internal && <button type="button" className="b sm ghost" onClick={() => setReply({ ...reply, message: t.suggested_reply })}>Use suggested reply</button>}
              </div>
              <textarea rows={5} required minLength={2} value={reply.message} onChange={(e) => setReply({ ...reply, message: e.target.value })} placeholder={reply.internal ? 'Only the team sees this' : 'The customer sees this on their Help page (and by email if set up)'} />
              <div className="row">
                {!reply.internal && <Field label="Then set status"><select value={reply.status} onChange={(e) => setReply({ ...reply, status: e.target.value })}><option value="">Keep / In progress</option><option value="waiting">Waiting for customer</option><option value="resolved">Resolved</option></select></Field>}
                <button type="submit" className="b primary" disabled={busy} style={{ alignSelf: 'end' }}>{reply.internal ? 'Add note' : 'Send reply'}</button>
              </div>
            </form>
          )}
          {t.history.length > 0 && <section className="card"><h3>History</h3><ul className="timeline">{t.history.map((h, i) => <li key={i}><div>{label(h.action.replace('ticket.', ''))} by {h.actor_name} {Object.keys(h.details || {}).length ? `· ${Object.entries(h.details).map(([k, v]) => `${k}: ${v}`).join(', ')}` : ''}<time>{dateTime(h.created_at)}</time></div></li>)}</ul></section>}
        </div>
      )}
      {task && t && <TaskModal link={{ ticketId: t.id }} title={`Follow up on ticket #${t.id}`} kind="support_follow_up" onClose={() => setTask(false)} onDone={reload} />}
    </Drawer>
  );
}

function NewTicket({ onClose, onDone }) {
  const { run, busy } = useAction();
  const [q, setQ] = useState('');
  const { data: found } = useCrmData('/customers', { q, pageSize: 8 }, { skip: q.trim().length < 2 });
  const [f, setF] = useState({ customerId: null, customerName: '', subject: '', message: '', orderId: '', priority: '' });
  const save = async (e) => {
    e.preventDefault();
    const out = await run(() => crm.post('/tickets', { ...f, priority: f.priority || undefined, orderId: f.orderId || undefined }), 'Ticket created');
    if (out) onDone(out);
  };
  return (
    <Modal title="New ticket for a customer" onClose={onClose}>
      <form className="stack" onSubmit={save}>
        {f.customerId ? <p>Customer: <strong>{f.customerName}</strong> <button type="button" className="b sm ghost" onClick={() => setF({ ...f, customerId: null })}>Change</button></p> : (
          <Field label="Customer"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email or phone" />
            {found?.items?.map((c) => <button key={c.id} type="button" className="b sm ghost" style={{ justifyContent: 'flex-start' }} onClick={() => setF({ ...f, customerId: c.id, customerName: c.name })}>{c.name} · {c.email}</button>)}
          </Field>
        )}
        <Field label="Subject"><input required minLength={3} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
        <Field label="What they said"><textarea rows={4} required minLength={10} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
        <div className="grid2">
          <Field label="Order number (optional)"><input value={f.orderId} onChange={(e) => setF({ ...f, orderId: e.target.value.replace(/\D/g, '') })} /></Field>
          <Field label="Priority"><select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option value="">Decide from the message</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></Field>
        </div>
        <div className="crm-modal-foot"><button type="button" className="b" onClick={onClose}>Cancel</button><button type="submit" className="b primary" disabled={busy || !f.customerId}>Create ticket</button></div>
      </form>
    </Modal>
  );
}

export default function Support() {
  const { can } = useCrm();
  const [search, setSearch] = useSearchParams();
  const [params, setParams] = useState({ q: '', status: '', priority: '', category: '', assigned: '', page: 1 });
  const { data, error, loading, reload } = useCrmData('/tickets', params);
  const [creating, setCreating] = useState(false);
  const set = (k) => (e) => setParams({ ...params, [k]: e.target.value, page: 1 });
  const m = data?.metrics;
  const openId = search.get('ticket');
  return (
    <>
      <PageHead title="Support" subtitle="Complaints, order problems, returns and questions from the Help page and order pages">
        {can('support.edit') && <button type="button" className="b primary" onClick={() => setCreating(true)}><Icon name="plus" size={15} /> New ticket</button>}
      </PageHead>
      {m && (
        <div className="kpis">
          <Kpi label="Open" value={m.open} sub={`${m.urgent} urgent · ${m.unassigned} unassigned`} />
          <Kpi label="In progress" value={m.in_progress} />
          <Kpi label="Waiting for customer" value={m.waiting} />
          <Kpi label="Median first response" value={m.median_first_response_hours === null ? '—' : `${m.median_first_response_hours} h`} sub={`Target ${data.sla.firstResponseHours} h · ${m.breached_30d} missed (30 days)`} />
          <Kpi label="Median resolution" value={m.median_resolution_hours === null ? '—' : `${m.median_resolution_hours} h`} sub={`Target ${data.sla.resolutionHours} h`} />
        </div>
      )}
      <section className="card flush">
        <div className="toolbar">
          <input type="search" placeholder="Search ticket number, subject, message or customer" value={params.q} onChange={set('q')} aria-label="Search tickets" />
          <select value={params.status} onChange={set('status')} aria-label="Status"><option value="">Not finished</option><option value="all">All</option>{Object.entries(TICKET_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <select value={params.priority} onChange={set('priority')} aria-label="Priority"><option value="">Any priority</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>
          <select value={params.category} onChange={set('category')} aria-label="Category"><option value="">All categories</option>{Object.entries(data?.categories || {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <select value={params.assigned} onChange={set('assigned')} aria-label="Agent"><option value="">Any agent</option><option value="me">Mine</option><option value="none">Unassigned</option></select>
        </div>
        <ErrorBox error={error} onRetry={reload} />
        {loading && !data ? <Loading /> : (
          <Table rows={data?.items} onRow={(t) => setSearch({ ticket: t.id })} empty="No tickets here" columns={[
            { key: 'subject', label: 'Ticket', render: (t) => <>#{t.id} {t.subject}<span className="sub">{t.customer} · {t.categoryLabel}</span></> },
            { key: 'status', label: 'Status', render: (t) => <><Badge value={t.status}>{TICKET_STATUS[t.status]}</Badge>{t.last_from_staff === false && ['open', 'in_progress'].includes(t.status) && <span className="sub">Customer waiting on us</span>}</> },
            { key: 'priority', label: 'Priority', render: (t) => <><Badge value={t.priority} />{t.responseBreached && <span className="sub" style={{ color: 'var(--c-bad)' }}>Response overdue</span>}</> },
            { key: 'assignee', label: 'Agent', hideSm: true, render: (t) => t.assignee || '—' },
            { key: 'updated_at', label: 'Updated', render: (t) => ago(t.updated_at) },
          ]} />
        )}
        <Pager data={data} onPage={(page) => setParams({ ...params, page })} />
      </section>
      {openId && <TicketDrawer id={openId} onClose={() => setSearch({})} onChange={reload} />}
      {creating && <NewTicket onClose={() => setCreating(false)} onDone={(t) => { setCreating(false); reload(); setSearch({ ticket: t.id }); }} />}
    </>
  );
}
