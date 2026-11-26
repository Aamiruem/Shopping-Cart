// CRM team: members and roles, login history and session revocation, tasks and follow-ups, the live activity feed
// and the audit log.
//
// Granting access is guarded: only people with staff.manage can change it, nobody can hand out a permission they
// don't hold, and only the Super Admin can give out staff.manage itself. A member is an existing account (they sign
// up on the store first): admins never create or see passwords.
import {
  ALL_PERMISSIONS, assertAssignable, audit, BUILT_IN_ROLES, can, DATE_RE, fail, ID_RE, like, need, OWNER_ONLY, pageOf, paging, PERMISSIONS, text, where,
} from './_crm_core.mjs';

const roleOf = async (db, key) => {
  if (key === 'super_admin') fail('Super Admin is the store owner’s account and can’t be given to anyone else');
  if (Object.hasOwn(BUILT_IN_ROLES, key)) return { key, ...BUILT_IN_ROLES[key], builtIn: true };
  const [r] = await db('SELECT key, name, description, permissions FROM crm_roles WHERE key = $1', [text(key, 40)]);
  if (!r) fail('Unknown role');
  return { ...r, builtIn: false };
};

function assertCanGrant(staff, permissions) {
  const missing = permissions.filter((p) => !can(staff, p));
  if (missing.length) fail(`You can’t grant permissions you don’t have: ${missing.join(', ')}`, 403);
  if (!staff.owner && permissions.some((p) => OWNER_ONLY.includes(p))) fail('Only the Super Admin can give someone the right to manage the team', 403);
}

// ---------- Members ----------
export async function listStaff({ db }) {
  const rows = await db(
    `SELECT u.id, u.name, u.email, u.last_login, u.disabled_at, u.sessions_revoked_at,
            CASE WHEN u.role = 'admin' THEN 'super_admin' ELSE s.role_key END AS role, s.title, COALESCE(s.active, TRUE) AS active,
            s.created_at AS added_at, adder.name AS added_by, r.name AS custom_role_name,
            (SELECT max(last_seen) FROM crm_sessions cs WHERE cs.user_id = u.id) AS last_active,
            (SELECT count(*)::int FROM crm_sessions cs WHERE cs.user_id = u.id AND cs.revoked_at IS NULL AND cs.last_seen > NOW() - INTERVAL '7 days') AS active_sessions,
            (SELECT count(*)::int FROM leads l WHERE l.assigned_to = u.id AND l.status IN ('new', 'contacted', 'qualified', 'proposal', 'negotiation')) AS open_leads,
            (SELECT count(*)::int FROM leads l WHERE l.assigned_to = u.id AND l.status = 'won') AS won_leads,
            (SELECT count(*)::int FROM support_tickets t WHERE t.assigned_to = u.id AND t.status IN ('open', 'in_progress', 'waiting')) AS open_tickets,
            (SELECT count(*)::int FROM crm_tasks t WHERE t.assigned_to = u.id AND t.status IN ('pending', 'in_progress') AND t.deleted_at IS NULL) AS open_tasks,
            (SELECT count(*)::int FROM crm_tasks t WHERE t.assigned_to = u.id AND t.status IN ('pending', 'in_progress') AND t.due_at < NOW() AND t.deleted_at IS NULL) AS overdue_tasks
       FROM users u LEFT JOIN crm_staff s ON s.user_id = u.id LEFT JOIN users adder ON adder.id = s.added_by LEFT JOIN crm_roles r ON r.key = s.role_key
      WHERE u.role = 'admin' OR s.user_id IS NOT NULL
      ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.name`,
  );
  return { body: rows.map((r) => ({ ...r, roleName: BUILT_IN_ROLES[r.role]?.name ?? r.custom_role_name ?? r.role, owner: r.role === 'super_admin' })) };
}

