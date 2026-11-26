import { useState } from 'react';
import { crm } from '../../api/client';
import { AssignSelect, ago, Badge, dateTime, Field, Modal, useAction, useCrm } from './ui';

const KINDS = [['note', 'Note'], ['call', 'Call'], ['meeting', 'Meeting'], ['email', 'Email'], ['sms', 'SMS'], ['whatsapp', 'WhatsApp']];

/** Notes and logged interactions on a customer, lead, order or ticket */
export function NotesPanel({ entity, entityId, notes = [], onChange }) {
  const { can, me, confirm } = useCrm();
  const { run, busy } = useAction();
  const [f, setF] = useState({ kind: 'note', body: '', outcome: '', happenedAt: '' });
  const add = async (e) => {
    e.preventDefault();
    const out = await run(() => crm.post('/notes', { entity, entityId, ...f, happenedAt: f.happenedAt || undefined }), f.kind === 'note' ? 'Note added' : 'Activity logged');
    if (out) {
      setF({ kind: 'note', body: '', outcome: '', happenedAt: '' });
      onChange?.();
    }
  };
  const remove = async (id) => {
    if (await confirm({ title: 'Remove note?', message: 'It disappears from the record (kept in the audit log).', danger: true, confirmLabel: 'Remove' })) {
      if (await run(() => crm.del(`/notes/${id}`), 'Note removed')) onChange?.();
    }
  };
  return (
    <div className="stack">
      {can('notes.write') && (
        <form className="card stack" onSubmit={add}>
          <div className="row">
            {KINDS.map(([k, l]) => <button key={k} type="button" className={`b sm ${f.kind === k ? 'primary' : ''}`} onClick={() => setF({ ...f, kind: k })}>{l}</button>)}
          </div>
          <textarea rows={3} required minLength={2} placeholder={f.kind === 'note' ? 'Internal note (customers never see this)' : `What was discussed on the ${f.kind}?`} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
          {f.kind !== 'note' && (
            <div className="grid2">
              <Field label="Outcome"><input value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} placeholder="Interested, call back Friday" /></Field>
              <Field label="When" hint="Leave empty for now"><input type="datetime-local" value={f.happenedAt} max={new Date().toISOString().slice(0, 16)} onChange={(e) => setF({ ...f, happenedAt: e.target.value })} /></Field>
            </div>
          )}
          <div><button type="submit" className="b primary" disabled={busy}>{f.kind === 'note' ? 'Add note' : 'Log activity'}</button></div>
        </form>
      )}
      {notes.length ? (
        <ul className="timeline">
          {notes.map((n) => (
            <li key={n.id}>
              <div>
                <Badge tone="info">{n.kind}</Badge> <strong>{n.author || 'Team'}</strong>{n.outcome && <> · {n.outcome}</>}
                <time>{dateTime(n.happened_at)} ({ago(n.happened_at)})</time>
                <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                {(n.author_id === me?.id || can('customers.edit')) && n.author_id !== undefined && <button type="button" className="b sm ghost danger" onClick={() => remove(n.id)}>Remove</button>}
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="muted">No notes or logged activity yet.</p>}
    </div>
  );
}

/** A follow-up task linked to a lead, customer or ticket */
export function TaskModal({ link = {}, title = '', kind = 'general', onClose, onDone }) {
  const { can, me } = useCrm();
  const { run, busy } = useAction();
  const tomorrow = new Date(Date.now() + 86_400_000);
  tomorrow.setHours(10, 0, 0, 0);
  const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [f, setF] = useState({ title, description: '', priority: 'medium', dueAt: local(tomorrow), assignedTo: me?.id, kind });
  const save = async (e) => {
    e.preventDefault();
    const out = await run(() => crm.post('/tasks', { ...f, dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : null, ...link }), 'Task created');
    if (out) {
      onDone?.(out);
      onClose();
    }
  };
  return (
    <Modal title="New task" onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label="Title"><input required minLength={3} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Details"><textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div className="grid2">
          <Field label="Due"><input type="datetime-local" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></Field>
          <Field label="Priority"><select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></Field>
          <Field label="Type"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="general">General</option><option value="lead_follow_up">Lead follow-up</option><option value="customer_follow_up">Customer follow-up</option><option value="support_follow_up">Support follow-up</option></select></Field>
          <Field label="Assigned to">{can('tasks.manage') ? <AssignSelect value={f.assignedTo} onChange={(v) => setF({ ...f, assignedTo: v })} allowNone={false} /> : <input disabled value="Me" />}</Field>
        </div>
        <div className="crm-modal-foot"><button type="button" className="b" onClick={onClose}>Cancel</button><button type="submit" className="b primary" disabled={busy}>Create task</button></div>
      </form>
    </Modal>
  );
}

/** A one-off message through a configured provider; the result shows what the provider actually said */
export function MessageModal({ to, onClose, onDone }) {
  const { run, busy } = useAction();
  const [f, setF] = useState({ channel: 'email', subject: '', message: '' });
  const [result, setResult] = useState(null);
  const send = async (e) => {
    e.preventDefault();
    const out = await run(() => crm.post('/messages', { ...f, ...to }));
    if (out) {
      setResult(out);
      onDone?.();
    }
  };
  return (
    <Modal title="Send a message" onClose={onClose}>
      {result ? (
        <div className="stack">
          <div className={`alert ${result.status === 'accepted' ? 'info' : ''}`}>
            {result.status === 'accepted' ? 'The provider accepted the message. Delivery is confirmed only when the provider reports it (see the communication log).' : `Not sent: ${result.error || 'the provider refused it'}`}
          </div>
          <div className="crm-modal-foot"><button type="button" className="b primary" onClick={onClose}>Done</button></div>
        </div>
      ) : (
        <form className="stack" onSubmit={send}>
          <Field label="Channel">
            <select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
              <option value="email">Email</option><option value="sms">SMS (verified numbers only)</option><option value="whatsapp">WhatsApp (within 24 h of their last message)</option>
            </select>
          </Field>
          {f.channel === 'email' && <Field label="Subject"><input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>}
          <Field label="Message"><textarea rows={6} required minLength={2} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
          <div className="crm-modal-foot"><button type="button" className="b" onClick={onClose}>Cancel</button><button type="submit" className="b primary" disabled={busy}>{busy ? 'Sending…' : 'Send'}</button></div>
        </form>
      )}
    </Modal>
  );
}

export function MessagesTable({ messages = [] }) {
  if (!messages.length) return <p className="muted">No messages sent or received yet.</p>;
  return (
    <table className="t">
      <thead><tr><th>When</th><th>Channel</th><th>Message</th><th>Status</th></tr></thead>
      <tbody>
        {messages.map((m) => (
          <tr key={m.id}>
            <td>{dateTime(m.created_at)}</td>
            <td>{m.direction === 'in' ? '← ' : '→ '}{m.channel}</td>
            <td>{m.subject || m.event?.replace(/_/g, ' ') || m.kind}{m.error && <span className="sub">{m.error}</span>}</td>
            <td><Badge value={m.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
