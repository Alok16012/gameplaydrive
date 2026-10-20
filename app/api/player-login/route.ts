import { loginEmail } from "../../lib/loginEmail";
import { selectOne } from "../../lib/server/supabaseAdmin";

// Players sign in with their mobile number, or with the username an admin gave them. A player who has a mobile
// number has a login keyed by it, so a username login is looked up and signed in here: the browser gets the
// session back, never the mobile number behind the username.
export async function POST(req: Request) {
  const b = await req.json().catch(() => null);
  const username = String(b?.username ?? "").trim().toLowerCase();
  const password = String(b?.password ?? "");
  const wrong = Response.json({ error: "Wrong username or password" }, { status: 400 });
  if (!/^[a-z0-9._]{3,}$/.test(username) || !password) return wrong;

  const p = await selectOne<{ role: string; phone: string | null; username: string | null }>(
    "profiles",
    `role=eq.player&username=eq.${encodeURIComponent(username)}&select=role,phone,username`,
  ).catch(() => null);
  const email = p ? loginEmail(p) : null;
  if (!email) return wrong;

  const r = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.access_token) return r.status === 429 ? Response.json({ error: "Too many tries — wait a minute and try again" }, { status: 429 }) : wrong;
  return Response.json({ access_token: j.access_token, refresh_token: j.refresh_token });
}
