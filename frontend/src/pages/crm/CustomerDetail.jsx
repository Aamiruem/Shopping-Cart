import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { crm } from '../../api/client';
import Icon from '../../components/common/Icon';
import { MessageModal, MessagesTable, NotesPanel, TaskModal } from '../../components/crm/shared';
import { ago, Badge, count, date, dateTime, ErrorBox, Kpi, Loading, Modal, money, PageHead, Table, useAction, useCrm, useCrmData } from '../../components/crm/ui';
import { CustomerForm } from './Customers';

const TABS = [['overview', 'Overview'], ['orders', 'Orders'], ['timeline', 'Timeline'], ['notes', 'Notes & activity'], ['messages', 'Communication'], ['support', 'Tickets & leads']];

export default function CustomerDetail() {
  const { id } = useParams();
  const { can, confirm } = useCrm();
  const { data: c, error, loading, reload } = useCrmData(`/customers/${id}`);
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [task, setTask] = useState(false);
  const [message, setMessage] = useState(false);
  const { run, busy } = useAction();

  if (!c) return loading ? <Loading /> : <><ErrorBox error={error} onRetry={reload} /><Link to="/crm/customers">Back to customers</Link></>;

  const save = async (body) => {
    if (await run(() => crm.patch(`/customers/${c.id}`, body), 'Customer updated')) {
      setEditing(false);
      reload();
    }
  };
  const toggleActive = async () => {
    if (c.status === 'active') {
      const reason = await confirm({ title: `Deactivate ${c.name}?`, message: 'They are signed out everywhere and can’t log in or order until you reactivate the account. Their orders and history stay.', input: 'Reason (kept in the audit log)', danger: true, confirmLabel: 'Deactivate' });
      if (reason && (await run(() => crm.patch(`/customers/${c.id}`, { status: 'inactive', reason }), 'Account deactivated'))) reload();
    } else if (await confirm({ title: `Reactivate ${c.name}?`, message: 'They can log in and order again.', confirmLabel: 'Reactivate' })) {
      if (await run(() => crm.patch(`/customers/${c.id}`, { status: 'active' }), 'Account reactivated')) reload();
    }
  };

  return (
    <>
      <p className="small"><Link to="/crm/customers">← Customers</Link></p>
      <PageHead title={c.name} subtitle={`${c.customer_code || `Customer #${c.id}`} · joined ${date(c.created_at)}${c.last_login ? ` · last login ${ago(c.last_login)}` : ''}`}>
        <Badge value={c.status} /> <Badge tone="info">{c.segmentLabel}</Badge>
        {can('customers.contact') && <button type="button" className="b" onClick={() => setMessage(true)}><Icon name="send" size={15} /> Message</button>}
        <button type="button" className="b" onClick={() => setTask(true)}><Icon name="clock" size={15} /> Follow-up</button>
        {can('customers.edit') && <button type="button" className="b" onClick={() => setEditing(true)}><Icon name="edit" size={15} /> Edit</button>}
        {can('customers.edit') && <button type="button" className={`b ${c.status === 'active' ? 'danger' : ''}`} onClick={toggleActive} disabled={busy}>{c.status === 'active' ? 'Deactivate' : 'Reactivate'}</button>}
      </PageHead>

      <div className="kpis">
        <Kpi label="Total spent" value={money(c.spent)} sub="Placed orders" />
        <Kpi label="Orders" value={count(c.orders)} />
        <Kpi label="Average order" value={money(c.averageOrder)} />
        <Kpi label="Last purchase" value={c.last_order ? ago(c.last_order) : '—'} sub={c.first_order ? `First ${date(c.first_order)}` : 'No orders yet'} />
      </div>

      <div className="tabs" role="tablist">
        {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {tab === 'overview' && (
        <div className="cards">
          <section className="card">
            <h2>Profile</h2>
            <dl className="dl">
              <dt>Email</dt><dd>{c.email} {c.email_verified && <Badge tone="good">verified</Badge>}</dd>
              <dt>Mobile</dt><dd>{c.phone || '—'} {c.phone_verified && <Badge tone="good">verified</Badge>}</dd>
              <dt>Owner</dt><dd>{c.assignee_name || 'Nobody'}</dd>
              <dt>Tags</dt><dd>{c.tags?.length ? c.tags.map((t) => <span key={t} className="badge" style={{ marginRight: 4 }}>{t}</span>) : '—'}</dd>
              <dt>Birthday</dt><dd>{date(c.birthday)}</dd>
              <dt>Anniversary</dt><dd>{date(c.anniversary)}</dd>
              <dt>Came from</dt><dd>{c.source}</dd>
              <dt>Marketing</dt><dd>Email {c.email_opt_in ? '✓' : '✗'} · SMS {c.sms_opt_in ? '✓' : '✗'} · WhatsApp {c.whatsapp_opt_in ? '✓' : '✗'}</dd>
            </dl>
          </section>
          <section className="card">
            <h2>Addresses</h2>
            {c.addresses.length ? c.addresses.map((a) => (
              <p key={a.id} style={{ margin: '0 0 10px' }}><strong>{a.name}</strong> · {a.phone}<br />{a.line1}{a.masked ? '' : `, ${a.city}, ${a.state} ${a.pincode}`}</p>
            )) : <p className="muted">No saved addresses.</p>}
          </section>
          <section className="card">
            <h2>Open tasks</h2>
            {c.tasks.filter((t) => ['pending', 'in_progress'].includes(t.status)).map((t) => <p key={t.id} style={{ margin: '0 0 8px' }}>{t.title}<br /><span className="muted small">{t.assignee} · {dateTime(t.due_at)}</span></p>)}
            {!c.tasks.some((t) => ['pending', 'in_progress'].includes(t.status)) && <p className="muted">None</p>}
          </section>
        </div>
      )}

      {tab === 'orders' && (
        <section className="card flush">
          <Table
            rows={c.orders}
            empty="No orders yet"
            columns={[
              { key: 'id', label: 'Order', render: (o) => <><Link to={`/crm/sales?order=${o.id}`}>#{o.id}</Link><span className="sub">{dateTime(o.created_at)}</span></> },
              { key: 'items', label: 'Items', render: (o) => <>{o.items[0]?.name}{o.items.length > 1 && <span className="sub">+{o.items.length - 1} more</span>}</> },
              { key: 'status', label: 'Status', render: (o) => <>{o.status === 'placed' ? <Badge value={o.fulfilment} /> : <Badge value={o.status} />}{o.return_status && <span className="sub">Return {o.return_status}</span>}</> },
              { key: 'pay', label: 'Payment', render: (o) => (o.payment_method === 'cod' ? 'Cash on delivery' : `Online · ${o.payment_status || 'paid'}`) },
              { key: 'total', label: 'Total', num: true, render: (o) => money(o.total) },
            ]}
          />
        </section>
      )}

      {tab === 'timeline' && (
        <section className="card">
          <ul className="timeline">{c.timeline.map((t, i) => <li key={i}><div>{t.text}<time>{dateTime(t.at)}</time></div></li>)}</ul>
        </section>
      )}

      {tab === 'notes' && <NotesPanel entity="customer" entityId={c.id} notes={c.notes} onChange={reload} />}

      {tab === 'messages' && <section className="card flush"><MessagesTable messages={c.messages} /></section>}

      {tab === 'support' && (
        <div className="cards">
          <section className="card flush">
            <div className="card-head" style={{ padding: '14px 16px 0' }}><h2>Tickets</h2></div>
            <Table rows={c.tickets} empty="No tickets" columns={[
              { key: 'id', label: 'Ticket', render: (t) => <Link to={`/crm/support?ticket=${t.id}`}>#{t.id} {t.subject}</Link> },
              { key: 'status', label: 'Status', render: (t) => <Badge value={t.status} /> },
              { key: 'created_at', label: 'Opened', render: (t) => date(t.created_at) },
            ]} />
          </section>
          <section className="card flush">
            <div className="card-head" style={{ padding: '14px 16px 0' }}><h2>Leads</h2></div>
            <Table rows={c.leads} empty="No leads" columns={[
              { key: 'id', label: 'Lead', render: (l) => <Link to={`/crm/leads?open=${l.id}`}>#{l.id} {l.summary}</Link> },
              { key: 'status', label: 'Stage', render: (l) => <Badge value={l.status} /> },
            ]} />
          </section>
        </div>
      )}

      {editing && (
        <Modal title={`Edit ${c.name}`} onClose={() => setEditing(false)} size="lg">
          <CustomerForm busy={busy} onCancel={() => setEditing(false)} onSave={({ phone, ...rest }) => { delete rest.email; save(c.masked ? rest : { ...rest, phone }); }}
            initial={{ id: c.id, name: c.name, email: c.email, phone: c.masked ? '' : c.phone || '', tags: (c.tags || []).join(', '), birthday: c.birthday?.slice(0, 10) || '', anniversary: c.anniversary?.slice(0, 10) || '', emailOptIn: c.email_opt_in, smsOptIn: c.sms_opt_in, whatsappOptIn: c.whatsapp_opt_in, assignedTo: c.assigned_to }} />
        </Modal>
      )}
      {task && <TaskModal link={{ customerId: c.id }} title={`Follow up with ${c.name}`} kind="customer_follow_up" onClose={() => setTask(false)} onDone={reload} />}
      {message && <MessageModal to={{ customerId: c.id }} onClose={() => setMessage(false)} onDone={reload} />}
    </>
  );
}