export async function addStaff({ db, staff, body }) {
  need(staff, 'staff.manage');
  const email = text(body.email, 254).toLowerCase();
  const [u] = email ? await db('SELECT id, name, role, disabled_at FROM users WHERE lower(email) = $1', [email]) : [];
  if (!u) fail('No account uses this email. Ask them to sign up on the store first, then add them here.', 404);
  if (u.role === 'admin') fail('This is the store admin’s account: it already has full access');
  if (u.disabled_at) fail('This account is deactivated');
  const role = await roleOf(db, body.role);
  assertCanGrant(staff, role.permissions);
  await db(
    `INSERT INTO crm_staff (user_id, role_key, title, active, added_by) VALUES ($1, $2, $3, TRUE, $4)
     ON CONFLICT (user_id) DO UPDATE SET role_key = EXCLUDED.role_key, title = EXCLUDED.title, active = TRUE, updated_at = NOW()`,
    [u.id, role.key, text(body.title, 80) || null, staff.id],
  );
  await audit(db, staff, 'staff.add', 'staff', u.id, { name: u.name, role: role.key });
  return { status: 201, body: (await listStaff({ db })).body.find((s) => s.id === u.id) };
}

async function memberRow(db, id) {
  if (!ID_RE.test(String(id))) fail('Team member not found', 404);
  const [m] = await db('SELECT s.*, u.name, u.role AS account_role FROM crm_staff s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1', [Number(id)]);
  if (!m) fail('Team member not found (the store admin can’t be changed here)', 404);
  return m;
}

export async function updateStaff({ db, staff, id, body }) {
  need(staff, 'staff.manage');
  const m = await memberRow(db, id);
  if (m.user_id === staff.id) fail('You can’t change your own access');
  const changes = {};
  // Changing someone who can manage the team takes the Super Admin
  const current = await roleOf(db, m.role_key).catch(() => ({ permissions: [] }));
  assertCanGrant(staff, current.permissions);
  if (body.role !== undefined && body.role !== m.role_key) {
    const role = await roleOf(db, body.role);
    assertCanGrant(staff, role.permissions);
    changes.role = `${m.role_key} → ${role.key}`;
    await db('UPDATE crm_staff SET role_key = $2, updated_at = NOW() WHERE user_id = $1', [m.user_id, role.key]);
  }
  if (body.title !== undefined) {
    await db('UPDATE crm_staff SET title = $2, updated_at = NOW() WHERE user_id = $1', [m.user_id, text(body.title, 80) || null]);
    changes.title = text(body.title, 80);
  }
  if (body.active !== undefined && Boolean(body.active) !== m.active) {
    await db('UPDATE crm_staff SET active = $2, updated_at = NOW() WHERE user_id = $1', [m.user_id, Boolean(body.active)]);
    if (!body.active) await db('UPDATE crm_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [m.user_id]);
    changes.active = Boolean(body.active);
  }
  if (Object.keys(changes).length) await audit(db, staff, 'staff.permissions', 'staff', m.user_id, changes);
  return { body: (await listStaff({ db })).body.find((s) => s.id === m.user_id) };
}

export async function removeStaff({ db, staff, id }) {
  need(staff, 'staff.manage');
  const m = await memberRow(db, id);
  if (m.user_id === staff.id) fail('You can’t remove your own access');
  assertCanGrant(staff, (await roleOf(db, m.role_key).catch(() => ({ permissions: [] }))).permissions);
  await db('DELETE FROM crm_staff WHERE user_id = $1', [m.user_id]);
  await db('UPDATE crm_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [m.user_id]);
  await audit(db, staff, 'staff.remove', 'staff', m.user_id, { name: m.name, role: m.role_key });
  return { status: 204, body: null };
}

/** Ends every session of a person (their next request anywhere on the store asks them to log in again) */
export async function revokeSessions({ db, staff, id }) {
  if (!ID_RE.test(String(id))) fail('Not found', 404);
  const target = Number(id);
  if (target !== staff.id) need(staff, 'staff.manage');
  const [u] = await db('SELECT id, name, role FROM users WHERE id = $1', [target]);
  if (!u) fail('Not found', 404);
  if (u.role === 'admin' && target !== staff.id) fail('Only the store admin can end their own sessions', 403);
  await db('UPDATE users SET sessions_revoked_at = NOW() WHERE id = $1', [target]);
  await db('UPDATE crm_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [target]);
  await audit(db, staff, 'sessions.revoke_all', 'staff', target, { name: u.name });
  return { body: { revoked: true } };
}

export async function revokeSession({ db, staff, id }) {
  const [s] = ID_RE.test(String(id)) ? await db('SELECT id, user_id FROM crm_sessions WHERE id = $1', [Number(id)]) : [];
  if (!s) fail('Session not found', 404);
  if (s.user_id !== staff.id) need(staff, 'staff.manage');
  await db('UPDATE crm_sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL', [s.id]);
  await audit(db, staff, 'session.revoke', 'session', s.id, { userId: s.user_id });
  return { status: 204, body: null };
}

export async function sessions({ db, staff, id }) {
  if (!ID_RE.test(String(id))) fail('Not found', 404);
  if (Number(id) !== staff.id) need(staff, 'staff.manage');
  const rows = await db(
    `SELECT id, ip, user_agent, issued_at, first_seen, last_seen, revoked_at, id = $2 AS current FROM crm_sessions WHERE user_id = $1 ORDER BY last_seen DESC LIMIT 50`,
    [Number(id), staff.sessionId],
  );
  const activity = await db(`SELECT action, entity, entity_id, created_at FROM crm_audit_log WHERE actor_id = $1 ORDER BY created_at DESC LIMIT 50`, [Number(id)]);
  return { body: { sessions: rows, activity } };
}

// ---------- Roles ----------
export async function listRoles({ db }) {
  const custom = await db('SELECT r.*, (SELECT count(*)::int FROM crm_staff s WHERE s.role_key = r.key) AS members FROM crm_roles r ORDER BY r.name');
  const counts = await db('SELECT role_key, count(*)::int AS n FROM crm_staff GROUP BY 1');
  const [admins] = await db("SELECT count(*)::int AS n FROM users WHERE role = 'admin'");
  return {
    body: {
      permissions: Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label, ownerOnly: OWNER_ONLY.includes(key) })),
      roles: [
        ...Object.entries(BUILT_IN_ROLES).map(([key, r]) => ({ key, ...r, builtIn: true, members: key === 'super_admin' ? admins.n : counts.find((c) => c.role_key === key)?.n ?? 0 })),
        ...custom.map((r) => ({ ...r, builtIn: false })),
      ],
    },
  };
}

