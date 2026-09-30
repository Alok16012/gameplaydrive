"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle, BadgeCheck, Ban, BarChart3, Bot as BotIcon, Briefcase, Check, ChevronRight, ClipboardList, Crown, Download, FileCheck2, Gamepad2, LayoutDashboard, LogOut, Network, RotateCcw, Search, ShieldAlert, Snowflake, Sparkles, Trash2, UserPlus, Users, Wallet as WalletIcon, X,
} from "lucide-react";
import { GAMES, inr, type GameId } from "../lib/data";
import { GameIcon } from "../components/GameArt";
import { BOT_AVATARS, randomBal, randomName, useBotConfig, type BotProfile } from "../lib/botpool";
import { CREATES, ROLE_LABEL, downline, fmtPhone, newId, ownerOptions, today, useAccounts, type Account, type Role } from "../lib/hierarchy";

// Admin & Agency dashboard (PRD §7). Role-based: Super Admin sees everything and creates admins, agents and players;
// Admin creates agents and players; Agent creates players. Each role only sees its own downline. Demo data only; every action here is simulated and written to the
// in-memory audit log so the client can see the "before/after" trail the PRD asks for.

type Section = "dashboard" | "admins" | "agents" | "players" | "bots" | "network" | "kyc" | "withdrawals" | "config" | "risk" | "audit";

const KYC_QUEUE = [
  { id: "K-2291", user: "Arjun Mehta", uid: "GH130877", doc: "PAN + Aadhaar", submitted: "12 min ago", match: 96 },
  { id: "K-2292", user: "Karan Patel", uid: "GH131220", doc: "PAN + Aadhaar", submitted: "34 min ago", match: 88 },
  { id: "K-2293", user: "Ritika Das", uid: "GH131498", doc: "PAN + Bank", submitted: "1 hr ago", match: 72 },
  { id: "K-2294", user: "Imran Khan", uid: "GH131511", doc: "PAN + Aadhaar", submitted: "2 hr ago", match: 99 },
];

const WITHDRAWALS = [
  { id: "W-88120", user: "Sneha Iyer", amount: 25000, to: "ICICI •••• 1182", risk: "Low", when: "5 min ago" },
  { id: "W-88121", user: "Priya Verma", amount: 12000, to: "priya@okaxis", risk: "Low", when: "18 min ago" },
  { id: "W-88122", user: "Vikram Singh", amount: 48000, to: "SBI •••• 0921", risk: "High", when: "40 min ago" },
  { id: "W-88123", user: "Meera Nair", amount: 15500, to: "HDFC •••• 7710", risk: "Medium", when: "1 hr ago" },
];

const RISK = [
  { sev: "High", type: "Collusion", detail: "3 accounts share device ID and always sit together on Teen Patti Table #412", users: "GH129954, GH129955, GH129961" },
  { sev: "High", type: "Chip dumping", detail: "Repeated folds with strong hands against one player (Rummy)", users: "GH128870 → GH128871" },
  { sev: "Medium", type: "Multi-account", detail: "5 accounts registered from same IP in 24 hrs", users: "IP 103.21.x.x" },
  { sev: "Low", type: "Unusual win rate", detail: "91% win rate over 60 Dragon Tiger rounds", users: "GH130402" },
];

const GGR: Record<GameId, number> = { "teen-patti": 412000, rummy: 358000, "dragon-tiger": 296000, "andar-bahar": 214000, poker: 188000, ludo: 142000, "lucky-7": 121000, carrom: 38000, chess: 29000 };

interface Audit { who: string; what: string; before: string; after: string; when: string }

