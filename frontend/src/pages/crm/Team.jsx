import { useState } from 'react';
import { crm } from '../../api/client';
import Icon from '../../components/common/Icon';
import { ago, Badge, dateTime, Drawer, ErrorBox, Field, label, Loading, Modal, PageHead, Table, useAction, useCrm, useCrmData } from '../../components/crm/ui';

function RoleForm({ initial, permissions, onClose, onDone }) {
  const { can, me } = useCrm();
  const { run, busy } = useAction();
  const [f, setF] = useState({ name: initial?.name || '', description: initial?.description || '', permissions: initial?.permissions || ['dashboard.view'] });
  const toggle = (p) => setF({ ...f, permissions: f.permissions.includes(p) ? f.permissions.filter((x) => x !== p) : [...f.permissions, p] });
  const save = async (e) => {
    e.preventDefault();
    if (await run(() => (initial ? crm.patch(`/roles/${initial.key}`, f) : crm.post('/roles', f)), 'Role saved')) onDone();
  };
  return (
    <Modal title={initial ? `Edit role: ${initial.name}` : 'New role'} onClose={onClose} size="lg">
      <form className="stack" onSubmit={save}>
        <div className="grid2">
          <Field label="Name"><input required minLength={3} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Description"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        </div>
        <div className="perm-grid">
          {permissions.map((p) => (
            <label key={p.key} className="check" title={p.key}>
              <input type="checkbox" checked={f.permissions.includes(p.key)} onChange={() => toggle(p.key)} disabled={!can(p.key) || (p.ownerOnly && !me.owner)} />
              <span>{p.label}{p.ownerOnly && <span className="muted small"> (owner only)</span>}</span>
            </label>
          ))}
        </div>
        <p className="muted small">You can only grant permissions you have yourself.</p>
        <div className="crm-modal-foot"><button type="button" className="b" onClick={onClose}>Cancel</button><button type="submit" className="b primary" disabled={busy}>Save role</button></div>
      </form>
    </Modal>
  );
}

