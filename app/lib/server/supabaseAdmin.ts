// Server-only Supabase access with the service-role key. Import this from route handlers only — the key must
// never reach the browser. Uses the REST APIs directly so it runs on any Node version.

import { createPublicKey, verify as verifySig, type JsonWebKey as NodeJwk, type KeyObject } from "node:crypto";

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

// ---- Access tokens verified locally (no round trip to Supabase Auth on every request)

/** The project's token signing keys (Auth → JWT signing keys), fetched once and refreshed when an unknown key id
 *  shows up (at most once a minute). */
let jwks: { at: number; keys: Map<string, KeyObject> } | null = null;
async function signingKey(kid: string): Promise<KeyObject | null> {
  const stale = !jwks || (!jwks.keys.has(kid) && Date.now() - jwks.at > 60000);
  if (stale) {
    try {
      const j = await call<{ keys: ({ kid?: string } & Record<string, unknown>)[] }>("/auth/v1/.well-known/jwks.json", { headers: { apikey: KEY } });
      const keys = new Map<string, KeyObject>();
      for (const k of j.keys ?? []) if (typeof k.kid === "string") keys.set(k.kid, createPublicKey({ key: k as NodeJwk, format: "jwk" }));
      jwks = { at: Date.now(), keys };
    } catch {
      jwks = { at: Date.now(), keys: jwks?.keys ?? new Map() };
    }
  }
  return jwks!.keys.get(kid) ?? null;
}

const b64url = (s: string) => Buffer.from(s, "base64url");

/**
 * Check an ES256 access token against a known public key. "invalid" = forged or expired (reject); "unknown" = not
 * something this check can decide (other algorithm, unknown key, unexpected claims) — ask Supabase Auth instead.
 */
export function checkEs256Token(token: string, key: (kid: string) => KeyObject | null, issuer: string, nowSec = Date.now() / 1000): { userId: string } | "invalid" | "unknown" {
  const parts = token.split(".");
  if (parts.length !== 3) return "invalid";
  try {
    const h = JSON.parse(b64url(parts[0]).toString("utf8"));
    if (h.alg !== "ES256" || typeof h.kid !== "string") return "unknown";
    const k = key(h.kid);
    if (!k) return "unknown";
    const ok = verifySig("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: k, dsaEncoding: "ieee-p1363" }, b64url(parts[2]));
    if (!ok) return "invalid";
    const p = JSON.parse(b64url(parts[1]).toString("utf8"));
    if (typeof p.exp !== "number" || p.exp <= nowSec) return "invalid";
    const aud: unknown[] = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (typeof p.sub !== "string" || p.role !== "authenticated" || !aud.includes("authenticated") || p.iss !== issuer) return "unknown";
    return { userId: p.sub };
  } catch {
    return "invalid";
  }
}

/**
 * The user id behind a browser access token, or null. A token that checks out locally is accepted without a round
 * trip; anything else (expired, unknown key, a failed check) is decided by Supabase Auth exactly as before, so the
 * local check can only save time, never lock anyone out.
 */
export async function userIdFromToken(token: string): Promise<string | null> {
  const parts = token.split(".");
  let kid: string | null = null;
  try { kid = parts.length === 3 ? JSON.parse(b64url(parts[0]).toString("utf8")).kid ?? null : null; } catch { kid = null; }
  if (kid) {
    const k = await signingKey(kid);
    const r = checkEs256Token(token, () => k, `${URL}/auth/v1`);
    if (typeof r === "object") return r.userId;
  }
  return (await userFromToken(token))?.id ?? null;
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



/** Every row matching the query, fetched 1000 at a time. */
export async function selectAll<T>(table: string, query: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await call<T[]>(`/rest/v1/${table}?${query}`, {
      headers: { ...headers(), "Range-Unit": "items", Range: `${from}-${from + 999}` },
    });
    out.push(...page);
    if (page.length < 1000) return out;
  }
}