export default function AdminApp() {
  const { accounts, ready, update, reset } = useAccounts();
  const [meId, setMeId] = useState<string | null>(null);
  const [sec, setSec] = useState<Section>("dashboard");
  const [audit, setAudit] = useState<Audit[]>([
    { who: "ops@gamehub", what: "Rake % • Teen Patti", before: "4%", after: "5%", when: "Today 10:12" },
    { who: "finance@gamehub", what: "Withdrawal W-88101 approved", before: "Pending", after: "Approved", when: "Today 09:40" },
    { who: "risk@gamehub", what: "Account GH129954 frozen", before: "Active", after: "Frozen", when: "Yesterday 22:05" },
  ]);
  const me = accounts.find((a) => a.id === meId);
  const log = (what: string, before: string, after: string) =>
    setAudit((a) => [{ who: me?.username ?? "admin", what, before, after, when: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) }, ...a]);

  if (!ready) return <div className="min-h-dvh bg-[#070b22]" />;
  if (!me || me.status !== "Active") return <AdminLogin accounts={accounts} onLogin={(id) => { setMeId(id); setSec("dashboard"); }} />;

  const all: { id: Section; label: string; icon: React.ReactNode; roles: Role[] }[] = [
    { id: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={18} />, roles: ["superadmin", "admin", "agent"] },
    { id: "admins", label: "Admins", icon: <Crown size={18} />, roles: ["superadmin"] },
    { id: "agents", label: "Agents", icon: <Briefcase size={18} />, roles: ["superadmin", "admin"] },
    { id: "players", label: "Players", icon: <Users size={18} />, roles: ["superadmin", "admin", "agent"] },
    { id: "bots", label: "Bots", icon: <BotIcon size={18} />, roles: ["superadmin"] },
    { id: "network", label: "Network", icon: <Network size={18} />, roles: ["superadmin", "admin"] },
    { id: "kyc", label: "KYC Queue", icon: <FileCheck2 size={18} />, roles: ["superadmin"] },
    { id: "withdrawals", label: "Withdrawals", icon: <WalletIcon size={18} />, roles: ["superadmin"] },
    { id: "config", label: "Game Config", icon: <Gamepad2 size={18} />, roles: ["superadmin"] },
    { id: "risk", label: "Risk & Fair Play", icon: <ShieldAlert size={18} />, roles: ["superadmin"] },
    { id: "audit", label: "Audit Log", icon: <ClipboardList size={18} />, roles: ["superadmin", "admin"] },
  ];
  const nav = all.filter((n) => n.roles.includes(me.role));
  const logout = () => setMeId(null);
  const ctx: Ctx = { me, accounts, update, log };

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
          <div className="text-[11px] text-white/50">{ROLE_LABEL[me.role]} • {me.id}</div>
        </div>
        <button onClick={logout} className="flex items-center gap-3 px-3 py-2.5 text-sm text-white/60"><LogOut size={18} />Logout</button>
        {me.role === "superadmin" && (
          <button onClick={() => { if (confirm("Reset all accounts to the demo seed data?")) reset(); }} className="flex items-center gap-3 px-3 py-2 text-xs text-white/40"><RotateCcw size={14} />Reset demo data</button>
        )}
      </aside>

      <main className="flex-1 min-w-0">
        <div className="lg:hidden sticky top-0 z-10 bg-[#0a0f2c]/95 backdrop-blur border-b border-white/5">
          <div className="px-4 pt-4 flex items-center justify-between"><Brand role={me.role} /><button onClick={logout}><LogOut size={18} /></button></div>
          <div className="flex gap-2 overflow-x-auto no-scrollbar px-4 py-3">
            {nav.map((n) => (
              <button key={n.id} onClick={() => setSec(n.id)} className={`pill px-3 py-1.5 text-xs whitespace-nowrap ${sec === n.id ? "btn-green" : "bg-white/5"}`}>{n.label}</button>
            ))}
          </div>
        </div>
        <div className="p-4 lg:p-8 max-w-6xl">
          {sec === "dashboard" && (me.role === "superadmin" ? <><Dashboard go={setSec} /><NetworkStats {...ctx} go={setSec} /></> : <ScopedDashboard {...ctx} go={setSec} />)}
          {sec === "admins" && <AccountsView key="admin" role="admin" {...ctx} />}
          {sec === "agents" && <AccountsView key="agent" role="agent" {...ctx} />}
          {sec === "players" && <AccountsView key="player" role="player" {...ctx} />}
          {sec === "bots" && <BotsView log={log} />}
          {sec === "network" && <NetworkView {...ctx} />}
          {sec === "kyc" && <KycView log={log} />}
          {sec === "withdrawals" && <WithdrawalsView log={log} />}
          {sec === "config" && <ConfigView log={log} />}
          {sec === "risk" && <RiskView log={log} />}
          {sec === "audit" && <AuditView audit={audit} />}
        </div>
      </main>
    </div>
  );
}

interface Ctx { me: Account; accounts: Account[]; update: (fn: (a: Account[]) => Account[]) => void; log: (w: string, b: string, a: string) => void }

function Brand({ role }: { role?: Role }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-9 h-9 rounded-xl grid place-items-center text-lg" style={{ background: "linear-gradient(135deg,#fde68a,#f59e0b)" }}>♠</div>
      <div><div className="font-bold leading-none">Game<span className="gold-text">Hub</span></div><div className="text-[10px] text-white/50">{role ? `${ROLE_LABEL[role]} Console` : "Admin Console"}</div></div>
    </div>
  );
}

