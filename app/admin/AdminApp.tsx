"use client";

import { useState } from "react";
import {
  AlertTriangle, BadgeCheck, Ban, BarChart3, Check, ClipboardList, Download, FileCheck2, Gamepad2, LayoutDashboard, LogOut, Search, ShieldAlert, Snowflake, Users, Wallet as WalletIcon, X,
} from "lucide-react";
import { GAMES, inr, type GameId } from "../lib/data";
import { GameIcon } from "../components/GameArt";

// Admin & Agency dashboard (PRD §7). Demo data only; every action here is simulated and written to the
// in-memory audit log so the client can see the "before/after" trail the PRD asks for.

type Section = "dashboard" | "users" | "kyc" | "withdrawals" | "config" | "risk" | "audit";

const USERS = [
  { id: "GH123456", name: "Rahul Sharma", phone: "98765 43210", kyc: "Verified", bal: 2450, games: 142, state: "Maharashtra", status: "Active" },
  { id: "GH118203", name: "Priya Verma", phone: "91234 56780", kyc: "Verified", bal: 8120, games: 388, state: "Karnataka", status: "Active" },
  { id: "GH130877", name: "Arjun Mehta", phone: "99887 66554", kyc: "Pending", bal: 540, games: 12, state: "Delhi", status: "Active" },
  { id: "GH127611", name: "Sneha Iyer", phone: "90011 22334", kyc: "Verified", bal: 15600, games: 911, state: "Tamil Nadu", status: "Active" },
  { id: "GH129954", name: "Vikram Singh", phone: "98111 00992", kyc: "Rejected", bal: 90, games: 47, state: "Punjab", status: "Frozen" },
  { id: "GH131220", name: "Karan Patel", phone: "97222 33441", kyc: "Pending", bal: 1200, games: 5, state: "Gujarat", status: "Active" },
  { id: "GH125008", name: "Meera Nair", phone: "96333 44552", kyc: "Verified", bal: 3310, games: 204, state: "Kerala", status: "Active" },
];

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
  const [authed, setAuthed] = useState(false);
  const [sec, setSec] = useState<Section>("dashboard");
  const [audit, setAudit] = useState<Audit[]>([
    { who: "ops@gamehub", what: "Rake % • Teen Patti", before: "4%", after: "5%", when: "Today 10:12" },
    { who: "finance@gamehub", what: "Withdrawal W-88101 approved", before: "Pending", after: "Approved", when: "Today 09:40" },
    { who: "risk@gamehub", what: "Account GH129954 frozen", before: "Active", after: "Frozen", when: "Yesterday 22:05" },
  ]);
  const log = (what: string, before: string, after: string) =>
    setAudit((a) => [{ who: "admin@gamehub", what, before, after, when: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) }, ...a]);

  if (!authed) return <AdminLogin onLogin={() => setAuthed(true)} />;

  const nav: { id: Section; label: string; icon: React.ReactNode }[] = [
    { id: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
    { id: "users", label: "Users", icon: <Users size={18} /> },
    { id: "kyc", label: "KYC Queue", icon: <FileCheck2 size={18} /> },
    { id: "withdrawals", label: "Withdrawals", icon: <WalletIcon size={18} /> },
    { id: "config", label: "Game Config", icon: <Gamepad2 size={18} /> },
    { id: "risk", label: "Risk & Fair Play", icon: <ShieldAlert size={18} /> },
    { id: "audit", label: "Audit Log", icon: <ClipboardList size={18} /> },
  ];

  return (
    <div className="min-h-dvh bg-[#070b22] text-white flex">
      <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-white/5 bg-[#0a0f2c] p-4 sticky top-0 h-dvh">
        <Brand />
        <nav className="mt-8 space-y-1 flex-1">
          {nav.map((n) => (
            <button key={n.id} onClick={() => setSec(n.id)} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm ${sec === n.id ? "bg-neon-400/15 text-neon-400 font-medium" : "text-white/70 hover:bg-white/5"}`}>
              {n.icon}{n.label}
            </button>
          ))}
        </nav>
        <button onClick={() => setAuthed(false)} className="flex items-center gap-3 px-3 py-2.5 text-sm text-white/60"><LogOut size={18} />Logout</button>
      </aside>

      <main className="flex-1 min-w-0">
        <div className="lg:hidden sticky top-0 z-10 bg-[#0a0f2c]/95 backdrop-blur border-b border-white/5">
          <div className="px-4 pt-4 flex items-center justify-between"><Brand /><button onClick={() => setAuthed(false)}><LogOut size={18} /></button></div>
          <div className="flex gap-2 overflow-x-auto no-scrollbar px-4 py-3">
            {nav.map((n) => (
              <button key={n.id} onClick={() => setSec(n.id)} className={`pill px-3 py-1.5 text-xs whitespace-nowrap ${sec === n.id ? "btn-green" : "bg-white/5"}`}>{n.label}</button>
            ))}
          </div>
        </div>
        <div className="p-4 lg:p-8 max-w-6xl">
          {sec === "dashboard" && <Dashboard go={setSec} />}
          {sec === "users" && <UsersView log={log} />}
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

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <div className="w-9 h-9 rounded-xl grid place-items-center text-lg" style={{ background: "linear-gradient(135deg,#fde68a,#f59e0b)" }}>♠</div>
      <div><div className="font-bold leading-none">Game<span className="gold-text">Hub</span></div><div className="text-[10px] text-white/50">Admin Console</div></div>
    </div>
  );
}

function AdminLogin({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="min-h-dvh grid place-items-center bg-[#070b22] px-4">
      <div className="w-full max-w-sm card p-6">
        <Brand />
        <div className="text-xl font-semibold mt-6">Sign in</div>
        <div className="text-xs text-white/50 mt-1">Role-based access • all actions are audited</div>
        <input defaultValue="admin@gamehub.demo" className="w-full mt-5 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm outline-none" />
        <input type="password" defaultValue="demo1234" className="w-full mt-3 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm outline-none" />
        <button onClick={onLogin} className="btn-green w-full py-3 rounded-xl mt-5">Sign in</button>
        <div className="text-[11px] text-white/40 text-center mt-3">Demo: any password works</div>
      </div>
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

function UsersView({ log }: { log: (w: string, b: string, a: string) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState(USERS);
  const list = rows.filter((u) => (u.name + u.id + u.phone).toLowerCase().includes(q.toLowerCase()));
  const toggle = (id: string) => {
    setRows((r) => r.map((u) => (u.id === id ? { ...u, status: u.status === "Frozen" ? "Active" : "Frozen" } : u)));
    const u = rows.find((x) => x.id === id)!;
    log(`Account ${id}`, u.status, u.status === "Frozen" ? "Active" : "Frozen");
  };
  return (
    <>
      <Title t="Users" s={`${rows.length} players shown (demo)`} />
      <div className="card flex items-center gap-2 px-4 py-2.5 mb-4"><Search size={16} className="text-white/40" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, ID or phone" className="bg-transparent outline-none text-sm flex-1" /></div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead><tr className="text-left text-[11px] text-white/50 border-b border-white/5">{["User", "Phone", "State", "KYC", "Balance", "Games", "Status", ""].map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.id} className="border-b border-white/5 last:border-0">
                <td className="px-4 py-3"><div className="font-medium">{u.name}</div><div className="text-[11px] text-white/50">{u.id}</div></td>
                <td className="px-4 py-3 text-white/70">{u.phone}</td>
                <td className="px-4 py-3 text-white/70">{u.state}</td>
                <td className="px-4 py-3"><Pill tone={u.kyc === "Verified" ? "green" : u.kyc === "Pending" ? "amber" : "red"}>{u.kyc}</Pill></td>
                <td className="px-4 py-3 tabular-nums">{inr(u.bal)}</td>
                <td className="px-4 py-3 tabular-nums">{u.games}</td>
                <td className="px-4 py-3"><Pill tone={u.status === "Active" ? "green" : "red"}>{u.status}</Pill></td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button onClick={() => toggle(u.id)} className="btn-ghost rounded-lg px-2.5 py-1.5 text-xs inline-flex items-center gap-1"><Snowflake size={13} />{u.status === "Frozen" ? "Unfreeze" : "Freeze"}</button>
                  <button onClick={() => log(`Device/IP ban ${u.id}`, "Allowed", "Banned")} className="btn-ghost rounded-lg px-2.5 py-1.5 text-xs inline-flex items-center gap-1 ml-2"><Ban size={13} />Ban</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