function cleanRole(staff, body) {
  const name = text(body.name, 60);
  if (name.length < 3) fail('Please name the role');
  if (!Array.isArray(body.permissions) || !body.permissions.length) fail('Choose at least one permission');
  const permissions = [...new Set(body.permissions.filter((p) => ALL_PERMISSIONS.includes(p)))];
  if (permissions.length !== new Set(body.permissions).size) fail('Unknown permission in the list');
  assertCanGrant(staff, permissions);
  return { name, description: text(body.description, 300) || null, permissions };
}

export async function createRole({ db, staff, body }) {
  need(staff, 'staff.manage');
  const r = cleanRole(staff, body);
  const key = `custom_${r.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30)}`;
  if (Object.hasOwn(BUILT_IN_ROLES, key)) fail('That name is taken by a built-in role');
  const [row] = await db(
    `INSERT INTO crm_roles (key, name, description, permissions, created_by) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (key) DO NOTHING RETURNING key`,
    [key, r.name, r.description, JSON.stringify(r.permissions), staff.id],
  );
  if (!row) fail('A role with this name already exists', 409);
  await audit(db, staff, 'role.create', 'role', key, r);
  return { status: 201, body: { key, ...r, builtIn: false, members: 0 } };
}

export async function updateRole({ db, staff, id, body }) {
  need(staff, 'staff.manage');
  if (Object.hasOwn(BUILT_IN_ROLES, id)) fail('Built-in roles can’t be changed. Create a custom role instead.');
  const [existing] = await db('SELECT * FROM crm_roles WHERE key = $1', [text(id, 40)]);
  if (!existing) fail('Role not found', 404);
  assertCanGrant(staff, existing.permissions);
  const r = cleanRole(staff, { name: existing.name, description: existing.description, permissions: existing.permissions, ...body });
  await db('UPDATE crm_roles SET name = $2, description = $3, permissions = $4::jsonb, updated_at = NOW() WHERE key = $1', [existing.key, r.name, r.description, JSON.stringify(r.permissions)]);
  await audit(db, staff, 'role.update', 'role', existing.key, { before: existing.permissions, after: r.permissions });
  return { body: { key: existing.key, ...r, builtIn: false } };
}

export async function deleteRole({ db, staff, id }) {
  need(staff, 'staff.manage');
  const [existing] = await db('SELECT key FROM crm_roles WHERE key = $1', [text(id, 40)]);
  if (!existing) fail('Role not found', 404);
  const [{ n }] = await db('SELECT count(*)::int AS n FROM crm_staff WHERE role_key = $1', [existing.key]);
  if (n) fail(`${n} team member${n === 1 ? ' has' : 's have'} this role. Give them another role first.`, 409);
  await db('DELETE FROM crm_roles WHERE key = $1', [existing.key]);
  await audit(db, staff, 'role.delete', 'role', existing.key, {});
  return { status: 204, body: null };
}

