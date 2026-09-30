"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Browser Supabase client (anon key). Row-level security decides what each signed-in account can read;
// every change goes through database functions or /api routes.

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!client) client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  return client;
}

/** Send a request we don't need the answer to. Supabase queries only go out once awaited, so never drop one on the floor. */
export const fire = (q: PromiseLike<unknown>) => { Promise.resolve(q).catch(() => {}); };

/** Turn a Supabase / Postgres error into a sentence for the UI. */
export const errText = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: string }).message) : "Something went wrong");

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
