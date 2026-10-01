"use client";

import { useEffect, useState } from "react";
import {
  Ban, Bot as BotIcon, Briefcase, Pencil, ChevronRight, ClipboardList, Coins, Crown, Gamepad2, KeyRound, LayoutDashboard, LogOut, Network, RotateCcw, Search, Snowflake, Sparkles, Trash2, UserPlus, Users, X,
} from "lucide-react";
import { GAMES, type GameId } from "../lib/data";
import { GameIcon } from "../components/GameArt";
import { BOT_AVATARS, randomBal, randomName, useBotConfig } from "../lib/botpool";
import { CREATES, ROLE_LABEL, coins, createAccount, downline, fmtPhone, ownerOptions, setStatus, transferCoins, updateAccount, useAccounts, type Account, type Role } from "../lib/hierarchy";
import { staffEmail } from "../lib/loginEmail";
import { errText, supabase } from "../lib/supabase";

// Admin console, backed by Supabase. Super Admin creates admins, agents and players and is the only account
// that can create coins; Admin creates agents and players; Agent creates players. Everyone sees only their own
// downline (row-level security) and every change is written to the audit log by the database.

type Section = "dashboard" | "admins" | "agents" | "players" | "bots" | "network" | "config" | "audit";

export default function AdminApp() {
  const { me, accounts, reload } = useAccounts();
  const [sec, setSec] = useState<Section>("dashboard");

  if (me === undefined) return <div className="min-h-dvh bg-[#070b22]" />;
  if (!me || me.role === "player" || me.status !== "Active") return <AdminLogin blocked={me ? (me.role === "player" ? "player" : "frozen") : null} />;

  const all: { id: Section; label: string; icon: React.ReactNode; roles: Role[] }[] = [
    { id: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={18} />, roles: ["superadmin", "admin", "agent"] },
    { id: "admins", label: "Admins", icon: <Crown size={18} />, roles: ["superadmin"] },
    { id: "agents", label: "Agents", icon: <Briefcase size={18} />, roles: ["superadmin", "admin"] },
    { id: "players", label: "Players", icon: <Users size={18} />, roles: ["superadmin", "admin", "agent"] },
    { id: "bots", label: "Bots", icon: <BotIcon size={18} />, roles: ["superadmin"] },
    { id: "network", label: "Network", icon: <Network size={18} />, roles: ["superadmin", "admin"] },
    { id: "config", label: "Game Config", icon: <Gamepad2 size={18} />, roles: ["superadmin"] },
    { id: "audit", label: "Audit Log", icon: <ClipboardList size={18} />, roles: ["superadmin", "admin", "agent"] },
  ];
  const nav = all.filter((n) => n.roles.includes(me.role));
  const logout = () => supabase().auth.signOut();
  const ctx: Ctx = { me, accounts, reload };

  return (
    <div className="min-h-dvh bg-[#070b22] text-white flex">
      <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-white/5 bg-[#0a0f2c] p-4 sticky top-0 h-dvh">
        <Brand role={me.role} />
        <nav className="mt-8 space-y-1 flex-1">
          {nav.map((n) => (
            <button key={n.id} onClick={() => setSec(n.id)} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm ${sec === n.id ? "bg-neon-400/15 text-neon-400 font-medium" : "text-white/70 hover:bg-white/5"}`}>
              {n.icon}{n.label}
            </button>
          ))}
        </nav>
        <div className="rounded-xl bg-white/5 px-3 py-2.5 mb-2">
          <div className="text-sm font-medium truncate">{me.name}</div>
          <div className="text-[11px] text-white/50">{ROLE_LABEL[me.role]} • {me.code}</div>
          <div className="text-xs text-gold-300 mt-1">{me.role === "superadmin" ? "Creates coins" : coins(me.coins)}</div>
        </div>
        <button onClick={logout} className="flex items-center gap-3 px-3 py-2.5 text-sm text-white/60"><LogOut size={18} />Logout</button>
      </aside>

      <main className="flex-1 min-w-0">
        <div className="lg:hidden sticky top-0 z-10 bg-[#0a0f2c]/95 backdrop-blur border-b border-white/5">
          <div className="px-4 pt-4 flex items-center justify-between"><Brand role={me.role} /><button onClick={logout} aria-label="Logout"><LogOut size={18} /></button></div>
          <div className="flex gap-2 overflow-x-auto no-scrollbar px-4 py-3">
            {nav.map((n) => (
              <button key={n.id} onClick={() => setSec(n.id)} className={`pill px-3 py-1.5 text-xs whitespace-nowrap ${sec === n.id ? "btn-green" : "bg-white/5"}`}>{n.label}</button>
            ))}
          </div>
        </div>
        <div className="p-4 lg:p-8 max-w-6xl">
          {sec === "dashboard" && <Dashboard {...ctx} go={setSec} />}
          {sec === "admins" && <AccountsView key="admin" role="admin" {...ctx} />}
          {sec === "agents" && <AccountsView key="agent" role="agent" {...ctx} />}
          {sec === "players" && <AccountsView key="player" role="player" {...ctx} />}
          {sec === "bots" && <BotsView />}
          {sec === "network" && <NetworkView {...ctx} />}
          {sec === "config" && <ConfigView />}
          {sec === "audit" && <AuditView />}
        </div>
      </main>
    </div>
  );
}

interface Ctx { me: Account; accounts: Account[]; reload: () => Promise<void> }

function Brand({ role }: { role?: Role }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-9 h-9 rounded-xl grid place-items-center text-lg" style={{ background: "linear-gradient(135deg,#fde68a,#f59e0b)" }}>♠</div>
      <div><div className="font-bold leading-none">Game<span className="gold-text">Hub</span></div><div className="text-[10px] text-white/50">{role ? `${ROLE_LABEL[role]} Console` : "Admin Console"}</div></div>
    </div>
  );
}

function AdminLogin({ blocked }: { blocked: "player" | "frozen" | null }) {
  const [user, setUser] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!blocked) return;
    setErr(blocked === "player" ? "Player accounts sign in on the player app." : "This account is frozen. Contact the account that created it.");
    supabase().auth.signOut();
  }, [blocked]);
  const submit = async () => {
    if (!user.trim() || !pw) return setErr("Enter your username and password");
    setBusy(true);
    const { error } = await supabase().auth.signInWithPassword({ email: staffEmail(user), password: pw });
    setBusy(false);
    if (error) setErr(/invalid/i.test(error.message) ? "Wrong username or password" : error.message);
  };
  return (
    <div className="min-h-dvh grid place-items-center bg-[#070b22] px-4">
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="w-full max-w-sm card p-6">
        <Brand />
        <div className="text-xl font-semibold mt-6">Sign in</div>
        <div className="text-xs text-white/50 mt-1">Super Admin, Admin and Agent accounts • all actions are audited</div>
        <input value={user} onChange={(e) => { setUser(e.target.value); setErr(""); }} placeholder="Username" autoComplete="username" autoCapitalize="none" className="w-full mt-5 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm outline-none" />
        <input type="password" value={pw} onChange={(e) => { setPw(e.target.value); setErr(""); }} placeholder="Password" autoComplete="current-password" className="w-full mt-3 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm outline-none" />
        {err && <div className="text-xs text-rose-300 mt-3">{err}</div>}
        <button type="submit" disabled={busy} className="btn-green w-full py-3 rounded-xl mt-5">{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}

function Title({ t, s, right }: { t: string; s?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-5">
      <div><h1 className="text-2xl font-semibold">{t}</h1>{s && <p className="text-sm text-white/50 mt-0.5">{s}</p>}</div>
      {right}
    </div>
  );
}

function Pill({ tone, children }: { tone: "green" | "amber" | "red" | "gray"; children: React.ReactNode }) {
  const c = { green: "bg-neon-400/15 text-neon-400", amber: "bg-amber-400/15 text-amber-300", red: "bg-rose-500/15 text-rose-300", gray: "bg-white/10 text-white/70" }[tone];
  return <span className={`pill px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${c}`}>{children}</span>;
}

const STATES = ["Maharashtra", "Karnataka", "Delhi", "Tamil Nadu", "Punjab", "Gujarat", "Kerala", "Uttar Pradesh", "West Bengal", "Rajasthan", "Madhya Pradesh", "Bihar", "Haryana", "Goa", "Telangana", "Andhra Pradesh", "Odisha", "Assam"];

/** Accounts visible to `me` (row-level security already limits the list to its downline). */
const scopeOf = (accounts: Account[], me: Account) => accounts.filter((a) => a.id !== me.id);

function Dashboard({ me, accounts, go }: Ctx & { go: (s: Section) => void }) {
  const scope = scopeOf(accounts, me);
  const players = scope.filter((a) => a.role === "player");
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const recent = [...players].reverse().slice(0, 6);
  const cards: { l: string; v: string; d: string; s?: Section; show: boolean }[] = [
    { l: "Admins", v: String(scope.filter((a) => a.role === "admin").length), d: "in your network", s: "admins", show: me.role === "superadmin" },
    { l: "Agents", v: String(scope.filter((a) => a.role === "agent").length), d: `${scope.filter((a) => a.role === "agent" && a.status === "Frozen").length} frozen`, s: "agents", show: me.role !== "agent" },
    { l: "Players", v: String(players.length), d: `${players.filter((p) => p.status === "Active").length} active`, s: "players", show: true },
    { l: "Coins with players", v: coins(players.reduce((t, p) => t + p.coins, 0)), d: "current balances", show: true },
    { l: "Coins with staff", v: coins(scope.filter((a) => a.role !== "player").reduce((t, p) => t + p.coins, 0)), d: "admins & agents", show: me.role !== "agent" },
    { l: "Your coins", v: me.role === "superadmin" ? "∞" : coins(me.coins), d: me.role === "superadmin" ? "you create coins" : "available to hand out", show: true },
  ];
  return (
    <>
      <Title t={`Welcome, ${me.name}`} s={me.role === "superadmin" ? "Your whole network" : me.role === "admin" ? "Your agents and their players" : "Players you manage"} />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.filter((c) => c.show).map((c) => (
          <button key={c.l} disabled={!c.s} onClick={() => c.s && go(c.s)} className="card p-4 text-left enabled:hover:bg-white/[.07]">
            <div className="text-[11px] text-white/50">{c.l}</div>
            <div className="text-xl lg:text-2xl font-semibold mt-1">{c.v}</div>
            <div className="text-[11px] text-white/50 mt-0.5">{c.d}</div>
          </button>
        ))}
      </div>
      <div className="card p-5 mt-4">
        <div className="flex items-center justify-between">
          <div className="font-medium">Latest players</div>
          <button onClick={() => go("players")} className="text-xs text-neon-400">View all</button>
        </div>
        <div className="mt-3 divide-y divide-white/5">
          {recent.map((p) => (
            <div key={p.id} className="flex items-center justify-between py-2.5 text-sm">
              <div><div className="font-medium">{p.name}</div><div className="text-[11px] text-white/50">{p.code} • via {byId.get(p.parentId ?? "")?.name ?? "—"}</div></div>
              <div className="flex items-center gap-3"><span className="text-xs text-gold-300 tabular-nums">{coins(p.coins)}</span><Pill tone={p.status === "Active" ? "green" : "red"}>{p.status}</Pill></div>
            </div>
          ))}
          {recent.length === 0 && <div className="text-sm text-white/50 py-4">No players yet. Create one from the Players tab.</div>}
        </div>
      </div>
    </>
  );
}

function AccountsView({ role, me, accounts, reload }: Ctx & { role: Role }) {
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [coinsFor, setCoinsFor] = useState<Account | null>(null);
  const [editing, setEditing] = useState<Account | null>(null);
  const [err, setErr] = useState("");
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const rows = scopeOf(accounts, me).filter((a) => a.role === role);
  const list = rows.filter((u) => (u.name + u.code + (u.phone ?? "") + (u.username ?? "")).toLowerCase().includes(q.toLowerCase()));
  const canCreate = CREATES[me.role].includes(role);
  const toggle = async (u: Account) => {
    try {
      await setStatus(u.id, u.status === "Frozen" ? "Active" : "Frozen");
      setErr("");
      await reload();
    } catch (e) { setErr(errText(e)); }
  };
  const owner = (u: Account) => {
    const p = byId.get(u.parentId ?? "");
    return p ? <><div>{p.id === me.id ? "You" : p.name}</div><div className="text-[11px] text-white/50">{ROLE_LABEL[p.role]}</div></> : "—";
  };
  const plural = { admin: "Admins", agent: "Agents", player: "Players", superadmin: "Super Admins" }[role];
  const sub = {
    admin: "Admins can create agents and players",
    agent: "Agents can create players",
    player: me.role === "agent" ? "Players you created" : "Players across your network",
    superadmin: "",
  }[role];
  const head = role === "player"
    ? ["Player", "Phone", "Created by", "State", "Coins", "Status", ""]
    : ["Name", "Username", "Phone", "Reports to", role === "admin" ? "Agents" : "Players", "Coins", "Status", ""];

  return (
    <>
      <Title t={plural} s={`${rows.length} ${plural.toLowerCase()} • ${sub}`} right={canCreate && (
        <button onClick={() => setCreating(true)} className="btn-green rounded-xl px-3.5 py-2 text-sm flex items-center gap-1.5 whitespace-nowrap"><UserPlus size={16} />New {ROLE_LABEL[role]}</button>
      )} />
      <div className="card flex items-center gap-2 px-4 py-2.5 mb-4"><Search size={16} className="text-white/40" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, ID or phone" className="bg-transparent outline-none text-sm flex-1" /></div>
      {err && <div className="text-xs text-rose-300 mb-3">{err}</div>}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[820px]">
          <thead><tr className="text-left text-[11px] text-white/50 border-b border-white/5">{head.map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.id} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-3"><div className="font-medium">{u.name}</div><div className="text-[11px] text-white/50">{u.code} • {u.created}</div></td>
                {role === "player" ? (
                  <>
                    <td className="px-4 py-3 text-white/70 whitespace-nowrap">{fmtPhone(u.phone)}</td>
                    <td className="px-4 py-3 text-white/70">{owner(u)}</td>
                    <td className="px-4 py-3 text-white/70">{u.state ?? "—"}</td>
                  </>
                ) : (
                  <>
                    <td className="px-4 py-3 text-white/70">{u.username}</td>
                    <td className="px-4 py-3 text-white/70 whitespace-nowrap">{fmtPhone(u.phone)}</td>
                    <td className="px-4 py-3 text-white/70">{owner(u)}</td>
                    <td className="px-4 py-3 tabular-nums">{downline(accounts, u.id).filter((a) => a.role === (role === "admin" ? "agent" : "player")).length}</td>
                  </>
                )}
                <td className="px-4 py-3 tabular-nums text-gold-300 whitespace-nowrap">{coins(u.coins)}</td>
                <td className="px-4 py-3"><Pill tone={u.status === "Active" ? "green" : "red"}>{u.status}</Pill></td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button onClick={() => setEditing(u)} className="btn-ghost rounded-lg px-2.5 py-1.5 text-xs inline-flex items-center gap-1 mr-2"><Pencil size={13} />Edit</button>
                  <button onClick={() => setCoinsFor(u)} className="btn-ghost rounded-lg px-2.5 py-1.5 text-xs inline-flex items-center gap-1"><Coins size={13} />Coins</button>
                  <button onClick={() => toggle(u)} className="btn-ghost rounded-lg px-2.5 py-1.5 text-xs inline-flex items-center gap-1 ml-2">{u.status === "Frozen" ? <Snowflake size={13} /> : <Ban size={13} />}{u.status === "Frozen" ? "Unfreeze" : "Freeze"}</button>
                </td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={head.length} className="px-4 py-10 text-center text-white/50">No {plural.toLowerCase()} yet{canCreate ? ` — use “New ${ROLE_LABEL[role]}” to add one` : ""}.</td></tr>}
          </tbody>
        </table>
      </div>
      {creating && <CreateModal role={role} me={me} accounts={accounts} reload={reload} onClose={() => setCreating(false)} />}
      {coinsFor && <CoinsModal target={coinsFor} me={me} accounts={accounts} reload={reload} onClose={() => setCoinsFor(null)} />}
      {editing && <EditModal target={editing} accounts={accounts} reload={reload} onClose={() => setEditing(null)} />}
    </>
  );
}

const inputCls = "w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-neon-400";

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center p-4" onClick={onClose}>
      <div className="card w-full max-w-md p-6 bg-[#0d1335]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div className="text-lg font-semibold">{title}</div>
          <button onClick={onClose} className="text-white/50" aria-label="Close"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Edit name / mobile / username or state, and optionally set a new password. Changing a player's mobile number or a
 *  staff username changes what they sign in with — the form says so. */
function EditModal({ target, accounts, reload, onClose }: { target: Account; accounts: Account[]; reload: () => Promise<void>; onClose: () => void }) {
  const staff = target.role !== "player";
  const [f, setF] = useState({ name: target.name, phone: target.phone ?? "", username: target.username ?? "", state: target.state ?? "", password: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setErr(""); };
  const owner = accounts.find((a) => a.id === target.parentId);
  const loginChanged = staff ? f.username.trim().toLowerCase() !== (target.username ?? "") : f.phone !== (target.phone ?? "");
  const dirty = f.name.trim() !== target.name || f.phone !== (target.phone ?? "") || f.username.trim().toLowerCase() !== (target.username ?? "") || f.state !== (target.state ?? "") || f.password !== "";

  const submit = async () => {
    if (!f.name.trim()) return setErr("Enter a name");
    if (f.phone && !/^\d{10}$/.test(f.phone)) return setErr("Enter a 10-digit mobile number");
    if (!staff && !f.phone) return setErr("Players need a mobile number to sign in");
    if (staff && !/^[a-z0-9._]{3,}$/i.test(f.username.trim())) return setErr("Username: at least 3 letters, numbers, dots or underscores");
    if (f.password && f.password.length < 6) return setErr("Password must be at least 6 characters");
    setBusy(true);
    try {
      await updateAccount({ id: target.id, name: f.name.trim(), phone: f.phone, username: staff ? f.username.trim().toLowerCase() : undefined, state: staff ? undefined : f.state, password: f.password || undefined });
      await reload();
      setSaved(true);
    } catch (e) {
      setErr(errText(e));
    }
    setBusy(false);
  };

  return (
    <Modal title={saved ? "Changes saved" : `Edit ${ROLE_LABEL[target.role]}`} onClose={onClose}>
      {saved ? (
        <>
          <div className="mt-4 rounded-xl bg-neon-400/10 border border-neon-400/20 p-4 text-sm space-y-1.5">
            <div className="flex justify-between"><span className="text-white/60">ID</span><b>{target.code}</b></div>
            <div className="flex justify-between"><span className="text-white/60">Name</span><span>{f.name.trim()}</span></div>
            {f.phone && <div className="flex justify-between"><span className="text-white/60">Mobile</span><span>+91 {fmtPhone(f.phone)}</span></div>}
            {staff && <div className="flex justify-between"><span className="text-white/60">Username</span><span>{f.username.trim().toLowerCase()}</span></div>}
          </div>
          {(loginChanged || f.password) && (
            <div className="text-xs text-amber-200 mt-3">
              {loginChanged && <>They now sign in with their new {staff ? "username" : "mobile number"}. </>}
              {f.password && <>Share the new password with them.</>}
            </div>
          )}
          <button onClick={onClose} className="btn-green w-full py-2.5 rounded-xl mt-5 text-sm">Done</button>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="mt-4 space-y-3">
          <div className="rounded-xl bg-white/5 px-3 py-2 text-xs text-white/60 flex justify-between">
            <span>{target.code} • {target.status}</span><span>Reports to {owner?.name ?? "—"}</span>
          </div>
          <label className="block text-xs text-white/60">Full name<input autoFocus value={f.name} onChange={(e) => set("name", e.target.value)} className={`${inputCls} mt-1`} /></label>
          <label className="block text-xs text-white/60">Mobile number{staff && <span className="text-white/40"> (optional)</span>}
            <div className="flex items-center gap-2 mt-1"><span className="text-sm text-white/60">+91</span><input inputMode="numeric" value={f.phone} onChange={(e) => set("phone", e.target.value.replace(/\D/g, "").slice(0, 10))} className={inputCls} /></div>
          </label>
          {staff ? (
            <label className="block text-xs text-white/60">Username<input value={f.username} onChange={(e) => set("username", e.target.value.toLowerCase())} autoComplete="off" autoCapitalize="none" className={`${inputCls} mt-1`} /></label>
          ) : (
            <label className="block text-xs text-white/60">State
              <select value={f.state} onChange={(e) => set("state", e.target.value)} className={`${inputCls} mt-1`}>
                <option value="" className="bg-[#0d1335]">—</option>
                {STATES.map((st) => <option key={st} className="bg-[#0d1335]">{st}</option>)}
              </select>
            </label>
          )}
          <label className="block text-xs text-white/60">New password <span className="text-white/40">(leave blank to keep the current one)</span>
            <input type="password" value={f.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" className={`${inputCls} mt-1`} />
          </label>
          {loginChanged && <div className="text-[11px] text-amber-200">This changes what they sign in with.</div>}
          {err && <div className="text-xs text-rose-300">{err}</div>}
          <button type="submit" disabled={busy || !dirty} className="btn-green w-full py-2.5 rounded-xl text-sm !mt-5">{busy ? "Saving…" : "Save changes"}</button>
        </form>
      )}
    </Modal>
  );
}

function CreateModal({ role, me, accounts, reload, onClose }: Ctx & { role: Role; onClose: () => void }) {
  const owners = ownerOptions(accounts, me, role);
  const [f, setF] = useState({ name: "", phone: "", username: "", password: "", state: STATES[0], owner: owners[0]?.id ?? me.id });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Account | null>(null);
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setErr(""); };
  const staff = role !== "player";

  const submit = async () => {
    if (!f.name.trim()) return setErr("Enter a name");
    if (!/^\d{10}$/.test(f.phone) && (!staff || f.phone)) return setErr("Enter a 10-digit mobile number");
    if (staff && !/^[a-z0-9._]{3,}$/i.test(f.username)) return setErr("Username: at least 3 letters, numbers, dots or underscores");
    if (f.password.length < 6) return setErr("Password must be at least 6 characters");
    setBusy(true);
    try {
      const acc = await createAccount({ role, name: f.name.trim(), phone: f.phone, username: staff ? f.username : undefined, password: f.password, parentId: f.owner, state: staff ? undefined : f.state });
      await reload();
      setDone(acc);
    } catch (e) {
      setErr(errText(e));
    }
    setBusy(false);
  };

  return (
    <Modal title={done ? `${ROLE_LABEL[role]} created` : `New ${ROLE_LABEL[role]}`} onClose={onClose}>
      {done ? (
        <>
          <div className="mt-4 rounded-xl bg-neon-400/10 border border-neon-400/20 p-4 text-sm space-y-1.5">
            <div className="flex justify-between"><span className="text-white/60">ID</span><b>{done.code}</b></div>
            <div className="flex justify-between"><span className="text-white/60">Name</span><span>{done.name}</span></div>
            {done.phone && <div className="flex justify-between"><span className="text-white/60">Mobile</span><span>+91 {fmtPhone(done.phone)}</span></div>}
            {staff && <div className="flex justify-between"><span className="text-white/60">Username</span><span>{done.username}</span></div>}
          </div>
          <div className="text-xs text-white/50 mt-3">
            {staff ? `They sign in to this console with their username and the password you set.` : "They sign in to the player app with this mobile number and the password you set. Give them coins from the Players list."}
          </div>
          <button onClick={onClose} className="btn-green w-full py-2.5 rounded-xl mt-5 text-sm">Done</button>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="mt-4 space-y-3">
          <label className="block text-xs text-white/60">Full name<input autoFocus value={f.name} onChange={(e) => set("name", e.target.value)} className={`${inputCls} mt-1`} /></label>
          <label className="block text-xs text-white/60">Mobile number{staff && <span className="text-white/40"> (optional)</span>}
            <div className="flex items-center gap-2 mt-1"><span className="text-sm text-white/60">+91</span><input inputMode="numeric" value={f.phone} onChange={(e) => set("phone", e.target.value.replace(/\D/g, "").slice(0, 10))} className={inputCls} /></div>
          </label>
          <div className="grid grid-cols-2 gap-3">
            {staff ? (
              <label className="block text-xs text-white/60">Username<input value={f.username} onChange={(e) => set("username", e.target.value.toLowerCase())} autoComplete="off" autoCapitalize="none" className={`${inputCls} mt-1`} /></label>
            ) : (
              <label className="block text-xs text-white/60">State<select value={f.state} onChange={(e) => set("state", e.target.value)} className={`${inputCls} mt-1`}>{STATES.map((s) => <option key={s} className="bg-[#0d1335]">{s}</option>)}</select></label>
            )}
            <label className="block text-xs text-white/60">Password<input type="password" value={f.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" className={`${inputCls} mt-1`} /></label>
          </div>
          {owners.length > 1 && (
            <label className="block text-xs text-white/60">Reports to
              <select value={f.owner} onChange={(e) => set("owner", e.target.value)} className={`${inputCls} mt-1`}>
                {owners.map((o) => <option key={o.id} value={o.id} className="bg-[#0d1335]">{o.id === me.id ? `Me (${o.name})` : `${o.name} — ${ROLE_LABEL[o.role]}`}</option>)}
              </select>
            </label>
          )}
          {err && <div className="text-xs text-rose-300">{err}</div>}
          <button type="submit" disabled={busy} className="btn-green w-full py-2.5 rounded-xl text-sm !mt-5">{busy ? "Creating…" : `Create ${ROLE_LABEL[role]}`}</button>
        </form>
      )}
    </Modal>
  );
}

function CoinsModal({ target, me, reload, onClose }: Ctx & { target: Account; onClose: () => void }) {
  const [dir, setDir] = useState<"give" | "take">("give");
  const [amt, setAmt] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const sa = me.role === "superadmin";
  const n = Number(amt);
  const submit = async () => {
    if (!Number.isInteger(n) || n <= 0) return setErr("Enter a whole number of coins");
    if (dir === "give" && !sa && n > me.coins) return setErr(`You only have ${coins(me.coins)}`);
    if (dir === "take" && n > target.coins) return setErr(`${target.name} only has ${coins(target.coins)}`);
    setBusy(true);
    try {
      await transferCoins(target.id, dir === "give" ? n : -n);
      await reload();
      onClose();
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={`Coins • ${target.name}`} onClose={onClose}>
      <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-xl bg-white/5 p-3"><div className="text-[11px] text-white/50">{target.name}</div><div className="font-semibold text-gold-300">{coins(target.coins)}</div></div>
        <div className="rounded-xl bg-white/5 p-3"><div className="text-[11px] text-white/50">You</div><div className="font-semibold text-gold-300">{sa ? "Unlimited" : coins(me.coins)}</div></div>
      </div>
      <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-white/5 mt-4">
        {(["give", "take"] as const).map((d) => (
          <button key={d} onClick={() => { setDir(d); setErr(""); }} className={`rounded-lg py-2 text-xs font-medium ${dir === d ? "btn-green" : "text-white/70"}`}>{d === "give" ? (sa ? "Create & give" : "Give coins") : "Take back"}</button>
        ))}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <input autoFocus inputMode="numeric" value={amt} onChange={(e) => { setAmt(e.target.value.replace(/\D/g, "")); setErr(""); }} placeholder="Amount" className={`${inputCls} mt-3 text-lg`} />
        <div className="flex gap-2 mt-2">{[100, 500, 1000, 5000].map((v) => <button type="button" key={v} onClick={() => setAmt(String(v))} className="pill bg-white/5 px-3 py-1 text-xs">{v.toLocaleString("en-IN")}</button>)}</div>
        <div className="text-[11px] text-white/50 mt-3">
          {dir === "give" ? (sa ? "New coins are created and added to their balance." : "Coins move from your balance to theirs.") : sa ? "Coins are removed from their balance." : "Coins move from their balance back to yours."}
        </div>
        {err && <div className="text-xs text-rose-300 mt-2">{err}</div>}
        <button type="submit" disabled={busy} className="btn-green w-full py-2.5 rounded-xl text-sm mt-4">{busy ? "Saving…" : dir === "give" ? "Give coins" : "Take back coins"}</button>
      </form>
    </Modal>
  );
}

function NetworkNode({ a, depth, accounts }: { a: Account; depth: number; accounts: Account[] }) {
  const kids = accounts.filter((x) => x.parentId === a.id);
  const [open, setOpen] = useState(depth < 2);
  const tone = a.role === "admin" ? "amber" : a.role === "agent" ? "gray" : "green";
  return (
    <div>
      <button onClick={() => setOpen(!open)} disabled={!kids.length} className="w-full flex items-center gap-2 py-2 text-left text-sm hover:bg-white/[.03] rounded-lg" style={{ paddingLeft: depth * 22 + 8 }}>
        <ChevronRight size={14} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""} ${kids.length ? "text-white/50" : "opacity-0"}`} />
        <span className={`font-medium ${a.status === "Frozen" ? "text-white/40 line-through" : ""}`}>{a.name}</span>
        <span className="text-[11px] text-white/40">{a.code}</span>
        {a.role !== "superadmin" && <Pill tone={tone}>{ROLE_LABEL[a.role]}</Pill>}
        {kids.length > 0 && <span className="text-[11px] text-white/40 ml-auto pr-2">{kids.length} direct</span>}
      </button>
      {open && kids.map((k) => <NetworkNode key={k.id} a={k} depth={depth + 1} accounts={accounts} />)}
    </div>
  );
}

function NetworkView({ me, accounts }: Ctx) {
  return (
    <>
      <Title t="Network" s="Who created whom — Super Admin → Admin → Agent → Player" />
      <div className="card p-3"><NetworkNode a={me} depth={0} accounts={accounts} /></div>
    </>
  );
}

function BotsView() {
  const { cfg, err: saveErr, setAuto: saveAuto, add: saveAdd, toggle, remove } = useBotConfig();
  const [sample, setSample] = useState<string[]>([]);
  const [form, setForm] = useState<{ name: string; emoji: string; bal: string } | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [bulk, setBulk] = useState(10);
  useEffect(() => setSample(Array.from({ length: 10 }, randomName)), []);
  const active = cfg.custom.filter((b) => b.active).length;
  const list = cfg.custom.filter((b) => b.name.toLowerCase().includes(q.toLowerCase()));
  const setAuto = (on: boolean) => saveAuto(on);
  const add = () => {
    if (!form) return;
    const name = form.name.trim();
    if (name.length < 3) return setErr("Name needs at least 3 characters");
    if (cfg.custom.some((b) => b.name.toLowerCase() === name.toLowerCase())) return setErr("A bot with this name already exists");
    saveAdd([{ name, emoji: form.emoji, bal: Number(form.bal) || randomBal() }], `Bot created • ${name}`);
    setForm(null);
  };
  const generate = () => {
    const taken = new Set(cfg.custom.map((b) => b.name.toLowerCase()));
    const made: { name: string; emoji: string; bal: number }[] = [];
    for (let guard = 0; made.length < bulk && guard < bulk * 20; guard++) {
      const name = randomName();
      if (taken.has(name.toLowerCase())) continue;
      taken.add(name.toLowerCase());
      made.push({ name, emoji: BOT_AVATARS[Math.floor(Math.random() * BOT_AVATARS.length)], bal: randomBal() });
    }
    saveAdd(made, `Generated ${made.length} bots`);
  };
  const input = "w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-neon-400";

  return (
    <>
      <Title t="Bots" s="Opponents that fill seats at every table • always shown with a BOT label" right={
        <button onClick={() => { setForm({ name: "", emoji: BOT_AVATARS[0], bal: "" }); setErr(""); }} className="btn-green rounded-xl px-3.5 py-2 text-sm flex items-center gap-1.5 whitespace-nowrap"><UserPlus size={16} />New Bot</button>
      } />

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="card p-5 lg:col-span-2">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="font-medium flex items-center gap-2"><Sparkles size={16} className="text-neon-400" /> Auto-generate unlimited bots</div>
              <div className="text-xs text-white/50 mt-1 max-w-md">
                {cfg.auto
                  ? "On — every table gets freshly generated names and avatars, mixed with your custom bots. Players rarely see the same opponent twice."
                  : "Off — only your custom bots below take seats. Generated names fill in only when there aren't enough active custom bots for a table."}
              </div>
            </div>
            <button onClick={() => setAuto(!cfg.auto)} className={`w-11 h-6 shrink-0 rounded-full p-0.5 transition-colors ${cfg.auto ? "bg-neon-500" : "bg-white/15"}`}>
              <div className={`w-5 h-5 rounded-full bg-white transition-transform ${cfg.auto ? "translate-x-5" : ""}`} />
            </button>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <div className="text-[11px] text-white/50">Sample of generated names</div>
            <button onClick={() => setSample(Array.from({ length: 10 }, randomName))} className="text-[11px] text-neon-400 flex items-center gap-1"><RotateCcw size={12} />Shuffle</button>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-2">{sample.map((n, i) => <span key={i} className="pill bg-white/5 px-2.5 py-1 text-xs">{n}</span>)}</div>
          {saveErr && <div className="mt-3 text-xs text-rose-300">{saveErr}</div>}
          {!cfg.auto && active < 5 && <div className="mt-3 text-xs text-amber-300">Only {active} active custom bots — tables need 5, so generated names will fill the rest.</div>}
        </div>
        <div className="card p-5">
          <div className="text-[11px] text-white/50">Custom bots</div>
          <div className="text-2xl font-semibold mt-1">{cfg.custom.length}</div>
          <div className="text-[11px] text-white/50">{active} active</div>
          <div className="mt-4 text-[11px] text-white/50">Bulk generate</div>
          <div className="flex gap-2 mt-1.5">
            <select value={bulk} onChange={(e) => setBulk(Number(e.target.value))} className="bg-white/5 border border-white/10 rounded-xl px-3 text-sm outline-none">
              {[10, 25, 50, 100].map((n) => <option key={n} value={n} className="bg-[#0d1335]">{n}</option>)}
            </select>
            <button onClick={generate} className="btn-ghost rounded-xl px-3 py-2 text-xs flex-1 flex items-center justify-center gap-1.5"><Sparkles size={14} />Generate {bulk}</button>
          </div>
        </div>
      </div>

      <div className="card flex items-center gap-2 px-4 py-2.5 my-4"><Search size={16} className="text-white/40" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search bots" className="bg-transparent outline-none text-sm flex-1" /></div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[600px]">
          <thead><tr className="text-left text-[11px] text-white/50 border-b border-white/5">{["Bot", "Table balance", "Created", "Status", ""].map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {list.slice(0, 200).map((b) => (
              <tr key={b.id} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-2.5"><div className="flex items-center gap-2.5"><span className="text-xl">{b.emoji}</span><div><div className="font-medium">{b.name}</div><div className="text-[11px] text-white/50">{b.id}</div></div></div></td>
                <td className="px-4 py-2.5 tabular-nums">{coins(b.bal)}</td>
                <td className="px-4 py-2.5 text-white/70">{b.created}</td>
                <td className="px-4 py-2.5"><Pill tone={b.active ? "green" : "gray"}>{b.active ? "Active" : "Disabled"}</Pill></td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  <button onClick={() => toggle(b)} className="btn-ghost rounded-lg px-2.5 py-1.5 text-xs">{b.active ? "Disable" : "Enable"}</button>
                  <button onClick={() => remove(b)} aria-label="Delete" className="btn-ghost rounded-lg px-2 py-1.5 text-xs ml-2 inline-flex items-center"><Trash2 size={13} /></button>
                </td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={5} className="px-4 py-10 text-center text-white/50">{cfg.custom.length ? "No bots match." : cfg.auto ? "No custom bots — tables use auto-generated bots. Add named bots or bulk-generate a roster." : "No custom bots yet."}</td></tr>}
          </tbody>
        </table>
        {list.length > 200 && <div className="px-4 py-2 text-[11px] text-white/40">Showing 200 of {list.length} — search to narrow down.</div>}
      </div>

      {form && (
        <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center p-4" onClick={() => setForm(null)}>
          <form onSubmit={(e) => { e.preventDefault(); add(); }} className="card w-full max-w-md p-6 bg-[#0d1335]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between"><div className="text-lg font-semibold">New Bot</div><button type="button" onClick={() => setForm(null)} className="text-white/50"><X size={18} /></button></div>
            <label className="block text-xs text-white/60 mt-4">Display name
              <div className="flex gap-2 mt-1">
                <input autoFocus value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); setErr(""); }} className={input} />
                <button type="button" onClick={() => setForm({ ...form, name: randomName() })} className="btn-ghost rounded-xl px-3 text-xs whitespace-nowrap">Random</button>
              </div>
            </label>
            <div className="text-xs text-white/60 mt-3">Avatar</div>
            <div className="grid grid-cols-8 gap-1.5 mt-1">
              {BOT_AVATARS.map((e) => <button type="button" key={e} onClick={() => setForm({ ...form, emoji: e })} className={`text-xl rounded-lg py-1 ${form.emoji === e ? "bg-neon-400/25 ring-1 ring-neon-400" : "bg-white/5"}`}>{e}</button>)}
            </div>
            <label className="block text-xs text-white/60 mt-3">Table balance shown (coins) <span className="text-white/40">— blank for random</span>
              <input inputMode="numeric" value={form.bal} onChange={(e) => setForm({ ...form, bal: e.target.value.replace(/\D/g, "") })} className={`${input} mt-1`} />
            </label>
            {err && <div className="text-xs text-rose-300 mt-3">{err}</div>}
            <button type="submit" className="btn-green w-full py-2.5 rounded-xl text-sm mt-5">Create Bot</button>
          </form>
        </div>
      )}
    </>
  );
}

type GameCfg = { enabled: boolean; rake: number; turn: number };
const SERVER_GAMES: { id: GameId; note: string }[] = [
  { id: "teen-patti", note: "Platform fee is taken from each pot" },
  { id: "rummy", note: "Fee on Points winnings and on Pool/Deals prize pools" },
];

function ConfigView() {
  const [cfg, setCfg] = useState<Record<string, GameCfg> | null>(null);
  const [draft, setDraft] = useState<Record<string, GameCfg>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [tables, setTables] = useState<{ tp: number; rm: number } | null>(null);
  const load = async () => {
    const sb = supabase();
    const { data } = await sb.from("app_settings").select("value").eq("key", "games").maybeSingle();
    const v = (data?.value ?? {}) as Record<string, GameCfg>;
    setCfg(v);
    setDraft(v);
    const [{ data: lc }] = await Promise.all([sb.rpc("lobby_counts")]);
    const sum = (o: Record<string, number> | undefined) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
    setTables({ tp: sum(lc?.["teen-patti"]), rm: sum(lc?.rummy) });
  };
  useEffect(() => { load(); }, []);
  const save = async (id: string) => {
    const d = draft[id];
    const { error } = await supabase().rpc("set_game_config", { p_game: id, p_enabled: d.enabled, p_rake: d.rake, p_turn: d.turn });
    setMsg((m) => ({ ...m, [id]: error ? errText(error) : "Saved — applies from the next hand" }));
    if (!error) load();
  };
  const set = (id: string, patch: Partial<GameCfg>) => setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }));

  return (
    <>
      <Title t="Game Config" s="Settings the game server uses for every table" />
      <div className="grid md:grid-cols-2 gap-4">
        {SERVER_GAMES.map(({ id, note }) => {
          const g = GAMES.find((x) => x.id === id)!;
          const d = draft[id];
          const dirty = cfg && d && JSON.stringify(cfg[id]) !== JSON.stringify(d);
          return (
            <div key={id} className="card p-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg grid place-items-center overflow-hidden" style={{ background: `linear-gradient(160deg,${g.from},${g.to})` }}><div className="scale-[.5]"><GameIcon id={g.id} /></div></div>
                <div className="flex-1">
                  <div className="font-medium">{g.name}</div>
                  <div className="text-[11px] text-white/50">{tables ? `${id === "rummy" ? tables.rm : tables.tp} real players at tables now` : "…"}</div>
                </div>
                {d && (
                  <button onClick={() => set(id, { enabled: !d.enabled })} className={`w-11 h-6 rounded-full p-0.5 transition-colors ${d.enabled ? "bg-neon-500" : "bg-white/15"}`} aria-label="Enabled">
                    <div className={`w-5 h-5 rounded-full bg-white transition-transform ${d.enabled ? "translate-x-5" : ""}`} />
                  </button>
                )}
              </div>
              {d ? (
                <>
                  <div className="grid grid-cols-2 gap-3 mt-4">
                    <label className="text-xs text-white/60">Platform fee %<input type="number" min={0} max={25} step={0.5} value={d.rake} onChange={(e) => set(id, { rake: Number(e.target.value) })} className={`${inputCls} mt-1`} /></label>
                    <label className="text-xs text-white/60">Turn time (seconds)<input type="number" min={10} max={90} value={d.turn} onChange={(e) => set(id, { turn: Number(e.target.value) })} className={`${inputCls} mt-1`} /></label>
                  </div>
                  <div className="text-[11px] text-white/40 mt-2">{note}. {d.enabled ? "" : "Disabled: players can't join new tables."}</div>
                  <div className="flex items-center justify-between mt-3">
                    <span className={`text-xs ${msg[id]?.startsWith("Saved") ? "text-neon-400" : "text-rose-300"}`}>{msg[id]}</span>
                    <button disabled={!dirty} onClick={() => save(id)} className="btn-green rounded-xl px-4 py-2 text-sm">Save</button>
                  </div>
                </>
              ) : <div className="text-sm text-white/50 mt-4">Loading…</div>}
            </div>
          );
        })}
      </div>
      <div className="card p-5 mt-4">
        <div className="font-medium">Other games</div>
        <div className="text-xs text-white/50 mt-1">These still run on the player&apos;s device against bots (practice). Server-side payouts are capped at 100× recent stakes until they move to the game server.</div>
        <div className="flex flex-wrap gap-2 mt-3">
          {GAMES.filter((g) => !SERVER_GAMES.some((x) => x.id === g.id)).map((g) => <Pill key={g.id} tone="gray">{g.name}</Pill>)}
        </div>
      </div>
    </>
  );
}

interface AuditRow { id: number; actor_name: string | null; action: string; before: string | null; after: string | null; created_at: string }

function AuditView() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  useEffect(() => {
    supabase().from("audit_log").select("*").order("created_at", { ascending: false }).limit(200).then(({ data }) => setRows((data ?? []) as AuditRow[]));
  }, []);
  return (
    <>
      <Title t="Audit Log" s="Every action with who did it, when, and before/after values" />
      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[600px]">
          <thead><tr className="text-left text-[11px] text-white/50 border-b border-white/5">{["When", "By", "Action", "Before", "After"].map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {(rows ?? []).map((a) => (
              <tr key={a.id} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-3 text-white/60 whitespace-nowrap">{new Date(a.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                <td className="px-4 py-3">{a.actor_name}</td>
                <td className="px-4 py-3">{a.action}</td>
                <td className="px-4 py-3 text-rose-300">{a.before}</td>
                <td className="px-4 py-3 text-neon-400">{a.after}</td>
              </tr>
            ))}
            {rows && rows.length === 0 && <tr><td colSpan={5} className="px-4 py-10 text-center text-white/50">Nothing yet.</td></tr>}
            {!rows && <tr><td colSpan={5} className="px-4 py-10 text-center text-white/50">Loading…</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