// ---------- Tasks ----------
const TASK_KINDS = ['general', 'lead_follow_up', 'customer_follow_up', 'support_follow_up'];
const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'];
const PRIORITIES = ['low', 'medium', 'high'];
const TASK_SELECT = `SELECT t.*, (t.status IN ('pending', 'in_progress') AND t.due_at < NOW()) AS overdue,
  CASE WHEN t.status IN ('pending', 'in_progress') AND t.due_at < NOW() THEN 'overdue' ELSE t.status END AS display_status,
  a.name AS assignee, c.name AS creator, l.name AS lead_name, cu.name AS customer_name, st.subject AS ticket_subject
  FROM crm_tasks t LEFT JOIN users a ON a.id = t.assigned_to LEFT JOIN users c ON c.id = t.created_by
  LEFT JOIN leads l ON l.id = t.lead_id LEFT JOIN users cu ON cu.id = t.customer_id LEFT JOIN support_tickets st ON st.id = t.ticket_id`;

export async function listTasks({ db, staff, params }) {
  const w = where();
  w.raw('t.deleted_at IS NULL');
  const all = can(staff, 'tasks.manage');
  if (!all || params.assigned === 'me' || !params.assigned) {
    if (!all || params.assigned !== 'all') w.add('(t.assigned_to = ? OR t.created_by = ?)', staff.id, staff.id);
  } else if (ID_RE.test(params.assigned)) w.add('t.assigned_to = ?', Number(params.assigned));
  if (params.status === 'overdue') w.raw("t.status IN ('pending', 'in_progress') AND t.due_at < NOW()");
  else if (TASK_STATUSES.includes(params.status)) w.add('t.status = ?', params.status);
  else if (params.status !== 'all') w.raw("t.status IN ('pending', 'in_progress')");
  if (DATE_RE.test(params.from ?? '')) w.add('t.due_at >= ?::date', params.from);
  if (DATE_RE.test(params.to ?? '')) w.add('t.due_at < ?::date + 1', params.to);
  for (const k of ['lead', 'customer', 'ticket']) if (ID_RE.test(params[k] ?? '')) w.add(`t.${k}_id = ?`, Number(params[k]));
  if (TASK_KINDS.includes(params.kind)) w.add('t.kind = ?', params.kind);
  const q = text(params.q, 80);
  if (q) w.add('(t.title ILIKE ? OR t.description ILIKE ?)', like(q), like(q));
  const p = paging(params, params.from ? 500 : 100);
  const [{ total }] = await db(`SELECT count(*)::int AS total FROM crm_tasks t ${w.sql()}`, w.args);
  const rows = await db(`${TASK_SELECT} ${w.sql()} ORDER BY t.due_at ASC NULLS LAST, CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.id LIMIT ${p.limit} OFFSET ${p.offset}`, w.args);
  return { body: pageOf(rows, p, total) };
}

async function taskFields(db, staff, body, existing = {}) {
  const out = {};
  if (body.title !== undefined || !existing.id) {
    out.title = text(body.title, 160);
    if (out.title.length < 3) fail('Please give the task a title');
  }
  if (body.description !== undefined) out.description = text(body.description, 4000) || null;
  if (body.kind !== undefined) out.kind = TASK_KINDS.includes(body.kind) ? body.kind : fail('Unknown task type');
  if (body.priority !== undefined) out.priority = PRIORITIES.includes(body.priority) ? body.priority : fail('Unknown priority');
  if (body.dueAt !== undefined) {
    if (body.dueAt === null || body.dueAt === '') out.due_at = null;
    else if (Number.isNaN(Date.parse(body.dueAt))) fail('Please pick a valid due date');
    else out.due_at = new Date(body.dueAt).toISOString();
  }
  if (body.assignedTo !== undefined) {
    const to = body.assignedTo ? Number(body.assignedTo) : null;
    if (to !== staff.id && !can(staff, 'tasks.manage')) fail('Only managers can give tasks to other people', 403);
    out.assigned_to = to ? (await assertAssignable(db, to, 'dashboard.view')).id : null;
  }
  for (const [k, table] of [['leadId', 'leads'], ['customerId', 'users'], ['ticketId', 'support_tickets']]) {
    if (body[k] === undefined) continue;
    if (!body[k]) {
      out[`${k.replace('Id', '')}_id`] = null;
      continue;
    }
    const [r] = ID_RE.test(String(body[k])) ? await db(`SELECT id FROM ${table} WHERE id = $1`, [Number(body[k])]) : [];
    if (!r) fail(`The linked ${k.replace('Id', '')} wasn’t found`, 404);
    out[`${k.replace('Id', '')}_id`] = r.id;
  }
  if (body.status !== undefined) {
    if (!TASK_STATUSES.includes(body.status)) fail('Unknown status (overdue is shown automatically when a task is past its due time)');
    out.status = body.status;
    out.completed_at = body.status === 'completed' ? new Date().toISOString() : null;
  }
  return out;
}