function AdminLogin({ accounts, onLogin }: { accounts: Account[]; onLogin: (id: string) => void }) {
  const [user, setUser] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const submit = () => {
    const a = accounts.find((x) => x.role !== "player" && x.username?.toLowerCase() === user.trim().toLowerCase());
    if (!a || a.password !== pw) return setErr("Wrong username or password");
    if (a.status !== "Active") return setErr("This account is frozen. Contact the account that created it.");
    onLogin(a.id);
  };
  const demo: [string, string][] = [["superadmin", "Super Admin"], ["admin", "Admin"], ["agent", "Agent"]];
  return (
    <div className="min-h-dvh grid place-items-center bg-[#070b22] px-4">
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="w-full max-w-sm card p-6">
        <Brand />
        <div className="text-xl font-semibold mt-6">Sign in</div>
        <div className="text-xs text-white/50 mt-1">Super Admin, Admin and Agent accounts • all actions are audited</div>
        <input value={user} onChange={(e) => { setUser(e.target.value); setErr(""); }} placeholder="Username" autoComplete="username" className="w-full mt-5 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm outline-none" />
        <input type="password" value={pw} onChange={(e) => { setPw(e.target.value); setErr(""); }} placeholder="Password" autoComplete="current-password" className="w-full mt-3 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm outline-none" />
        {err && <div className="text-xs text-rose-300 mt-3">{err}</div>}
        <button type="submit" className="btn-green w-full py-3 rounded-xl mt-5">Sign in</button>
        <div className="text-[11px] text-white/40 text-center mt-4">Demo: sign in as (password demo1234)</div>
        <div className="grid grid-cols-3 gap-2 mt-2">
          {demo.map(([u, l]) => (
            <button type="button" key={u} onClick={() => { setUser(u); setPw("demo1234"); setErr(""); }} className="text-[11px] text-white/60 border border-dashed border-white/15 rounded-lg py-2">{l}</button>
          ))}
        </div>
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

function Dashboard({ go }: { go: (s: Section) => void }) {
  const kpis = [
    { l: "Total Deposits (today)", v: "₹18,42,300", d: "+12.4%" },
    { l: "Withdrawals (today)", v: "₹6,15,800", d: "+4.1%" },
    { l: "Active Liability", v: "₹42,90,150", d: "wallet balances" },
    { l: "GGR / Rake (today)", v: "₹1,79,860", d: "+8.9%" },
    { l: "DAU", v: "38,214", d: "MAU 2.1L" },
    { l: "Live tables", v: "1,286", d: "avg fill 7.2s" },
    { l: "Ledger mismatches", v: "0", d: "reconciled 06:00" },
    { l: "Reconnect success", v: "98.7%", d: "target > 98%" },
  ];
  const max = Math.max(...Object.values(GGR));
  const [hover, setHover] = useState<GameId | null>(null);
  return (
    <>
      <Title t="Dashboard" s="Live financial & platform health" right={<button className="btn-ghost rounded-xl px-3 py-2 text-xs flex items-center gap-1.5"><Download size={14} /> Export CSV</button>} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpis.map((k) => (
          <div key={k.l} className="card p-4">
            <div className="text-[11px] text-white/50">{k.l}</div>
            <div className="text-xl lg:text-2xl font-semibold mt-1">{k.v}</div>
            <div className="text-[11px] text-white/50 mt-0.5">{k.d}</div>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mt-4">
        <div className="card p-5 lg:col-span-2">
          <div className="flex items-center gap-2 font-medium"><BarChart3 size={18} className="text-white/60" /> GGR by game • last 7 days</div>
          <div className="mt-6 flex items-end gap-2 h-52 border-b border-white/10 relative">
            {GAMES.map((g) => (
              <div key={g.id} className="flex-1 h-full flex flex-col justify-end items-center relative" onMouseEnter={() => setHover(g.id)} onMouseLeave={() => setHover(null)}>
                {hover === g.id && (
                  <div className="absolute -top-2 z-10 whitespace-nowrap bg-white text-slate-900 text-[11px] rounded-lg px-2 py-1 shadow-lg -translate-y-full">
                    {g.name}: <b>{inr(GGR[g.id])}</b>
                  </div>
                )}
                <div className="w-full max-w-9 rounded-t-[4px] transition-opacity" style={{ height: `${(GGR[g.id] / max) * 100}%`, background: "#4ade80", opacity: hover && hover !== g.id ? 0.45 : 1 }} />
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-2">
            {GAMES.map((g) => <div key={g.id} className="flex-1 text-center text-[10px] text-white/50 truncate">{g.name.split(" ")[0]}</div>)}
          </div>
        </div>
        <div className="card p-5">
          <div className="font-medium">Needs attention</div>
          <div className="mt-4 space-y-2">
            {[
              { l: "KYC reviews pending", n: KYC_QUEUE.length, s: "kyc" as Section },
              { l: "Large withdrawals", n: WITHDRAWALS.length, s: "withdrawals" as Section },
              { l: "Risk flags (high)", n: RISK.filter((r) => r.sev === "High").length, s: "risk" as Section },
            ].map((x) => (
              <button key={x.l} onClick={() => go(x.s)} className="w-full flex items-center justify-between rounded-xl bg-white/5 px-4 py-3 text-sm hover:bg-white/10">
                {x.l}<span className="pill bg-amber-400 text-slate-900 text-xs font-bold px-2 py-0.5">{x.n}</span>
              </button>
            ))}
          </div>
          <div className="mt-5 text-[11px] text-white/40">Daily reconciliation job ran at 06:00 — deposits, withdrawals and game ledgers match to the rupee.</div>
        </div>
      </div>
    </>
  );
}

const STATES = ["Maharashtra", "Karnataka", "Delhi", "Tamil Nadu", "Punjab", "Gujarat", "Kerala", "Uttar Pradesh", "West Bengal", "Rajasthan", "Madhya Pradesh", "Bihar", "Haryana", "Goa"];

/** Accounts visible to `me`: Super Admin sees everything, everyone else only their downline. */
const scopeOf = (accounts: Account[], me: Account) => (me.role === "superadmin" ? accounts.filter((a) => a.id !== me.id) : downline(accounts, me.id));

function NetworkStats({ me, accounts, go, heading = true }: Ctx & { go: (s: Section) => void; heading?: boolean }) {
  const scope = scopeOf(accounts, me);
  const players = scope.filter((a) => a.role === "player");
  const cards: { l: string; v: string; d: string; s?: Section; show: boolean }[] = [
    { l: "Admins", v: String(scope.filter((a) => a.role === "admin").length), d: "created by Super Admin", s: "admins", show: me.role === "superadmin" },
    { l: "Agents", v: String(scope.filter((a) => a.role === "agent").length), d: `${scope.filter((a) => a.role === "agent" && a.status === "Frozen").length} frozen`, s: "agents", show: me.role !== "agent" },
    { l: "Players", v: String(players.length), d: `${players.filter((p) => p.status === "Active").length} active`, s: "players", show: true },
    { l: "Player balances", v: inr(players.reduce((t, p) => t + (p.bal ?? 0), 0)), d: "across your players", show: true },
    { l: "KYC pending", v: String(players.filter((p) => p.kyc === "Pending").length), d: "players to verify", show: me.role === "agent" },
  ];
  return (
    <div className={heading ? "mt-6" : ""}>
      {heading && <div className="font-medium mb-3 flex items-center gap-2"><Network size={18} className="text-white/60" /> Network</div>}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.filter((c) => c.show).map((c) => (
          <button key={c.l} disabled={!c.s} onClick={() => c.s && go(c.s)} className="card p-4 text-left enabled:hover:bg-white/[.07]">
            <div className="text-[11px] text-white/50">{c.l}</div>
            <div className="text-xl lg:text-2xl font-semibold mt-1">{c.v}</div>
            <div className="text-[11px] text-white/50 mt-0.5">{c.d}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function ScopedDashboard(props: Ctx & { go: (s: Section) => void }) {
  const { me, accounts, go } = props;
  const recent = scopeOf(accounts, me).filter((a) => a.role === "player").slice(-5).reverse();
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return (
    <>
      <Title t={`Welcome, ${me.name}`} s={me.role === "admin" ? "Your agents and their players" : "Players you manage"} />
      <NetworkStats {...props} heading={false} />
      <div className="card p-5 mt-4">
        <div className="flex items-center justify-between">
          <div className="font-medium">Latest players</div>
          <button onClick={() => go("players")} className="text-xs text-neon-400">View all</button>
        </div>
        <div className="mt-3 divide-y divide-white/5">
          {recent.map((p) => (
            <div key={p.id} className="flex items-center justify-between py-2.5 text-sm">
              <div><div className="font-medium">{p.name}</div><div className="text-[11px] text-white/50">{p.id} • via {byId.get(p.parentId ?? "")?.name}</div></div>
              <Pill tone={p.status === "Active" ? "green" : "red"}>{p.status}</Pill>
            </div>
          ))}
          {recent.length === 0 && <div className="text-sm text-white/50 py-4">No players yet. Create one from the Players tab.</div>}
        </div>
      </div>
    </>
  );
}

function AccountsView({ role, me, accounts, update, log }: Ctx & { role: Role }) {
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const rows = scopeOf(accounts, me).filter((a) => a.role === role);
  const list = rows.filter((u) => (u.name + u.id + u.phone + (u.username ?? "")).toLowerCase().includes(q.toLowerCase()));
  const canCreate = CREATES[me.role].includes(role);
  const toggle = (u: Account) => {
    const next = u.status === "Frozen" ? "Active" : "Frozen";
    update((all) => all.map((a) => (a.id === u.id ? { ...a, status: next } : a)));
    log(`${ROLE_LABEL[u.role]} ${u.id}`, u.status, next);
  };
  const owner = (u: Account) => {
    const p = byId.get(u.parentId ?? "");
    return p ? <><div>{p.name}</div><div className="text-[11px] text-white/50">{ROLE_LABEL[p.role]}</div></> : "—";
  };
  const plural = { admin: "Admins", agent: "Agents", player: "Players", superadmin: "Super Admins" }[role];
  const sub = {
    admin: "Admins can create agents and players",
    agent: "Agents can create players",
    player: me.role === "agent" ? "Players you created" : "Players across your network",
    superadmin: "",
  }[role];
  const head = role === "player"
    ? ["Player", "Phone", "Created by", "State", "KYC", "Balance", "Games", "Status", ""]
    : ["Name", "Username", "Phone", "Reports to", role === "admin" ? "Agents" : "Players", "Created", "Status", ""];

  return (
    <>
      <Title t={plural} s={`${rows.length} ${plural.toLowerCase()} • ${sub}`} right={canCreate && (
        <button onClick={() => setCreating(true)} className="btn-green rounded-xl px-3.5 py-2 text-sm flex items-center gap-1.5 whitespace-nowrap"><UserPlus size={16} />New {ROLE_LABEL[role]}</button>
      )} />
      <div className="card flex items-center gap-2 px-4 py-2.5 mb-4"><Search size={16} className="text-white/40" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, ID or phone" className="bg-transparent outline-none text-sm flex-1" /></div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[820px]">
          <thead><tr className="text-left text-[11px] text-white/50 border-b border-white/5">{head.map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.id} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-3"><div className="font-medium">{u.name}</div><div className="text-[11px] text-white/50">{u.id}</div></td>
                {role === "player" ? (
                  <>
                    <td className="px-4 py-3 text-white/70 whitespace-nowrap">{fmtPhone(u.phone)}</td>
                    <td className="px-4 py-3 text-white/70">{owner(u)}</td>
                    <td className="px-4 py-3 text-white/70">{u.state}</td>
                    <td className="px-4 py-3"><Pill tone={u.kyc === "Verified" ? "green" : u.kyc === "Pending" ? "amber" : "red"}>{u.kyc}</Pill></td>
                    <td className="px-4 py-3 tabular-nums">{inr(u.bal ?? 0)}</td>
                    <td className="px-4 py-3 tabular-nums">{u.games ?? 0}</td>
                  </>
                ) : (
                  <>
                    <td className="px-4 py-3 text-white/70">{u.username}</td>
                    <td className="px-4 py-3 text-white/70 whitespace-nowrap">{fmtPhone(u.phone)}</td>
                    <td className="px-4 py-3 text-white/70">{owner(u)}</td>
                    <td className="px-4 py-3 tabular-nums">{downline(accounts, u.id).filter((a) => a.role === (role === "admin" ? "agent" : "player")).length}</td>
                    <td className="px-4 py-3 text-white/70 whitespace-nowrap">{u.created}</td>
                  </>
                )}
                <td className="px-4 py-3"><Pill tone={u.status === "Active" ? "green" : "red"}>{u.status}</Pill></td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button onClick={() => toggle(u)} className="btn-ghost rounded-lg px-2.5 py-1.5 text-xs inline-flex items-center gap-1"><Snowflake size={13} />{u.status === "Frozen" ? "Unfreeze" : "Freeze"}</button>
                  {role === "player" && <button onClick={() => log(`Device/IP ban ${u.id}`, "Allowed", "Banned")} className="btn-ghost rounded-lg px-2.5 py-1.5 text-xs inline-flex items-center gap-1 ml-2"><Ban size={13} />Ban</button>}
                </td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={head.length} className="px-4 py-10 text-center text-white/50">No {plural.toLowerCase()} yet{canCreate ? ` — use “New ${ROLE_LABEL[role]}” to add one` : ""}.</td></tr>}
          </tbody>
        </table>
      </div>
      {creating && <CreateModal role={role} me={me} accounts={accounts} update={update} log={log} onClose={() => setCreating(false)} />}
    </>
  );
}

function CreateModal({ role, me, accounts, update, log, onClose }: Ctx & { role: Role; onClose: () => void }) {
  const owners = ownerOptions(accounts, me, role);
  const [f, setF] = useState({ name: "", phone: "", username: "", password: "", state: STATES[0], owner: owners[0]?.id ?? me.id });
  const [err, setErr] = useState("");
  const [done, setDone] = useState<Account | null>(null);
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setErr(""); };
  const staff = role !== "player";

  const submit = () => {
    if (!f.name.trim()) return setErr("Enter a name");
    if (!/^\d{10}$/.test(f.phone)) return setErr("Enter a 10-digit mobile number");
    if (accounts.some((a) => a.phone === f.phone)) return setErr("An account with this mobile number already exists");
    if (staff) {
      if (!/^[a-z0-9._]{3,}$/i.test(f.username)) return setErr("Username: at least 3 letters, numbers, dots or underscores");
      if (accounts.some((a) => a.username?.toLowerCase() === f.username.toLowerCase())) return setErr("Username is taken");
      if (f.password.length < 6) return setErr("Password must be at least 6 characters");
    }
    const acc: Account = {
      id: newId(accounts, role), role, name: f.name.trim(), phone: f.phone, parentId: f.owner, status: "Active", created: today(),
      ...(staff ? { username: f.username.trim(), password: f.password } : { state: f.state, kyc: "Pending", bal: 0, games: 0 }),
    };
    update((all) => [...all, acc]);
    log(`${ROLE_LABEL[role]} ${acc.id} created under ${accounts.find((a) => a.id === f.owner)?.name}`, "—", acc.name);
    setDone(acc);
  };

  const input = "w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-neon-400";
  return (
    <div className="fixed inset-0 z-50 bg-black/60 grid place-items-center p-4" onClick={onClose}>
      <div className="card w-full max-w-md p-6 bg-[#0d1335]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div className="text-lg font-semibold">{done ? `${ROLE_LABEL[role]} created` : `New ${ROLE_LABEL[role]}`}</div>
          <button onClick={onClose} className="text-white/50"><X size={18} /></button>
        </div>
        {done ? (
          <>
            <div className="mt-4 rounded-xl bg-neon-400/10 border border-neon-400/20 p-4 text-sm space-y-1.5">
              <div className="flex justify-between"><span className="text-white/60">ID</span><b>{done.id}</b></div>
              <div className="flex justify-between"><span className="text-white/60">Name</span><span>{done.name}</span></div>
              <div className="flex justify-between"><span className="text-white/60">Mobile</span><span>+91 {fmtPhone(done.phone)}</span></div>
              {staff && <div className="flex justify-between"><span className="text-white/60">Username</span><span>{done.username}</span></div>}
            </div>
            <div className="text-xs text-white/50 mt-3">
              {staff ? `They can sign in to this console with their username and password as ${ROLE_LABEL[role]}.` : "The player can now sign in to the player app with this mobile number and an OTP."}
            </div>
            <button onClick={onClose} className="btn-green w-full py-2.5 rounded-xl mt-5 text-sm">Done</button>
          </>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="mt-4 space-y-3">
            <label className="block text-xs text-white/60">Full name<input autoFocus value={f.name} onChange={(e) => set("name", e.target.value)} className={`${input} mt-1`} /></label>
            <label className="block text-xs text-white/60">Mobile number
              <div className="flex items-center gap-2 mt-1"><span className="text-sm text-white/60">+91</span><input inputMode="numeric" value={f.phone} onChange={(e) => set("phone", e.target.value.replace(/\D/g, "").slice(0, 10))} className={input} /></div>
            </label>
            {staff ? (
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs text-white/60">Username<input value={f.username} onChange={(e) => set("username", e.target.value)} autoComplete="off" className={`${input} mt-1`} /></label>
                <label className="block text-xs text-white/60">Password<input type="password" value={f.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" className={`${input} mt-1`} /></label>
              </div>
            ) : (
              <label className="block text-xs text-white/60">State<select value={f.state} onChange={(e) => set("state", e.target.value)} className={`${input} mt-1`}>{STATES.map((s) => <option key={s} className="bg-[#0d1335]">{s}</option>)}</select></label>
            )}
            {owners.length > 1 && (
              <label className="block text-xs text-white/60">Reports to
                <select value={f.owner} onChange={(e) => set("owner", e.target.value)} className={`${input} mt-1`}>
                  {owners.map((o) => <option key={o.id} value={o.id} className="bg-[#0d1335]">{o.id === me.id ? `Me (${o.name})` : `${o.name} — ${ROLE_LABEL[o.role]}`}</option>)}
                </select>
              </label>
            )}
            {err && <div className="text-xs text-rose-300">{err}</div>}
            <button type="submit" className="btn-green w-full py-2.5 rounded-xl text-sm !mt-5">Create {ROLE_LABEL[role]}</button>
          </form>
        )}
      </div>
    </div>
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
        <span className="text-[11px] text-white/40">{a.id}</span>
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

function BotsView({ log }: { log: (w: string, b: string, a: string) => void }) {
  const { cfg, update } = useBotConfig();
  const [sample, setSample] = useState<string[]>([]);
  const [form, setForm] = useState<{ name: string; emoji: string; bal: string } | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [bulk, setBulk] = useState(10);
  useEffect(() => setSample(Array.from({ length: 10 }, randomName)), []);
  const active = cfg.custom.filter((b) => b.active).length;
  const list = cfg.custom.filter((b) => b.name.toLowerCase().includes(q.toLowerCase()));
  const mk = (name: string, emoji: string, bal: number): BotProfile => ({ id: "BOT-" + Math.random().toString(36).slice(2, 8).toUpperCase(), name, emoji, bal, active: true, created: today() });

  const setAuto = (on: boolean) => {
    update((c) => ({ ...c, auto: on }));
    log("Auto-generate bots", on ? "Off" : "On", on ? "On" : "Off");
  };
  const add = () => {
    if (!form) return;
    const name = form.name.trim();
    if (name.length < 3) return setErr("Name needs at least 3 characters");
    if (cfg.custom.some((b) => b.name.toLowerCase() === name.toLowerCase())) return setErr("A bot with this name already exists");
    update((c) => ({ ...c, custom: [mk(name, form.emoji, Number(form.bal) || randomBal()), ...c.custom] }));
    log(`Bot created • ${name}`, "—", "Active");
    setForm(null);
  };
  const generate = () => {
    const taken = new Set(cfg.custom.map((b) => b.name.toLowerCase()));
    const made: BotProfile[] = [];
    for (let guard = 0; made.length < bulk && guard < bulk * 20; guard++) {
      const name = randomName();
      if (taken.has(name.toLowerCase())) continue;
      taken.add(name.toLowerCase());
      made.push(mk(name, BOT_AVATARS[Math.floor(Math.random() * BOT_AVATARS.length)], randomBal()));
    }
    update((c) => ({ ...c, custom: [...made, ...c.custom] }));
    log(`Generated ${made.length} bots`, String(cfg.custom.length), String(cfg.custom.length + made.length));
  };
  const toggle = (b: BotProfile) => {
    update((c) => ({ ...c, custom: c.custom.map((x) => (x.id === b.id ? { ...x, active: !x.active } : x)) }));
    log(`Bot ${b.name}`, b.active ? "Active" : "Disabled", b.active ? "Disabled" : "Active");
  };
  const remove = (b: BotProfile) => {
    update((c) => ({ ...c, custom: c.custom.filter((x) => x.id !== b.id) }));
    log(`Bot deleted • ${b.name}`, "Active", "Deleted");
  };
  const input = "w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-neon-400";

  return (
    <>
      <Title t="Bots" s="Opponents that fill seats at every table" right={
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
                <td className="px-4 py-2.5 tabular-nums">{inr(b.bal)}</td>
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
            <label className="block text-xs text-white/60 mt-3">Table balance shown (₹) <span className="text-white/40">— blank for random</span>
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

function KycView({ log }: { log: (w: string, b: string, a: string) => void }) {
  const [q, setQ] = useState(KYC_QUEUE);
  const decide = (id: string, ok: boolean) => {
    setQ((x) => x.filter((k) => k.id !== id));
    log(`KYC ${id}`, "Pending", ok ? "Approved" : "Rejected");
  };
  return (
    <>
      <Title t="KYC Review Queue" s="PAN, Aadhaar (age 18+) and bank verification" />
      <div className="grid md:grid-cols-2 gap-3">
        {q.map((k) => (
          <div key={k.id} className="card p-4">
            <div className="flex items-center justify-between"><div className="font-medium">{k.user}</div><span className="text-[11px] text-white/50">{k.submitted}</span></div>
            <div className="text-[11px] text-white/50">{k.uid} • {k.doc}</div>
            <div className="grid grid-cols-2 gap-2 mt-3">
              {["PAN", "Aadhaar"].map((d) => <div key={d} className="h-20 rounded-lg bg-white/5 border border-dashed border-white/15 grid place-items-center text-xs text-white/40">{d} image</div>)}
            </div>
            <div className="flex items-center justify-between mt-3 text-xs"><span className="text-white/60">Name match score</span><Pill tone={k.match > 90 ? "green" : k.match > 80 ? "amber" : "red"}>{k.match}%</Pill></div>
            <div className="grid grid-cols-2 gap-2 mt-3">
              <button onClick={() => decide(k.id, false)} className="btn-ghost rounded-lg py-2 text-xs flex items-center justify-center gap-1"><X size={14} />Reject</button>
              <button onClick={() => decide(k.id, true)} className="btn-green rounded-lg py-2 text-xs flex items-center justify-center gap-1"><Check size={14} />Approve</button>
            </div>
          </div>
        ))}
        {q.length === 0 && <div className="card p-10 text-center text-white/50 md:col-span-2"><BadgeCheck className="mx-auto text-neon-400 mb-2" />Queue is clear</div>}
      </div>
    </>
  );
}

function WithdrawalsView({ log }: { log: (w: string, b: string, a: string) => void }) {
  const [rows, setRows] = useState(WITHDRAWALS.map((w) => ({ ...w, status: "Pending" })));
  const set = (id: string, status: string) => {
    setRows((r) => r.map((w) => (w.id === id ? { ...w, status } : w)));
    log(`Withdrawal ${id}`, "Pending", status);
  };
  return (
    <>
      <Title t="Withdrawal Approvals" s="Withdrawals above ₹10,000 need manual approval" />
      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead><tr className="text-left text-[11px] text-white/50 border-b border-white/5">{["Request", "Player", "Amount", "To", "Risk", "Status", ""].map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.id} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-3"><div>{w.id}</div><div className="text-[11px] text-white/50">{w.when}</div></td>
                <td className="px-4 py-3">{w.user}</td>
                <td className="px-4 py-3 font-semibold tabular-nums">{inr(w.amount)}</td>
                <td className="px-4 py-3 text-white/70">{w.to}</td>
                <td className="px-4 py-3"><Pill tone={w.risk === "Low" ? "green" : w.risk === "Medium" ? "amber" : "red"}>{w.risk}</Pill></td>
                <td className="px-4 py-3"><Pill tone={w.status === "Approved" ? "green" : w.status === "Rejected" ? "red" : "gray"}>{w.status}</Pill></td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {w.status === "Pending" && (
                    <>
                      <button onClick={() => set(w.id, "Rejected")} className="btn-ghost rounded-lg px-2.5 py-1.5 text-xs">Reject</button>
                      <button onClick={() => set(w.id, "Approved")} className="btn-green rounded-lg px-2.5 py-1.5 text-xs ml-2">Approve</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ConfigView({ log }: { log: (w: string, b: string, a: string) => void }) {
  const [cfg, setCfg] = useState(() =>
    Object.fromEntries(GAMES.map((g) => [g.id, { on: true, rake: g.kind === "casino" ? 0 : 5, boot: 10, timer: g.kind === "casino" ? 15 : g.id === "rummy" ? 30 : 20 }])) as Record<GameId, { on: boolean; rake: number; boot: number; timer: number }>,
  );
  const [blocked, setBlocked] = useState(["Andhra Pradesh", "Assam", "Nagaland", "Odisha", "Sikkim", "Telangana"]);
  const upd = (id: GameId, k: "on" | "rake" | "boot" | "timer", v: number | boolean) => {
    const g = GAMES.find((x) => x.id === id)!;
    log(`${k === "on" ? "Module" : k} • ${g.name}`, String(cfg[id][k]), String(v));
    setCfg((c) => ({ ...c, [id]: { ...c[id], [k]: v } }));
  };
  return (
    <>
      <Title t="Game Config" s="Boot amounts, rake %, timers and module switches — changes apply after the current round" />
      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead><tr className="text-left text-[11px] text-white/50 border-b border-white/5">{["Game", "Phase", "Min boot (₹)", "Rake %", "Timer (s)", "Enabled"].map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {GAMES.map((g) => (
              <tr key={g.id} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg grid place-items-center overflow-hidden" style={{ background: `linear-gradient(160deg,${g.from},${g.to})` }}><div className="scale-[.45]"><GameIcon id={g.id} /></div></div>
                    {g.name}
                  </div>
                </td>
                <td className="px-4 py-2.5"><Pill tone="gray">Phase {g.phase}</Pill></td>
                {(["boot", "rake", "timer"] as const).map((k) => (
                  <td key={k} className="px-4 py-2.5">
                    <input type="number" defaultValue={cfg[g.id][k]} onBlur={(e) => Number(e.target.value) !== cfg[g.id][k] && upd(g.id, k, Number(e.target.value))} className="w-20 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 outline-none" />
                  </td>
                ))}
                <td className="px-4 py-2.5">
                  <button onClick={() => upd(g.id, "on", !cfg[g.id].on)} className={`w-11 h-6 rounded-full p-0.5 transition-colors ${cfg[g.id].on ? "bg-neon-500" : "bg-white/15"}`}>
                    <div className={`w-5 h-5 rounded-full bg-white transition-transform ${cfg[g.id].on ? "translate-x-5" : ""}`} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card p-5 mt-4">
        <div className="font-medium">Geo-blocked states</div>
        <div className="text-xs text-white/50 mt-0.5">Players from these states can't sign in to real-money modes (configurable per legal advice).</div>
        <div className="flex flex-wrap gap-2 mt-3">
          {blocked.map((s) => (
            <span key={s} className="pill bg-rose-500/15 text-rose-200 text-xs pl-3 pr-1.5 py-1 flex items-center gap-1">{s}
              <button onClick={() => { setBlocked((b) => b.filter((x) => x !== s)); log(`Geo-block ${s}`, "Blocked", "Allowed"); }}><X size={13} /></button>
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

function RiskView({ log }: { log: (w: string, b: string, a: string) => void }) {
  const [rows, setRows] = useState(RISK.map((r) => ({ ...r, state: "Open" })));
  return (
    <>
      <Title t="Risk & Fair Play" s="Collusion, multi-account clusters and unusual win-rate flags" />
      <div className="space-y-3">
        {rows.map((r, i) => (
          <div key={i} className="card p-4 flex flex-col md:flex-row md:items-center gap-3">
            <AlertTriangle className={r.sev === "High" ? "text-rose-400" : r.sev === "Medium" ? "text-amber-300" : "text-white/50"} />
            <div className="flex-1">
              <div className="flex items-center gap-2"><span className="font-medium">{r.type}</span><Pill tone={r.sev === "High" ? "red" : r.sev === "Medium" ? "amber" : "gray"}>{r.sev}</Pill>{r.state !== "Open" && <Pill tone="green">{r.state}</Pill>}</div>
              <div className="text-sm text-white/70 mt-0.5">{r.detail}</div>
              <div className="text-[11px] text-white/40 mt-0.5">{r.users}</div>
            </div>
            {r.state === "Open" && (
              <div className="flex gap-2">
                <button onClick={() => { setRows((x) => x.map((y, j) => (j === i ? { ...y, state: "Dismissed" } : y))); log(`Risk flag • ${r.type}`, "Open", "Dismissed"); }} className="btn-ghost rounded-lg px-3 py-1.5 text-xs">Dismiss</button>
                <button onClick={() => { setRows((x) => x.map((y, j) => (j === i ? { ...y, state: "Accounts frozen" } : y))); log(`Risk flag • ${r.type}`, "Open", "Accounts frozen"); }} className="rounded-lg px-3 py-1.5 text-xs bg-rose-500 font-medium">Freeze accounts</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function AuditView({ audit }: { audit: Audit[] }) {
  return (
    <>
      <Title t="Audit Log" s="Every admin action with user, time and before/after values" />
      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[600px]">
          <thead><tr className="text-left text-[11px] text-white/50 border-b border-white/5">{["When", "Admin", "Action", "Before", "After"].map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {audit.map((a, i) => (
              <tr key={i} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-3 text-white/60 whitespace-nowrap">{a.when}</td>
                <td className="px-4 py-3">{a.who}</td>
                <td className="px-4 py-3">{a.what}</td>
                <td className="px-4 py-3 text-rose-300">{a.before}</td>
                <td className="px-4 py-3 text-neon-400">{a.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