function MemberDrawer({ member, roles, onClose, onChange }) {
  const { confirm, me } = useCrm();
  const { data, error, reload } = useCrmData(`/staff/${member.id}/sessions`);
  const { run, busy } = useAction();
  const update = async (body, msg) => (await run(() => crm.patch(`/staff/${member.id}`, body), msg)) && onChange();
  const remove = async () => {
    if ((await confirm({ title: `Remove ${member.name} from the team?`, message: 'Their CRM access ends at once. Their account on the store stays.', danger: true, confirmLabel: 'Remove access' })) && (await run(() => crm.del(`/staff/${member.id}`), 'Access removed'))) {
      onChange();
      onClose();
    }
  };
  const endAll = async () => {
    if ((await confirm({ title: 'End all sessions?', message: 'They are signed out on every device and must log in again.', danger: true, confirmLabel: 'End sessions' })) && (await run(() => crm.post(`/staff/${member.id}/revoke-sessions`), 'All sessions ended'))) reload();
  };
  const endOne = async (s) => (await run(() => crm.post(`/sessions/${s.id}/revoke`), 'Session ended')) && reload();
  return (
    <Drawer title={member.name} onClose={onClose}>
      <div className="stack">
        <div className="row"><Badge tone="info">{member.roleName}</Badge>{!member.active && <Badge value="inactive" />}<span className="muted small">{member.email}</span></div>
        {!member.owner && member.id !== me.id && (
          <section className="card grid3">
            <Field label="Role"><select value={member.role} disabled={busy} onChange={(e) => update({ role: e.target.value }, 'Role changed')}>{roles.filter((r) => r.key !== 'super_admin').map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</select></Field>
            <Field label="Job title"><input defaultValue={member.title || ''} onBlur={(e) => e.target.value !== (member.title || '') && update({ title: e.target.value }, 'Title saved')} /></Field>
            <Field label="Access"><select value={member.active ? '1' : '0'} disabled={busy} onChange={(e) => update({ active: e.target.value === '1' }, e.target.value === '1' ? 'Access restored' : 'Access paused')}><option value="1">Active</option><option value="0">Paused</option></select></Field>
          </section>
        )}
        <section className="card">
          <h3>Performance now</h3>
          <dl className="dl"><dt>Open leads</dt><dd>{member.open_leads} ({member.won_leads} converted overall)</dd><dt>Open tickets</dt><dd>{member.open_tickets}</dd><dt>Open tasks</dt><dd>{member.open_tasks} ({member.overdue_tasks} overdue)</dd></dl>
          <p className="muted small">Full figures for any period: Reports → Team performance.</p>
        </section>
        <ErrorBox error={error} onRetry={reload} />
        <section className="card flush">
          <div className="card-head" style={{ padding: '14px 16px 0' }}><h2>Login history</h2><button type="button" className="b sm danger" onClick={endAll}>End all sessions</button></div>
          {!data ? <Loading /> : <Table rows={data.sessions} empty="Never used the CRM" columns={[
            { key: 'first_seen', label: 'Signed in', render: (s) => <>{dateTime(s.first_seen)}{s.current && <span className="sub">This session</span>}</> },
            { key: 'last_seen', label: 'Last active', render: (s) => ago(s.last_seen) },
            { key: 'ip', label: 'IP / device', hideSm: true, render: (s) => <>{s.ip}<span className="sub">{(s.user_agent || '').slice(0, 60)}</span></> },
            { key: 'x', label: '', render: (s) => (s.revoked_at ? <Badge tone="bad">Ended</Badge> : <button type="button" className="b sm" onClick={() => endOne(s)}>End</button>) },
          ]} />}
        </section>
        {data && <section className="card"><h3>Recent activity</h3><ul className="timeline">{data.activity.map((a, i) => <li key={i}><div>{label(a.action.replace('.', ' '))} {a.entity ? `· ${a.entity} ${a.entity_id ?? ''}` : ''}<time>{dateTime(a.created_at)}</time></div></li>)}</ul></section>}
        {!member.owner && member.id !== me.id && <div><button type="button" className="b danger" onClick={remove}>Remove from team</button></div>}
      </div>
    </Drawer>
  );
}

export default function Team() {
  const staff = useCrmData('/staff');
  const roles = useCrmData('/roles');
  const { confirm } = useCrm();
  const { run, busy } = useAction();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: '', role: 'sales_executive', title: '' });
  const [roleForm, setRoleForm] = useState(null);
  const [open, setOpen] = useState(null);
  const add = async (e) => {
    e.preventDefault();
    if (await run(() => crm.post('/staff', form), 'Team member added')) {
      setAdding(false);
      staff.reload();
    }
  };
  const delRole = async (r) => (await confirm({ title: `Delete role ${r.name}?`, message: 'Only possible when nobody has it.', danger: true, confirmLabel: 'Delete' })) && (await run(() => crm.del(`/roles/${r.key}`), 'Role deleted')) && roles.reload();
  const member = open && staff.data?.find((s) => s.id === open);
  return (
    <>
      <PageHead title="Team & roles" subtitle="Who can use the CRM and what each role may do. Every change is in the audit log.">
        <button type="button" className="b primary" onClick={() => setAdding(true)}><Icon name="plus" size={15} /> Add team member</button>
      </PageHead>
      <ErrorBox error={staff.error} onRetry={staff.reload} />
      <section className="card flush" style={{ marginBottom: 14 }}>
        {!staff.data ? <Loading /> : <Table rows={staff.data} onRow={(m) => setOpen(m.id)} columns={[
          { key: 'name', label: 'Member', render: (m) => <>{m.name}<span className="sub">{m.email}{m.title ? ` · ${m.title}` : ''}</span></> },
          { key: 'role', label: 'Role', render: (m) => <><Badge tone={m.owner ? 'good' : 'info'}>{m.roleName}</Badge>{!m.active && <> <Badge value="inactive" /></>}</> },
          { key: 'work', label: 'Open work', hideSm: true, render: (m) => `${m.open_leads} leads · ${m.open_tickets} tickets · ${m.open_tasks} tasks${m.overdue_tasks ? ` (${m.overdue_tasks} overdue)` : ''}` },
          { key: 'last_active', label: 'Last active', render: (m) => ago(m.last_active) },
        ]} />}
      </section>
      <section className="card flush">
        <div className="card-head" style={{ padding: '14px 16px 0' }}><h2>Roles</h2><button type="button" className="b sm" onClick={() => setRoleForm({})}>New custom role</button></div>
        {!roles.data ? <Loading /> : <Table rows={roles.data.roles.map((r) => ({ ...r, id: r.key }))} columns={[
          { key: 'name', label: 'Role', render: (r) => <>{r.name}<span className="sub">{r.description}</span></> },
          { key: 'members', label: 'Members', num: true },
          { key: 'permissions', label: 'Can', render: (r) => <span className="small">{r.permissions.length === roles.data.permissions.length ? 'Everything' : r.permissions.map((p) => p.split('.')[0]).filter((v, i, a) => a.indexOf(v) === i).map(label).join(', ')}</span> },
          { key: 'x', label: '', render: (r) => (r.builtIn ? <span className="muted small">Built in</span> : <span className="row"><button type="button" className="b sm" onClick={() => setRoleForm(r)}>Edit</button><button type="button" className="b sm danger" onClick={() => delRole(r)}>Delete</button></span>) },
        ]} />}
      </section>
      {adding && roles.data && (
        <Modal title="Add a team member" onClose={() => setAdding(false)}>
          <form className="stack" onSubmit={add}>
            <p className="muted" style={{ marginTop: 0 }}>They need an account on the store first (they sign up themselves, so only they know their password). Then enter that email here.</p>
            <Field label="Their account email"><input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            <Field label="Role"><select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{roles.data.roles.filter((r) => r.key !== 'super_admin').map((r) => <option key={r.key} value={r.key}>{r.name}: {r.description}</option>)}</select></Field>
            <Field label="Job title (optional)"><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
            <div className="crm-modal-foot"><button type="button" className="b" onClick={() => setAdding(false)}>Cancel</button><button type="submit" className="b primary" disabled={busy}>Add</button></div>
          </form>
        </Modal>
      )}
      {roleForm && roles.data && <RoleForm initial={roleForm.key ? roleForm : null} permissions={roles.data.permissions} onClose={() => setRoleForm(null)} onDone={() => { setRoleForm(null); roles.reload(); }} />}
      {member && roles.data && <MemberDrawer member={member} roles={roles.data.roles} onClose={() => setOpen(null)} onChange={staff.reload} />}
    </>
  );
}
