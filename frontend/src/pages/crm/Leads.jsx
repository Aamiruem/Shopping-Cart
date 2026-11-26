import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, crm } from '../../api/client';
import Icon from '../../components/common/Icon';
import { MessageModal, MessagesTable, NotesPanel, TaskModal } from '../../components/crm/shared';
import { ago, AssignSelect, Badge, dateTime, Drawer, ErrorBox, ExportMenu, Field, label, Loading, Modal, money, PageHead, Pager, Table, useAction, useCrm, useCrmData } from '../../components/crm/ui';

export const STAGES = { new: 'New lead', contacted: 'Contacted', qualified: 'Qualified', proposal: 'Proposal sent', negotiation: 'Negotiation', won: 'Converted', lost: 'Lost', unsubscribed: 'Unsubscribed' };
const scoreTone = (band) => (band === 'hot' ? 'bad' : band === 'warm' ? 'warn' : 'none');

function LeadDrawer({ id, onClose, onChange }) {
  const { can, confirm } = useCrm();
  const { data: l, error, reload } = useCrmData(`/leads/${id}`);
  const { run, busy } = useAction();
  const [comment, setComment] = useState('');
  const [task, setTask] = useState(false);
  const [message, setMessage] = useState(false);
  const [tab, setTab] = useState('details');
  const patch = async (body, done) => {
    if (await run(() => api.updateLead(id, body), done)) {
      reload();
      onChange();
    }
  };
  const erase = async () => {
    if (await confirm({ title: 'Erase this lead?', message: 'For a person who asked to be forgotten. This can’t be undone (the audit log keeps that it happened, not the details).', danger: true, confirmLabel: 'Erase' })) {
      if (await run(() => api.deleteLead(id), 'Lead erased')) {
        onChange();
        onClose();
      }
    }
  };
  return (
    <Drawer title={l ? `${l.name || 'Lead'} · #${l.id}` : 'Lead'} onClose={onClose}
      actions={l && <>{can('notes.write') && <button type="button" className="b sm" onClick={() => setTask(true)}>Follow-up task</button>}{can('leads.edit') && <button type="button" className="b sm" onClick={() => setMessage(true)}>Message</button>}</>}>
      <ErrorBox error={error} onRetry={reload} />
      {!l ? <Loading /> : (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <Badge value={l.status}>{STAGES[l.status]}</Badge>
            <Badge tone={scoreTone(l.band)}>Score {l.score} · {l.band}</Badge>
            <Badge tone="info">{label(l.source)}</Badge>
            <span className="muted small">{l.kindLabel} · received {dateTime(l.created_at)}</span>
          </div>
          <div className="tabs">
            {[['details', 'Details'], ['activity', `Activity (${l.activities.length})`], ['messages', 'Messages'], ['history', 'History']].map(([k, t]) => <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t}</button>)}
          </div>
          {tab === 'details' && (
            <div className="stack">
              <section className="card">
                <dl className="dl">
                  <dt>Email</dt><dd>{l.email || '—'}</dd>
                  <dt>Mobile</dt><dd>{l.phone || '—'}</dd>
                  {l.user_id && <><dt>Customer</dt><dd><Link to={`/crm/customers/${l.user_id}`}>Open profile</Link></dd></>}
                  <dt>Budget</dt><dd>{l.budget ? `up to ${money(l.budget)}` : '—'}</dd>
                  {l.quantity && <><dt>Quantity</dt><dd>{l.quantity} units</dd></>}
                  {l.product && <><dt>Interested in</dt><dd><a href={`/products/${l.product._id}`} target="_blank" rel="noreferrer">{l.product.name}</a> · {money(l.product.price)} · {l.product.stock > 0 ? `${l.product.stock} in stock` : 'out of stock'}</dd></>}
                  <dt>Marketing</dt><dd>{l.marketing_consent ? 'Agreed' : 'Not agreed'}</dd>
                  {l.converted_order_id && <><dt>Converted</dt><dd><Link to={`/crm/sales?order=${l.converted_order_id}`}>Order #{l.converted_order_id}</Link></dd></>}
                </dl>
                {l.message && <blockquote style={{ margin: '12px 0 0', padding: '8px 12px', borderLeft: '3px solid var(--c-brand)', background: 'var(--c-raised)', whiteSpace: 'pre-wrap' }}>{l.message}</blockquote>}
              </section>
              {l.matches?.length > 0 && (
                <section className="card"><h3>In stock now for this enquiry</h3>
                  {l.matches.map((p) => <p key={p._id} style={{ margin: '0 0 6px' }}><a href={`/products/${p._id}`} target="_blank" rel="noreferrer">{p.name}</a> · {money(p.price)} · {p.stock} left</p>)}
                </section>
              )}
              {l.suggestedReply && (
                <section className="card"><h3>Suggested first reply</h3><p style={{ marginTop: 0 }}>{l.suggestedReply}</p>
                  <button type="button" className="b sm" onClick={() => navigator.clipboard?.writeText(l.suggestedReply)}><Icon name="copy" size={14} /> Copy</button>
                  <p className="muted small">Written from the enquiry and current stock. Never sent automatically.</p></section>
              )}
              <section className="card">
                <h3>Why this score</h3>
                {l.reasons.map((r) => <div key={r.why} className="row small"><span className={`delta ${r.points > 0 ? 'up' : 'down'}`}>{r.points > 0 ? '+' : ''}{r.points}</span> {r.why}</div>)}
                <p className="muted small">A points system with every reason shown, not a trained model.</p>
              </section>
              {can('leads.edit') && (
                <section className="card stack">
                  <div className="grid2">
                    <Field label="Stage"><select value={l.status} disabled={busy} onChange={(e) => patch({ status: e.target.value }, 'Stage updated')}>{Object.entries(STAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                    <Field label="Assigned to"><AssignSelect value={l.assigned_to} disabled={!can('leads.assign') || busy} permission="leads.view" onChange={(v) => patch({ assignedTo: v }, 'Assigned')} /></Field>
                    <Field label="Follow up on"><input type="date" value={l.follow_up_on || ''} onChange={(e) => patch({ followUpOn: e.target.value || null }, 'Follow-up date saved')} /></Field>
                  </div>
                  <form className="row" onSubmit={async (e) => { e.preventDefault(); await patch({ note: comment }, 'Comment added'); setComment(''); }}>
                    <input style={{ flex: 1 }} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Internal comment" minLength={1} required />
                    <button type="submit" className="b" disabled={busy}>Add comment</button>
                  </form>
                  {can('leads.delete') && <div><button type="button" className="b sm danger" onClick={erase}>Erase lead</button></div>}
                </section>
              )}
            </div>
          )}
          {tab === 'activity' && <NotesPanel entity="lead" entityId={l.id} notes={l.activities} onChange={reload} />}
          {tab === 'messages' && <section className="card flush"><MessagesTable messages={l.messages} /></section>}
          {tab === 'history' && (
            <section className="card">
              <ul className="timeline">{[...(l.notes || [])].reverse().map((n, i) => <li key={i}><div>{n.text}<time>{n.by} · {dateTime(n.at)}</time></div></li>)}</ul>
              {!l.notes?.length && <p className="muted">No changes yet.</p>}
              {l.tasks.length > 0 && <><h3>Tasks</h3>{l.tasks.map((t) => <p key={t.id} className="small">{t.title} · <Badge value={t.status} /> · {t.assignee} · {dateTime(t.due_at)}</p>)}</>}
            </section>
          )}
        </>
      )}
      {task && l && <TaskModal link={{ leadId: l.id }} title={`Follow up: ${l.name || 'lead'}`} kind="lead_follow_up" onClose={() => setTask(false)} onDone={reload} />}
      {message && l && <MessageModal to={{ leadId: l.id }} onClose={() => setMessage(false)} onDone={reload} />}
    </Drawer>
  );
}

function NewLead({ onClose, onDone }) {
  const { run, busy } = useAction();
  const { confirm } = useCrm();
  const [f, setF] = useState({ name: '', email: '', phone: '', requirements: '', budget: '', followUpOn: '', assignedTo: null, marketingConsent: false });
  const save = async (e, allowDuplicate = false) => {
    e?.preventDefault();
    try {
      const out = await crm.post('/leads', { ...f, budget: f.budget || null, allowDuplicate });
      onDone(out);
      onClose();
    } catch (err) {
      if (/already has an open lead/.test(err.message) && (await confirm({ title: 'Possible duplicate', message: err.message, confirmLabel: 'Add another lead' }))) return save(null, true);
      await run(() => Promise.reject(err));
    }
    return undefined;
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Modal title="Add a lead" onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <div className="grid2">
          <Field label="Name"><input required minLength={2} value={f.name} onChange={set('name')} /></Field>
          <Field label="Mobile"><input value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Email"><input type="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="Budget (₹)"><input type="number" min="1" value={f.budget} onChange={set('budget')} /></Field>
          <Field label="Follow up on"><input type="date" value={f.followUpOn} onChange={set('followUpOn')} /></Field>
          <Field label="Assign to"><AssignSelect value={f.assignedTo} onChange={(v) => setF({ ...f, assignedTo: v })} permission="leads.view" /></Field>
        </div>
        <Field label="Requirements"><textarea rows={3} value={f.requirements} onChange={set('requirements')} placeholder="What they’re looking for, quantities, timing" /></Field>
        <label className="check"><input type="checkbox" checked={f.marketingConsent} onChange={set('marketingConsent')} /> They agreed to receive marketing messages</label>
        <div className="crm-modal-foot"><button type="button" className="b" onClick={onClose}>Cancel</button><button type="submit" className="b primary" disabled={busy}>Add lead</button></div>
      </form>
    </Modal>
  );
}

function Board({ data, open, onMove }) {
  const [over, setOver] = useState(null);
  return (
    <div className="board">
      {data.stages.map((s) => (
        <div key={s.stage} className={`lane ${over === s.stage ? 'over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(s.stage); }} onDragLeave={() => setOver(null)}
          onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData('text/lead'); if (id) onMove(Number(id), s.stage); }}>
          <h3><span>{STAGES[s.stage]}</span><span className="muted">{s.leads.length}</span></h3>
          {s.leads.map((l) => (
            <div key={l.id} className="lead-card" draggable onDragStart={(e) => e.dataTransfer.setData('text/lead', String(l.id))} onClick={() => open(l.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open(l.id)}>
              <div className="row" style={{ justifyContent: 'space-between' }}><strong>{l.name || l.email || l.phone}</strong><Badge tone={scoreTone(l.band)}>{l.score}</Badge></div>
              <p>{l.summary}</p>
              <span className="muted small">{label(l.source)} · {ago(l.created_at)}{l.assignee_name ? ` · ${l.assignee_name}` : ''}{l.follow_up_on ? ` · follow up ${l.follow_up_on}` : ''}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function Leads() {
  const { can, me } = useCrm();
  const [search, setSearch] = useSearchParams();
  const [view, setView] = useState('board');
  const [params, setParams] = useState({ q: '', status: 'open', source: '', assigned: '', due: '', sort: 'created', page: 1 });
  const board = useCrmData('/leads', { view: 'board', q: params.q, source: params.source, assigned: params.assigned }, { skip: view !== 'board' });
  const list = useCrmData('/leads', params, { skip: view !== 'list' });
  const [adding, setAdding] = useState(false);
  const { run } = useAction();
  const openId = search.get('open');
  const reload = () => (view === 'board' ? board.reload() : list.reload());
  const set = (k) => (e) => setParams({ ...params, [k]: e.target.value, page: 1 });
  useEffect(() => {
    if (openId && view === 'board' && board.data && !board.data.stages.some((s) => s.leads.some((l) => String(l.id) === openId))) setView('list');
  }, [openId, view, board.data]);

  const move = async (id, stage) => {
    board.setData((d) => {
      const lead = d.stages.flatMap((s) => s.leads).find((l) => l.id === id);
      if (!lead || lead.status === stage) return d;
      return { stages: d.stages.map((s) => ({ ...s, leads: s.stage === stage ? [{ ...lead, status: stage }, ...s.leads] : s.leads.filter((l) => l.id !== id) })) };
    });
    if (!(await run(() => api.updateLead(id, { status: stage }), `Moved to ${STAGES[stage]}`))) board.reload();
  };
  const sync = async () => {
    const out = await run(() => crm.post('/leads/sync'), (o) => `Checked now: ${o.registration} sign-ups, ${o.abandonedCart} abandoned carts, ${o.converted} converted`);
    if (out) reload();
  };

  return (
    <>
      <PageHead title="Leads" subtitle="Enquiries, quotes, sign-ups without an order, abandoned carts and WhatsApp messages, captured automatically">
        <span className="row"><button type="button" className={`b ${view === 'board' ? 'primary' : ''}`} onClick={() => setView('board')}>Pipeline</button><button type="button" className={`b ${view === 'list' ? 'primary' : ''}`} onClick={() => setView('list')}>List</button></span>
        {can('leads.edit') && <button type="button" className="b" onClick={sync}><Icon name="rotate" size={15} /> Capture now</button>}
        {can('reports.export') && <ExportMenu name="leads" title="Leads" columns={[{ key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' }, { key: 'source', label: 'Source' }, { key: 'kindLabel', label: 'Kind' }, { key: 'status', label: 'Stage' }, { key: 'score', label: 'Score' }, { key: 'budget', label: 'Budget' }, { key: 'assignee_name', label: 'Assigned to' }, { key: 'follow_up_on', label: 'Follow up' }, { key: 'created_at', label: 'Received' }, { key: 'summary', label: 'Summary' }]}
          load={async () => (await crm.get('/leads', { ...params, page: 1, pageSize: 100 })).items} />}
        {can('leads.edit') && <button type="button" className="b primary" onClick={() => setAdding(true)}><Icon name="plus" size={15} /> Add lead</button>}
      </PageHead>
      <div className="toolbar card" style={{ marginBottom: 12 }}>
        <input type="search" placeholder="Search name, email, phone or message" value={params.q} onChange={set('q')} aria-label="Search leads" />
        <select value={params.source} onChange={set('source')} aria-label="Source"><option value="">All sources</option>{(me.leadSources || []).filter((s) => s !== 'newsletter').map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
        <select value={params.assigned} onChange={set('assigned')} aria-label="Assigned"><option value="">Anyone</option><option value="me">Assigned to me</option><option value="none">Unassigned</option></select>
        {view === 'list' && <select value={params.status} onChange={set('status')} aria-label="Stage"><option value="open">Open</option><option value="">All</option>{Object.entries(STAGES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}
        {view === 'list' && <label className="check"><input type="checkbox" checked={params.due === '1'} onChange={(e) => setParams({ ...params, due: e.target.checked ? '1' : '', page: 1 })} /> Follow-ups due</label>}
      </div>
      {view === 'board' ? (
        <>
          <ErrorBox error={board.error} onRetry={board.reload} />
          {board.data ? <Board data={board.data} open={(id) => setSearch({ open: id })} onMove={can('leads.edit') ? move : () => {}} /> : <Loading />}
          <p className="muted small">Drag a card to move it to another stage. Converted and lost leads are in the List view.</p>
        </>
      ) : (
        <section className="card flush">
          <ErrorBox error={list.error} onRetry={list.reload} />
          {list.loading && !list.data ? <Loading /> : (
            <Table rows={list.data?.items} onRow={(l) => setSearch({ open: l.id })} sort={params.sort} onSort={(sort) => setParams({ ...params, sort })} empty="No leads match"
              columns={[
                { key: 'name', label: 'Lead', sort: 'name', render: (l) => <>{l.name || l.email || l.phone}<span className="sub">{l.summary}</span></> },
                { key: 'status', label: 'Stage', render: (l) => <Badge value={l.status}>{STAGES[l.status]}</Badge> },
                { key: 'score', label: 'Score', sort: 'score', num: true, render: (l) => <Badge tone={scoreTone(l.band)}>{l.score}</Badge> },
                { key: 'source', label: 'Source', hideSm: true, render: (l) => label(l.source) },
                { key: 'budget', label: 'Budget', sort: 'budget', num: true, hideSm: true, render: (l) => (l.budget ? money(l.budget) : '—') },
                { key: 'assignee_name', label: 'Owner', hideSm: true, render: (l) => l.assignee_name || '—' },
                { key: 'follow_up_on', label: 'Follow up', sort: 'follow_up', hideSm: true, render: (l) => l.follow_up_on || '—' },
                { key: 'created_at', label: 'Received', sort: 'created', render: (l) => ago(l.created_at) },
              ]} />
          )}
          <Pager data={list.data} onPage={(page) => setParams({ ...params, page })} />
        </section>
      )}
      {openId && <LeadDrawer id={openId} onClose={() => setSearch({})} onChange={reload} />}
      {adding && <NewLead onClose={() => setAdding(false)} onDone={(l) => { reload(); setSearch({ open: l.id }); }} />}
    </>
  );
}
