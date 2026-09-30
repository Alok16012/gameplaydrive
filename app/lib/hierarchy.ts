"use client";

import { useCallback, useEffect, useState } from "react";

// Account hierarchy: Super Admin → Admin → Agent → Player. Each account records the parent that created it,
// and a signed-in account only sees and manages its own downline.
// Demo build: accounts persist in localStorage so players created in /admin can sign in to the player app.

export type Role = "superadmin" | "admin" | "agent" | "player";

export interface Account {
  id: string;
  role: Role;
  name: string;
  phone: string; // 10 digits
  username?: string; // staff sign-in; players sign in with phone + OTP
  password?: string;
  parentId: string | null;
  status: "Active" | "Frozen";
  created: string;
  // player-only fields
  state?: string;
  kyc?: "Verified" | "Pending" | "Rejected";
  bal?: number;
  games?: number;
}

export const ROLE_LABEL: Record<Role, string> = { superadmin: "Super Admin", admin: "Admin", agent: "Agent", player: "Player" };
const RANK: Record<Role, number> = { superadmin: 0, admin: 1, agent: 2, player: 3 };
const PREFIX: Record<Role, string> = { superadmin: "SA-", admin: "ADM-", agent: "AGT-", player: "GH" };

/** Roles an account of `role` may create. */
export const CREATES: Record<Role, Role[]> = { superadmin: ["admin", "agent", "player"], admin: ["agent", "player"], agent: ["player"], player: [] };

export const SEED: Account[] = [
  { id: "SA-0001", role: "superadmin", name: "Super Admin", phone: "9000000001", username: "superadmin", password: "demo1234", parentId: null, status: "Active", created: "01 Jul 2025" },
  { id: "ADM-1001", role: "admin", name: "Rohit Kapoor", phone: "9000000011", username: "admin", password: "demo1234", parentId: "SA-0001", status: "Active", created: "04 Jul 2025" },
  { id: "ADM-1002", role: "admin", name: "Neha Joshi", phone: "9000000012", username: "admin2", password: "demo1234", parentId: "SA-0001", status: "Active", created: "09 Jul 2025" },
  { id: "AGT-2001", role: "agent", name: "Suresh Agency", phone: "9000000021", username: "agent", password: "demo1234", parentId: "ADM-1001", status: "Active", created: "15 Jul 2025" },
  { id: "AGT-2002", role: "agent", name: "Mumbai Gaming Hub", phone: "9000000022", username: "agent2", password: "demo1234", parentId: "ADM-1001", status: "Active", created: "21 Jul 2025" },
  { id: "AGT-2003", role: "agent", name: "Delhi Players Club", phone: "9000000023", username: "agent3", password: "demo1234", parentId: "ADM-1002", status: "Active", created: "28 Jul 2025" },
  { id: "GH123456", role: "player", name: "Rahul Sharma", phone: "9876543210", parentId: "AGT-2001", status: "Active", created: "12 Aug 2025", kyc: "Verified", bal: 2450, games: 142, state: "Maharashtra" },
  { id: "GH118203", role: "player", name: "Priya Verma", phone: "9123456780", parentId: "AGT-2001", status: "Active", created: "14 Aug 2025", kyc: "Verified", bal: 8120, games: 388, state: "Karnataka" },
  { id: "GH130877", role: "player", name: "Arjun Mehta", phone: "9988766554", parentId: "AGT-2002", status: "Active", created: "02 Sep 2025", kyc: "Pending", bal: 540, games: 12, state: "Delhi" },
  { id: "GH127611", role: "player", name: "Sneha Iyer", phone: "9001122334", parentId: "AGT-2002", status: "Active", created: "20 Aug 2025", kyc: "Verified", bal: 15600, games: 911, state: "Tamil Nadu" },
  { id: "GH129954", role: "player", name: "Vikram Singh", phone: "9811100992", parentId: "AGT-2003", status: "Frozen", created: "27 Aug 2025", kyc: "Rejected", bal: 90, games: 47, state: "Punjab" },
  { id: "GH131220", role: "player", name: "Karan Patel", phone: "9722233441", parentId: "AGT-2003", status: "Active", created: "11 Sep 2025", kyc: "Pending", bal: 1200, games: 5, state: "Gujarat" },
  { id: "GH125008", role: "player", name: "Meera Nair", phone: "9633344552", parentId: "ADM-1002", status: "Active", created: "18 Aug 2025", kyc: "Verified", bal: 3310, games: 204, state: "Kerala" },
];

const KEY = "gamehub.accounts.v1";

function load(): Account[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Account[];
  } catch {}
  return SEED;
}

function save(a: Account[]) {
  try { localStorage.setItem(KEY, JSON.stringify(a)); } catch {}
}

/** Accounts store shared by /admin and the player app. `ready` is false until localStorage has been read. */
export function useAccounts() {
  const [accounts, setAccounts] = useState<Account[]>(SEED);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setAccounts(load());
    setReady(true);
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) setAccounts(load()); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const update = useCallback((fn: (a: Account[]) => Account[]) => {
    setAccounts((a) => { const next = fn(a); save(next); return next; });
  }, []);
  const reset = useCallback(() => { save(SEED); setAccounts(SEED); }, []);
  return { accounts, ready, update, reset };
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

export function newId(accounts: Account[], role: Role) {
  let id: string;
  do id = PREFIX[role] + String(Math.floor(100000 + Math.random() * 900000)).slice(role === "player" ? 0 : 2);
  while (accounts.some((a) => a.id === id));
  return id;
}

export const fmtPhone = (p: string) => `${p.slice(0, 5)} ${p.slice(5)}`;
export const today = () => new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
