"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Browser Supabase client (anon key). Row-level security decides what each signed-in account can read;
// every change goes through database functions or /api routes.

let client: SupabaseClient | null = null;

// The admin console and the player app keep separate sessions, so signing in or out on /admin never logs the
// player out of a table (and the other way round) when both are open in the same browser.
export function supabase(): SupabaseClient {
  if (!client) {
    const staff = typeof window !== "undefined" && window.location.pathname.startsWith("/admin");
    client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { storageKey: staff ? "gamehub-staff-auth" : "gamehub-player-auth" },
    });
  }
  return client;
}

/** Send a request we don't need the answer to. Supabase queries only go out once awaited, so never drop one on the floor. */
export const fire = (q: PromiseLike<unknown>) => { Promise.resolve(q).catch(() => {}); };

/** Turn a Supabase / Postgres error into a sentence for the UI. */
export const errText = (e: unknown) => {
  const msg = e && typeof e === "object" && "message" in e ? String((e as { message: string }).message) : "Something went wrong";
  // A database "permission denied" here means the request went out without a signed-in session.
  return /permission denied/i.test(msg) ? "Your session has ended. Please log in again." : msg;
};

// One join request per table at a time: if a table screen mounts twice in quick succession (double tap,
// React dev re-mount), both share the same request instead of racing to create two tables.
const joins = new Map<string, Promise<{ data: unknown; error: unknown }>>();
export function joinOnce(fn: string, args: Record<string, unknown>) {
  const key = fn + JSON.stringify(args);
  let p = joins.get(key);
  if (!p) {
    p = Promise.resolve(supabase().rpc(fn, args)).then(({ data, error }) => ({ data, error }));
    joins.set(key, p);
    p.finally(() => setTimeout(() => joins.delete(key), 1500));
  }
  return p;
}

/** A usable access token for our /api routes: refreshes the session when the token is missing or about to expire
 *  (a phone that sat in the background can hold an expired token the auto-refresh timer never replaced). */
export async function authToken(): Promise<string> {
  const auth = supabase().auth;
  let { data: { session } } = await auth.getSession();
  const soon = Date.now() / 1000 + 60;
  if (!session || !session.access_token || (session.expires_at ?? 0) < soon) {
    const r = await auth.refreshSession();
    session = r.data.session ?? session;
  }
  if (!session?.access_token) throw new Error("Your session has ended. Please log in again.");
  return session.access_token;
}

/** fetch() against our /api routes with a bearer token. On 401 the session is refreshed once and the request
 *  retried; if the server still rejects it, the dead session is signed out so the login screen shows. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = async (token: string) =>
    fetch(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` } });
  let r = await send(await authToken());
  if (r.status === 401) {
    const { data } = await supabase().auth.refreshSession();
    if (data.session?.access_token) r = await send(data.session.access_token);
    if (r.status === 401) {
      await supabase().auth.signOut();
      throw new Error("Your session has ended. Please log in again.");
    }
  }
  return r;
}