export async function createTask({ db, staff, body }) {
  const f = await taskFields(db, staff, { assignedTo: staff.id, ...body });
  f.created_by = staff.id;
  const cols = Object.keys(f);
  const [row] = await db(`INSERT INTO crm_tasks (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, Object.values(f));
  await audit(db, staff, 'task.create', 'task', row.id, { title: f.title, assignedTo: f.assigned_to });
  const [task] = await db(`${TASK_SELECT} WHERE t.id = $1`, [row.id]);
  return { status: 201, body: task };
}

async function ownTask(db, staff, id) {
  const [t] = ID_RE.test(String(id)) ? await db('SELECT * FROM crm_tasks WHERE id = $1 AND deleted_at IS NULL', [Number(id)]) : [];
  if (!t) fail('Task not found', 404);
  if (![t.assigned_to, t.created_by].includes(staff.id) && !can(staff, 'tasks.manage')) fail('Task not found', 404);
  return t;
}

export async function updateTask({ db, staff, id, body }) {
  const t = await ownTask(db, staff, id);
  const f = await taskFields(db, staff, body, t);
  if (!Object.keys(f).length) return { body: (await db(`${TASK_SELECT} WHERE t.id = $1`, [t.id]))[0] };
  const cols = Object.keys(f);
  await db(`UPDATE crm_tasks SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1`, [t.id, ...Object.values(f)]);
  await audit(db, staff, f.status ? `task.${f.status}` : f.assigned_to !== undefined ? 'task.assign' : 'task.update', 'task', t.id, f);
  return { body: (await db(`${TASK_SELECT} WHERE t.id = $1`, [t.id]))[0] };
}

export async function deleteTask({ db, staff, id }) {
  const t = await ownTask(db, staff, id);
  await db('UPDATE crm_tasks SET deleted_at = NOW() WHERE id = $1', [t.id]);
  await audit(db, staff, 'task.delete', 'task', t.id, { title: t.title });
  return { status: 204, body: null };
}

// ---------- Live feed ----------
/**
 * What happened since `since` (default: the last 24 hours), read from the source tables, so an event can't be
 * duplicated or lost by a notifier. Each event has a stable id ("order:123") the browser uses to show it once.
 */
export async function feed({ db, staff, params }) {
  const since = params.since && !Number.isNaN(Date.parse(params.since)) ? new Date(params.since) : new Date(Date.now() - 86_400_000);
  const s = since.toISOString();
  const parts = [];
  const q = (sql) => parts.push(db(sql, [s]));
  if (can(staff, 'customers.view')) q(`SELECT 'customer:' || id AS id, 'customer' AS type, created_at AS at, 'New customer: ' || name AS text, '/crm/customers/' || id AS link FROM users WHERE role <> 'admin' AND created_at > $1`);
  if (can(staff, 'leads.view')) q(`SELECT 'lead:' || id AS id, 'lead' AS type, created_at AS at, 'New lead (' || replace(source, '_', ' ') || '): ' || COALESCE(name, email, phone, '') AS text, '/crm/leads?open=' || id AS link FROM leads WHERE source <> 'newsletter' AND created_at > $1`);
  if (can(staff, 'sales.view')) {
    q(`SELECT 'order:' || o.id AS id, 'order' AS type, o.created_at AS at, 'New order #' || o.id || ' · ₹' || round(o.total) || ' · ' || u.name AS text, '/crm/sales?order=' || o.id AS link FROM orders o JOIN users u ON u.id = o.user_id WHERE o.created_at > $1`);
    q(`SELECT 'payment:' || id || ':' || status AS id, 'payment' AS type, updated_at AS at, 'Payment ' || status || ' · ₹' || round(amount) || COALESCE(' · order #' || order_id, '') AS text, '/crm/sales' || COALESCE('?order=' || order_id, '') AS link FROM payments WHERE updated_at > $1 AND status IN ('paid', 'failed', 'refunded', 'refund_pending')`);
    q(`SELECT 'return:' || order_id || ':' || status AS id, 'refund' AS type, updated_at AS at, 'Return ' || status || ' on order #' || order_id AS text, '/crm/sales?tab=refunds' AS link FROM order_returns WHERE updated_at > $1`);
  }
  if (can(staff, 'support.view')) {
    q(`SELECT 'ticket:' || id AS id, 'ticket' AS type, created_at AS at, 'New ticket #' || id || ': ' || subject AS text, '/crm/support?ticket=' || id AS link FROM support_tickets WHERE created_at > $1`);
    q(`SELECT 'reply:' || m.id AS id, 'ticket' AS type, m.created_at AS at, 'Customer replied on ticket #' || m.ticket_id AS text, '/crm/support?ticket=' || m.ticket_id AS link FROM ticket_messages m WHERE NOT m.staff AND m.created_at > $1`);
  }
  parts.push(db(`SELECT 'task:' || id || ':assigned' AS id, 'task' AS type, created_at AS at, 'Task for you: ' || title AS text, '/crm/tasks' AS link FROM crm_tasks WHERE assigned_to = $2 AND created_by IS DISTINCT FROM $2 AND created_at > $1 AND deleted_at IS NULL`, [s, staff.id]));
  parts.push(db(`SELECT 'task:' || id || ':due' AS id, 'reminder' AS type, due_at - INTERVAL '1 hour' AS at, 'Due within the hour: ' || title AS text, '/crm/tasks' AS link FROM crm_tasks
                  WHERE assigned_to = $2 AND status IN ('pending', 'in_progress') AND deleted_at IS NULL AND due_at BETWEEN NOW() AND NOW() + INTERVAL '1 hour' AND due_at - INTERVAL '1 hour' > $1`, [s, staff.id]));
  const events = (await Promise.all(parts)).flat().sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 60);
  const [seen] = await db('SELECT updated_at FROM crm_settings WHERE key = $1', [`seen:${staff.id}`]);
  const seenAt = seen ? new Date(seen.updated_at) : new Date(0);
  return { body: { now: new Date().toISOString(), events: events.map((e) => ({ ...e, unread: new Date(e.at) > seenAt })), unread: events.filter((e) => new Date(e.at) > seenAt).length } };
}

export async function markFeedSeen({ db, staff }) {
  await db(`INSERT INTO crm_settings (key, value, updated_at) VALUES ($1, '{}'::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET updated_at = NOW()`, [`seen:${staff.id}`]);
  return { status: 204, body: null };
}

// ---------- Audit log ----------
export async function auditLog({ db, params }) {
  const w = where();
  if (ID_RE.test(params.actor ?? '')) w.add('a.actor_id = ?', Number(params.actor));
  if (text(params.action, 60)) w.add('a.action LIKE ?', `${text(params.action, 60).replace(/[\\%_]/g, '\\$&')}%`);
  if (text(params.entity, 30)) w.add('a.entity = ?', text(params.entity, 30));
  if (text(params.entityId, 64)) w.add('a.entity_id = ?', text(params.entityId, 64));
  if (DATE_RE.test(params.from ?? '')) w.add('a.created_at >= ?::date', params.from);
  if (DATE_RE.test(params.to ?? '')) w.add('a.created_at < ?::date + 1', params.to);
  const p = paging(params);
  const [{ total }] = await db(`SELECT count(*)::int AS total FROM crm_audit_log a ${w.sql()}`, w.args);
  const rows = await db(`SELECT a.* FROM crm_audit_log a ${w.sql()} ORDER BY a.created_at DESC, a.id DESC LIMIT ${p.limit} OFFSET ${p.offset}`, w.args);
  const actions = await db('SELECT DISTINCT action FROM crm_audit_log ORDER BY action LIMIT 200');
  return { body: { ...pageOf(rows, p, total), actions: actions.map((a) => a.action) } };
}
