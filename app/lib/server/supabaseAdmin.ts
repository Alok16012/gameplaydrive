// Server-only Supabase access with the service-role key. Import this from route handlers only — the key must
// never reach the browser. Uses the REST APIs directly so it runs on any Node version.

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const headers = (token = KEY) => ({ apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const r = await fetch(URL + path, { ...init, cache: "no-store" });
  const text = await r.text();
  const body = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(body?.message ?? body?.msg ?? body?.error_description ?? `Supabase error ${r.status}`);
  return body as T;
}

/** The user behind a browser access token, or null. */
export async function userFromToken(token: string): Promise<{ id: string } | null> {
  try {
    return await call<{ id: string }>("/auth/v1/user", { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
  } catch {
    return null;
  }
}

export const createAuthUser = (email: string, password: string) =>
  call<{ id: string }>("/auth/v1/admin/users", { method: "POST", headers: headers(), body: JSON.stringify({ email, password, email_confirm: true }) });

export const deleteAuthUser = (id: string) => call<unknown>(`/auth/v1/admin/users/${id}`, { method: "DELETE", headers: headers() });

export const updateAuthPassword = (id: string, password: string) =>
  call<unknown>(`/auth/v1/admin/users/${id}`, { method: "PUT", headers: headers(), body: JSON.stringify({ password }) });

/** Change a login's email (the internal sign-in name) and/or password. */
export const updateAuthUser = (id: string, patch: { email?: string; password?: string }) =>
  call<unknown>(`/auth/v1/admin/users/${id}`, { method: "PUT", headers: headers(), body: JSON.stringify({ ...patch, ...(patch.email ? { email_confirm: true } : {}) }) });

/** Write straight to a table row (service role — bypasses row-level security). */
export const patchRow = (table: string, query: string, body: Record<string, unknown>) =>
  call<unknown>(`/rest/v1/${table}?${query}`, { method: "PATCH", headers: headers(), body: JSON.stringify(body) });

export const rpc = <T>(fn: string, args: Record<string, unknown>) =>
  call<T>(`/rest/v1/rpc/${fn}`, { method: "POST", headers: headers(), body: JSON.stringify(args) });

export async function selectOne<T>(table: string, query: string): Promise<T | null> {
  const rows = await call<T[]>(`/rest/v1/${table}?${query}&limit=1`, { headers: headers() });
  return rows[0] ?? null;
}

export const insertRow = (table: string, body: Record<string, unknown> | Record<string, unknown>[]) =>
  call<unknown>(`/rest/v1/${table}`, {
    method: "POST",
    headers: { ...headers(), Prefer: "return=representation" },
    body: JSON.stringify(body),
  });

export const upsertRow = (table: string, body: Record<string, unknown> | Record<string, unknown>[]) =>
  call<unknown>(`/rest/v1/${table}`, {
    method: "POST",
    headers: { ...headers(), Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(body),
  });

export const deleteRow = (table: string, query: string) =>
  call<unknown>(`/rest/v1/${table}?${query}`, {
    method: "DELETE",
    headers: headers(),
  });


