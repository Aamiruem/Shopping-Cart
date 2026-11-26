// Test helper: a session from the right portal for a role, as the real sign-in would give it. Admins get an
// admin-portal session (what /admin/login issues); sellers get a seller-portal session and an approved seller
// application (what an admin's approval in CRM → Sellers leaves behind).
import { createToken } from '../../api/_auth.mjs';

export async function portalToken(db, userId, role) {
  await db('UPDATE users SET role = $1 WHERE id = $2', [role, userId]);
  if (role === 'seller') {
    await db("INSERT INTO sellers (user_id, store_name, status) VALUES ($1, $2, 'approved') ON CONFLICT (user_id) DO UPDATE SET status = 'approved'", [userId, `Test Store ${userId}`]);
  }
  const [user] = await db('SELECT id, email, role FROM users WHERE id = $1', [userId]);
  const portal = role === 'admin' ? 'admin' : role === 'seller' ? 'seller' : 'customer';
  return `Bearer ${createToken(user, portal, portal === 'admin' ? { mfa: false } : {})}`;
}
