import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { crm } from '../../api/client';
import Icon from '../../components/common/Icon';
import { TaskModal } from '../../components/crm/shared';
import { AssignSelect, Badge, dateTime, ErrorBox, Field, label, Loading, Modal, PageHead, Pager, Table, useAction, useCrm, useCrmData } from '../../components/crm/ui';

const STATUS = { pending: 'Pending', in_progress: 'In progress', completed: 'Completed', overdue: 'Overdue', cancelled: 'Cancelled' };

function EditTask({ task, onClose, onDone }) {
  const { can, confirm } = useCrm();
  const { run, busy } = useAction();
  const local = (d) => (d ? new Date(new Date(d).getTime() - new Date(d).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
  const [f, setF] = useState({ title: task.title, description: task.description || '', priority: task.priority, status: task.status, dueAt: local(task.due_at), assignedTo: task.assigned_to });
  const save = async (e) => {
    e.preventDefault();
    if (await run(() => crm.patch(`/tasks/${task.id}`, { ...f, dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : null }), 'Task saved')) onDone();
  };
  const remove = async () => {
    if ((await confirm({ title: 'Delete task?', message: task.title, danger: true, confirmLabel: 'Delete' })) && (await run(() => crm.del(`/tasks/${task.id}`), 'Task deleted'))) onDone();
  };
  return (
    <Modal title="Task" onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label="Title"><input required minLength={3} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Details"><textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div className="grid2">
          <Field label="Status"><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{['pending', 'in_progress', 'completed', 'cancelled'].map((s) => <option key={s} value={s}>{STATUS[s]}</option>)}</select></Field>
          <Field label="Priority"><select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></Field>
          <Field label="Due"><input type="datetime-local" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></Field>
          {can('tasks.manage') && <Field label="Assigned to"><AssignSelect value={f.assignedTo} onChange={(v) => setF({ ...f, assignedTo: v })} allowNone={false} /></Field>}
        </div>
        {(task.lead_id || task.customer_id || task.ticket_id) && (
          <p className="small">Linked: {task.lead_id && <Link to={`/crm/leads?open=${task.lead_id}`}>Lead {task.lead_name || `#${task.lead_id}`}</Link>} {task.customer_id && <Link to={`/crm/customers/${task.customer_id}`}>{task.customer_name}</Link>} {task.ticket_id && <Link to={`/crm/support?ticket=${task.ticket_id}`}>Ticket #{task.ticket_id}</Link>}</p>
        )}
        <p className="muted small">Created by {task.creator || '—'}{task.completed_at ? ` · completed ${dateTime(task.completed_at)}` : ''}</p>
        <div className="crm-modal-foot"><button type="button" className="b danger" onClick={remove}>Delete</button><span style={{ flex: 1 }} /><button type="button" className="b" onClick={onClose}>Cancel</button><button type="submit" className="b primary" disabled={busy}>Save</button></div>
      </form>
    </Modal>
  );
}

function Calendar({ month, setMonth, assigned, onOpen }) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7)); // weeks start on Monday
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const { data, error } = useCrmData('/tasks', { from: iso(days[0]), to: iso(days[41]), status: 'all', assigned, pageSize: 500 });
  const byDay = useMemo(() => {
    const m = new Map();
    for (const t of data?.items || []) {
      const k = iso(new Date(t.due_at));
      m.set(k, [...(m.get(k) || []), t]);
    }
    return m;
  }, [data]);
  const today = iso(new Date());
  return (
    <section className="card">
      <div className="card-head">
        <h2>{month.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</h2>
        <span className="row">
          <button type="button" className="b sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month"><Icon name="chevronLeft" size={14} /></button>
          <button type="button" className="b sm" onClick={() => setMonth(new Date())}>Today</button>
          <button type="button" className="b sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month"><Icon name="chevronRight" size={14} /></button>
        </span>
      </div>
      <ErrorBox error={error} />
      <div className="cal">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="dow">{d}</div>)}
        {days.map((d) => {
          const k = iso(d);
          return (
            <div key={k} className={`${d.getMonth() !== month.getMonth() ? 'out' : ''} ${k === today ? 'today' : ''}`}>
              <span className="d">{d.getDate()}</span>
              {(byDay.get(k) || []).map((t) => (
                <span key={t.id} className={`ev ${t.overdue ? 'overdue' : ''} ${t.status === 'completed' ? 'done' : ''}`} title={`${t.title} · ${t.assignee || ''}`} onClick={() => onOpen(t)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(t)}>
                  {new Date(t.due_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} {t.title}
                </span>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function Tasks() {
  const { can } = useCrm();
  const [view, setView] = useState('list');
  const [params, setParams] = useState({ status: '', assigned: 'me', q: '', kind: '', page: 1 });
  const { data, error, loading, reload } = useCrmData('/tasks', params, { skip: view !== 'list' });
  const [month, setMonth] = useState(new Date());
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const { run } = useAction();
  const set = (k) => (e) => setParams({ ...params, [k]: e.target.value, page: 1 });
  const complete = async (t) => (await run(() => crm.patch(`/tasks/${t.id}`, { status: 'completed' }), 'Done')) && reload();
  return (
    <>
      <PageHead title="Tasks & follow-ups" subtitle="Overdue is automatic: any open task past its due time">
        <span className="row"><button type="button" className={`b ${view === 'list' ? 'primary' : ''}`} onClick={() => setView('list')}>List</button><button type="button" className={`b ${view === 'calendar' ? 'primary' : ''}`} onClick={() => setView('calendar')}>Calendar</button></span>
        <button type="button" className="b primary" onClick={() => setCreating(true)}><Icon name="plus" size={15} /> New task</button>
      </PageHead>
      <div className="toolbar card" style={{ marginBottom: 12 }}>
        {view === 'list' && <input type="search" placeholder="Search tasks" value={params.q} onChange={set('q')} aria-label="Search tasks" />}
        {view === 'list' && <select value={params.status} onChange={set('status')} aria-label="Status"><option value="">Open</option><option value="overdue">Overdue</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option><option value="all">All</option></select>}
        {can('tasks.manage') && <select value={params.assigned} onChange={set('assigned')} aria-label="Whose"><option value="me">Mine</option><option value="all">Everyone’s</option></select>}
        {view === 'list' && <select value={params.kind} onChange={set('kind')} aria-label="Type"><option value="">All types</option><option value="lead_follow_up">Lead follow-ups</option><option value="customer_follow_up">Customer follow-ups</option><option value="support_follow_up">Support follow-ups</option><option value="general">General</option></select>}
      </div>
      {view === 'calendar' ? <Calendar month={month} setMonth={setMonth} assigned={params.assigned} onOpen={setEditing} /> : (
        <section className="card flush">
          <ErrorBox error={error} onRetry={reload} />
          {loading && !data ? <Loading /> : (
            <Table rows={data?.items} onRow={setEditing} empty="No tasks here" columns={[
              { key: 'title', label: 'Task', render: (t) => <>{t.title}<span className="sub">{label(t.kind)}{t.lead_name ? ` · ${t.lead_name}` : ''}{t.customer_name ? ` · ${t.customer_name}` : ''}{t.ticket_subject ? ` · ${t.ticket_subject}` : ''}</span></> },
              { key: 'status', label: 'Status', render: (t) => <Badge value={t.display_status}>{STATUS[t.display_status]}</Badge> },
              { key: 'priority', label: 'Priority', render: (t) => <Badge value={t.priority} /> },
              { key: 'due_at', label: 'Due', render: (t) => dateTime(t.due_at) },
              { key: 'assignee', label: 'Assigned to', hideSm: true, render: (t) => t.assignee || '—' },
              { key: 'x', label: '', render: (t) => ['pending', 'in_progress'].includes(t.status) && <button type="button" className="b sm" onClick={(e) => { e.stopPropagation(); complete(t); }}><Icon name="check" size={13} /> Done</button> },
            ]} />
          )}
          <Pager data={data} onPage={(page) => setParams({ ...params, page })} />
        </section>
      )}
      {creating && <TaskModal onClose={() => setCreating(false)} onDone={reload} />}
      {editing && <EditTask task={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); setMonth(new Date(month)); }} />}
    </>
  );
}
