"use client";

import { useCallback, useEffect, useState } from "react";
import { errText, supabase } from "./supabase";

// Account hierarchy: Super Admin → Admin → Agent → Player, stored in Supabase (public.profiles + wallets).
// Row-level security returns only the signed-in account and its downline; changes go through database
// functions (freeze, coins) or POST /api/accounts (new logins).

export type Role = "superadmin" | "admin" | "agent" | "player";

export interface Account {
  id: string; // auth user id
  code: string; // human id: SA-0001, ADM-1234, AGT-5678, GH123456
  role: Role;
  name: string;
  phone: string | null;
  username: string | null;
  parentId: string | null;
  status: "Active" | "Frozen";
  created: string;
  state: string | null;
  coins: number;
}

export const ROLE_LABEL: Record<Role, string> = { superadmin: "Super Admin", admin: "Admin", agent: "Agent", player: "Player" };
const RANK: Record<Role, number> = { superadmin: 0, admin: 1, agent: 2, player: 3 };

/** Roles an account of `role` may create. */
export const CREATES: Record<Role, Role[]> = { superadmin: ["admin", "agent", "player"], admin: ["agent", "player"], agent: ["player"], player: [] };

interface Row {
  id: string; code: string; role: Role; name: string; phone: string | null; username: string | null; parent_id: string | null;
  status: "active" | "frozen"; created_at: string; state: string | null; wallets: { coins: number } | null;
}

const toAccount = (r: Row): Account => ({
  id: r.id, code: r.code, role: r.role, name: r.name, phone: r.phone, username: r.username, parentId: r.parent_id,
  status: r.status === "active" ? "Active" : "Frozen", state: r.state, coins: r.wallets?.coins ?? 0,
  created: new Date(r.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
});

/** The signed-in account's profile, or null. */
export async function loadMe(): Promise<Account | null> {
  const sb = supabase();
  const { data: s } = await sb.auth.getSession();
  if (!s.session) return null;
  const { data } = await sb.from("profiles").select("*, wallets(coins)").eq("id", s.session.user.id).maybeSingle();
  return data ? toAccount(data as Row) : null;
}

/** Signed-in account + everything it can see. `me` is undefined while loading and null when signed out. */
export function useAccounts() {
  const [me, setMe] = useState<Account | null | undefined>(undefined);
  const [accounts, setAccounts] = useState<Account[]>([]);

  const reload = useCallback(async () => {
    const mine = await loadMe();
    setMe(mine);
    if (!mine) return setAccounts([]);
    const { data } = await supabase().from("profiles").select("*, wallets(coins)").order("created_at");
    setAccounts(((data ?? []) as Row[]).map(toAccount));
  }, []);

  useEffect(() => {
    reload();
    const { data } = supabase().auth.onAuthStateChange((e) => { if (e === "SIGNED_OUT" || e === "SIGNED_IN") reload(); });
    return () => data.subscription.unsubscribe();
  }, [reload]);

  return { me, accounts, reload };
}

/** Create a login under the signed-in account (server checks the hierarchy rules). */
export async function createAccount(body: { role: Role; name: string; phone: string; username?: string; password: string; parentId: string; state?: string }): Promise<Account> {
  const { data: s } = await supabase().auth.getSession();
  const r = await fetch("/api/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.session?.access_token ?? ""}` },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Could not create account");
  return toAccount({ ...j.profile, wallets: { coins: 0 } });
}

/** Edit an account's details (and optionally set a new password). The server checks the editor may do this. */
export async function updateAccount(body: { id: string; name: string; phone: string; username?: string; state?: string; password?: string }): Promise<void> {
  const { data: s } = await supabase().auth.getSession();
  const r = await fetch("/api/accounts", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.session?.access_token ?? ""}` },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? "Could not save");
}

export async function setStatus(id: string, status: "Active" | "Frozen") {
  const { error } = await supabase().rpc("set_account_status", { target: id, new_status: status.toLowerCase() });
  if (error) throw new Error(errText(error));
}

/** Positive: give coins; negative: take them back. Only the Super Admin creates new coins. */
export async function transferCoins(id: string, amount: number) {
  const { error } = await supabase().rpc("transfer_coins", { target: id, amount });
  if (error) throw new Error(errText(error));
}

/** Every account below `id` (children, grandchildren, …). */
export function downline(accounts: Account[], id: string): Account[] {
  const out: Account[] = [];
  const walk = (pid: string) => accounts.filter((a) => a.parentId === pid).forEach((a) => { out.push(a); walk(a.id); });
  walk(id);
  return out;
}

/** Accounts `me` can pick as the owner of a new `role` account: itself plus downline accounts ranked above `role`. */
export function ownerOptions(accounts: Account[], me: Account, role: Role): Account[] {
  return [me, ...downline(accounts, me.id)].filter((a) => a.status === "Active" && RANK[a.role] < RANK[role]);
}

export const fmtPhone = (p: string | null) => (p ? `${p.slice(0, 5)} ${p.slice(5)}` : "—");
export const coins = (n: number) => `🪙 ${Math.round(n).toLocaleString("en-IN")}`;
