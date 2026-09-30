// One-time setup: create the Super Admin login after running supabase/migrations/001_init.sql.
// Usage: node --env-file=.env.local scripts/create-superadmin.mjs <username> <password> "<Full name>"
const [username, password, name = "Super Admin"] = process.argv.slice(2);
if (!username || !password || password.length < 8) {
  console.error('Usage: node --env-file=.env.local scripts/create-superadmin.mjs <username> <password (8+ chars)> "<Full name>"');
  process.exit(1);
}
const U = process.env.NEXT_PUBLIC_SUPABASE_URL, K = process.env.SUPABASE_SERVICE_ROLE_KEY;
const h = { apikey: K, Authorization: `Bearer ${K}`, "Content-Type": "application/json" };
const j = async (r) => { const t = await r.text(); const b = t ? JSON.parse(t) : null; if (!r.ok) throw new Error(b?.message ?? b?.msg ?? t); return b; };

const existing = await j(await fetch(`${U}/rest/v1/profiles?role=eq.superadmin&select=code`, { headers: h }));
if (existing.length) { console.error("A Super Admin already exists:", existing[0].code); process.exit(1); }
const user = await j(await fetch(`${U}/auth/v1/admin/users`, { method: "POST", headers: h, body: JSON.stringify({ email: `u.${username.toLowerCase()}@gamehub.invalid`, password, email_confirm: true }) }));
try {
  await j(await fetch(`${U}/rest/v1/profiles`, { method: "POST", headers: h, body: JSON.stringify({ id: user.id, code: "SA-0001", role: "superadmin", name, username: username.toLowerCase() }) }));
  await j(await fetch(`${U}/rest/v1/wallets`, { method: "POST", headers: h, body: JSON.stringify({ user_id: user.id }) }));
  console.log(`Super Admin "${username}" created. Sign in at /admin.`);
} catch (e) {
  await fetch(`${U}/auth/v1/admin/users/${user.id}`, { method: "DELETE", headers: h });
  throw e;
}
