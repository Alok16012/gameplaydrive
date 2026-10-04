// Supabase access with the service-role key (server only). Plain REST so it runs anywhere.

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!URL || !KEY) console.warn("[supa] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");

const headers = (token = KEY) => ({ apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(URL + path, init);
  const text = await r.text();
  const body = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(body?.message ?? body?.msg ?? `Supabase ${r.status}`);
  return body as T;
}

export interface Profile { id: string; code: string; role: string; name: string; status: string; parent_id: string | null }

/** Who is behind a browser access token (null if invalid/expired). */
export async function userFromToken(token: string): Promise<{ id: string } | null> {
  try { return await call<{ id: string }>("/auth/v1/user", { headers: { apikey: KEY, Authorization: `Bearer ${token}` } }); } catch { return null; }
}

export async function getProfile(id: string): Promise<Profile | null> {
  const rows = await call<Profile[]>(`/rest/v1/profiles?id=eq.${id}&select=id,code,role,name,status,parent_id`, { headers: headers() });
  return rows[0] ?? null;
}

export async function getCoins(id: string): Promise<number> {
  const rows = await call<{ coins: number }[]>(`/rest/v1/wallets?user_id=eq.${id}&select=coins`, { headers: headers() });
  return Number(rows[0]?.coins ?? 0);
}

/** Move coins and write the ledger in one database call. Returns the new balance, or null if not enough coins. */
export async function walletMove(uid: string, amount: number, kind: string, note: string): Promise<number | null> {
  const r = await call<number | null>("/rest/v1/rpc/wallet_move", { method: "POST", headers: headers(), body: JSON.stringify({ p_uid: uid, p_amount: Math.round(amount), p_kind: kind, p_note: note }) });
  return r === null ? null : Number(r);
}

/** Coins the player may still bet today under their daily limit (null = no limit, or the database lacks migration 018). */
export async function betRoom(uid: string): Promise<number | null> {
  try {
    const r = await call<number | null>("/rest/v1/rpc/bet_room", { method: "POST", headers: headers(), body: JSON.stringify({ p_uid: uid }) });
    return r === null ? null : Number(r);
  } catch { return null; }
}

export async function getSetting<T>(key: string): Promise<T | null> {
  const rows = await call<{ value: T }[]>(`/rest/v1/app_settings?key=eq.${key}&select=value`, { headers: headers() });
  return rows[0]?.value ?? null;
}

export async function getActiveBots(): Promise<{ name: string; emoji: string; bal: number }[]> {
  return call(`/rest/v1/bots?active=eq.true&select=name,emoji,bal`, { headers: headers() });
}
