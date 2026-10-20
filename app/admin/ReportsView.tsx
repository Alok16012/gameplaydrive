"use client";

import { useState, useEffect, useMemo } from "react";
import {
  FileText,
  DollarSign,
  TrendingUp,
  Activity,
  Lock,
  Gamepad2,
  Trophy,
  BarChart2,
  ShieldAlert,
  Users,
  Search,
  Download,
  Calendar,
  RotateCcw,
  CheckCircle2,
  XCircle,
  Eye,
  Filter,
  ArrowUpRight,
  ArrowDownLeft,
  Coins,
  ChevronDown,
  Layers,
  Printer,
  User,
  Copy,
  Check,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Hash,
  ArrowRight,
  ShieldCheck,
  Clock,
  Sparkles,
  ExternalLink,
} from "lucide-react";
import { type Account, type Role, ROLE_LABEL, coins, fmtPhone } from "../lib/hierarchy";
import { supabase, errText } from "../lib/supabase";
import { GAMES } from "../lib/data";
import { RoundLookup } from "./RoundLookup";
import type { SportBetRow } from "../lib/cricketApi";

export type ReportSubTab =
  | "account_statement"
  | "party_win_loss"
  | "current_bets"
  | "user_history"
  | "general_lock"
  | "our_casino_result"
  | "live_casino_result"
  | "sportbook_report"
  | "turnover"
  | "user_auth"
  | "user_register"
  | "total_profit_loss"
  | "user_win_loss";

export const REPORT_TABS_LIST: { id: ReportSubTab; label: string; icon: React.ReactNode }[] = [
  { id: "account_statement", label: "Account Statement", icon: <FileText size={15} /> },
  { id: "party_win_loss", label: "Party Win Loss", icon: <TrendingUp size={15} /> },
  { id: "current_bets", label: "Current Bets", icon: <Activity size={15} /> },
  { id: "user_history", label: "User History", icon: <Layers size={15} /> },
  { id: "general_lock", label: "General Lock", icon: <Lock size={15} /> },
  { id: "our_casino_result", label: "Our Casino Result", icon: <Gamepad2 size={15} /> },
  { id: "live_casino_result", label: "Live Casino Result", icon: <Trophy size={15} /> },
  { id: "sportbook_report", label: "Sportbook Report", icon: <BarChart2 size={15} /> },
  { id: "turnover", label: "Turn Over", icon: <DollarSign size={15} /> },
  { id: "user_auth", label: "User Authentication", icon: <ShieldAlert size={15} /> },
  { id: "user_register", label: "User Register Detail", icon: <Users size={15} /> },
  { id: "total_profit_loss", label: "Total Profit Loss", icon: <BarChart2 size={15} /> },
  { id: "user_win_loss", label: "User Win Loss", icon: <TrendingUp size={15} /> },
];

interface LedgerRow {
  id: number;
  user_id: string;
  amount: number;
  balance_after: number;
  kind: "mint" | "burn" | "transfer_in" | "transfer_out" | "bet" | "win" | "refund";
  note: string | null;
  created_at: string;
}

interface AuditRow {
  id: number;
  actor_name: string | null;
  action: string;
  before: string | null;
  after: string | null;
  created_at: string;
}

type DateRange = "all" | "today" | "yesterday" | "7days" | "30days" | "custom";

/** [start, end) of a date filter in the viewer's local time; undefined = open-ended. */
function rangeBounds(r: DateRange, customStart: string, customEnd: string): { start?: Date; end?: Date } {
  const day = (offset: number) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    return d;
  };
  if (r === "today") return { start: day(0) };
  if (r === "yesterday") return { start: day(-1), end: day(0) };
  if (r === "7days") return { start: day(-6) };
  if (r === "30days") return { start: day(-29) };
  if (r === "custom") {
    const end = customEnd ? new Date(customEnd + "T00:00:00") : undefined;
    end?.setDate(end.getDate() + 1);
    return { start: customStart ? new Date(customStart + "T00:00:00") : undefined, end };
  }
  return {};
}

const inRange = (iso: string | undefined, b: { start?: Date; end?: Date }) => {
  if (!iso) return !b.start && !b.end;
  const t = new Date(iso).getTime();
  return (!b.start || t >= b.start.getTime()) && (!b.end || t < b.end.getTime());
};

// PostgREST returns at most 1000 rows per request, so read in pages until the table runs out (or the cap).
const PAGE = 1000;
const ROW_CAP = 60000;
async function fetchAllPages<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<{ rows: T[]; capped: boolean }> {
  const rows: T[] = [];
  for (let from = 0; from < ROW_CAP; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw error;
    const batch = (data as T[]) ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) return { rows, capped: false };
  }
  return { rows, capped: true };
}

// Game of a ledger row. Game bets carry the game's name as the note ("Teen Patti", "Ludo • …"); cricket bets
// start with "CRICKET: …".
const GAMES_BY_NAME_LEN = [...GAMES].sort((a, b) => b.name.length - a.name.length);
function gameOf(note: string | null): { key: string; name: string; category: string } {
  const n = (note ?? "").trim();
  if (/^[A-Z]+:/.test(n)) {
    const sport = n.split(":")[0];
    return { key: sport.toLowerCase(), name: sport === "CRICKET" ? "Cricket" : sport[0] + sport.slice(1).toLowerCase(), category: "sports" };
  }
  const head = n.split("•")[0].trim().toLowerCase();
  const g =
    GAMES.find((x) => x.name.toLowerCase() === head || x.id === head.replace(/\s+/g, "-")) ??
    GAMES_BY_NAME_LEN.find((x) => n.toLowerCase().includes(x.name.toLowerCase()));
  if (g) return { key: g.id, name: g.name, category: g.category };
  return { key: head || "other", name: n.split("•")[0].trim() || "Other", category: "other" };
}

interface ReportsViewProps {
  me: Account;
  accounts: Account[];
  reload: () => Promise<void>;
  initialTab?: ReportSubTab;
  onOpenDetails?: (u: Account) => void;
}

export function ReportsView({
  me,
  accounts,
  reload,
  initialTab = "account_statement",
  onOpenDetails,
}: ReportsViewProps) {
  const [activeTab, setActiveTab] = useState<ReportSubTab>(initialTab);
  const [dateRange, setDateRange] = useState<DateRange>("all");
  const [customStart, setCustomStart] = useState<string>("");
  const [customEnd, setCustomEnd] = useState<string>("");
  const [reloadKey, setReloadKey] = useState<number>(0);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [selectedUser, setSelectedUser] = useState<string>("all");
  const [searchQ, setSearchQ] = useState<string>("");
  const [txType, setTxType] = useState<string>("all");
  const [loading, setLoading] = useState<boolean>(true);
  const [ledgerData, setLedgerData] = useState<LedgerRow[]>([]);
  const [auditData, setAuditData] = useState<AuditRow[]>([]);
  // Sum of ledger amounts after the period ends, per user — rewinds today's balances to the period's close.
  const [afterEnd, setAfterEnd] = useState<Map<string, number>>(new Map());
  const [capped, setCapped] = useState(false);
  const [err, setErr] = useState<string>("");
  const [viewRow, setViewRow] = useState<LedgerRow | null>(null);
  const [openBets, setOpenBets] = useState<SportBetRow[]>([]);

  // Pagination for ledger
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(50);

  const copyToClipboard = (text: string, key: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    }
  };

  const bounds = useMemo(() => rangeBounds(dateRange, customStart, customEnd), [dateRange, customStart, customEnd]);

  // Open sports bets (from every match, any date) for the Current Bets report.
  useEffect(() => {
    if (activeTab !== "current_bets") return;
    supabase()
      .from("sport_bets")
      .select("*")
      .eq("status", "OPEN")
      .order("created_at", { ascending: false })
      .limit(500)
      .then(({ data, error }) => {
        if (error) setErr(errText(error));
        else setOpenBets((data as SportBetRow[]).filter((b) => selectedUser === "all" || b.user_id === selectedUser));
      });
  }, [activeTab, selectedUser]);

  // Sportbook report: every cricket bet, summed per match. Platform P/L counts settled bets only
  // (coins taken at placement minus coins paid back on settlement).
  const [bookBets, setBookBets] = useState<SportBetRow[]>([]);
  useEffect(() => {
    if (activeTab !== "sportbook_report") return;
    supabase()
      .from("sport_bets")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(5000)
      .then(({ data, error }) => {
        if (error) setErr(errText(error));
        else setBookBets(data as SportBetRow[]);
      });
  }, [activeTab]);
  const bookRows = useMemo(() => {
    const m = new Map<string, { match: string; vol: number; bets: number; net: number; open: number }>();
    for (const b of bookBets) {
      if (!inRange(b.created_at, bounds)) continue;
      const r = m.get(b.event_id) ?? { match: b.event_name, vol: 0, bets: 0, net: 0, open: 0 };
      r.vol += Number(b.stake);
      r.bets += 1;
      if (b.status === "OPEN") r.open += 1;
      else r.net += Number(b.exposure) - Number(b.payout);
      m.set(b.event_id, r);
    }
    return [...m.values()];
  }, [bookBets, bounds]);

  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  // Sync tab if initialTab changes from sidebar
  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);

  // Load every ledger row of the period (paged past the 1000-row API limit) plus the audit trail.
  useEffect(() => {
    let active = true;
    async function loadReports() {
      setLoading(true);
      setErr("");
      try {
        const sb = supabase();
        const { start, end } = bounds;
        const ledgerPage = (from: number, to: number) => {
          let q = sb.from("ledger").select("*");
          if (selectedUser !== "all") q = q.eq("user_id", selectedUser);
          if (start) q = q.gte("created_at", start.toISOString());
          if (end) q = q.lt("created_at", end.toISOString());
          return q.order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to);
        };
        const afterPage = (from: number, to: number) => {
          let q = sb.from("ledger").select("id,user_id,amount").gte("created_at", end!.toISOString());
          if (selectedUser !== "all") q = q.eq("user_id", selectedUser);
          return q.order("id", { ascending: true }).range(from, to);
        };
        const auditPage = (from: number, to: number) => {
          let q = sb.from("audit_log").select("*");
          if (start) q = q.gte("created_at", start.toISOString());
          if (end) q = q.lt("created_at", end.toISOString());
          return q.order("id", { ascending: false }).range(from, to);
        };

        const [led, after, audRes] = await Promise.all([
          fetchAllPages<LedgerRow>(ledgerPage),
          end ? fetchAllPages<{ user_id: string; amount: number }>(afterPage) : Promise.resolve({ rows: [], capped: false }),
          fetchAllPages<AuditRow>(auditPage),
        ]);
        if (!active) return;
        setLedgerData(led.rows);
        setCapped(led.capped);
        const m = new Map<string, number>();
        for (const r of after.rows) m.set(r.user_id, (m.get(r.user_id) ?? 0) + Number(r.amount));
        setAfterEnd(m);
        setAuditData(audRes.rows);
      } catch (e) {
        if (active) setErr(errText(e));
      } finally {
        if (active) setLoading(false);
      }
    }
    loadReports();
    return () => {
      active = false;
    };
  }, [bounds, selectedUser, reloadKey]);

  // Indian currency formatting
  const fmt = (n?: number, forceDec = true) => {
    if (n === undefined || n === null || isNaN(Number(n))) return "0.00";
    return Number(n).toLocaleString("en-IN", {
      minimumFractionDigits: forceDec ? 2 : 0,
      maximumFractionDigits: 2,
    });
  };

  const fmtDate = (dStr: string) => {
    const d = new Date(dStr);
    if (isNaN(d.getTime())) return dStr;
    const pad = (n: number) => String(n).padStart(2, "0");
    const hours = d.getHours();
    const ampm = hours >= 12 ? "PM" : "AM";
    const h12 = hours % 12 || 12;
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(h12)}:${pad(
      d.getMinutes()
    )}:${pad(d.getSeconds())} ${ampm}`;
  };

  // Helper to parse transaction notes across Sports, Aviator, Casino, Transfers, etc.
  const parseTxnNarration = (r: LedgerRow) => {
    const note = r.note || "";
    // Cricket / Sports: "CRICKET: <event> • <runner> [BACK @ 1.95 | Stake: 100]"
    const sportMatch = note.match(/^([A-Z]+):\s*(.+?)\s*•\s*(.+?)\s*\[(\w+)\s*@\s*([\d.]+)\s*\|\s*Stake:\s*([\d.]+)\]\s*$/);
    if (sportMatch) {
      return {
        category: "Sports Bet",
        sport: sportMatch[1],
        title: sportMatch[2],
        selection: sportMatch[3],
        badge: `${sportMatch[4].toUpperCase()} @ ${sportMatch[5]}`,
        stake: Number(sportMatch[6]),
        odds: sportMatch[5],
        noteText: `${sportMatch[1]}: ${sportMatch[2]} • ${sportMatch[3]}`,
      };
    }

    // Aviator
    if (note.toLowerCase().includes("aviator")) {
      const co = note.match(/cash\s*out\s*@\s*([\d.]+x?)/i);
      return {
        category: "Aviator Crash",
        sport: "Aviator",
        title: "Aviator Crash Game",
        selection: co ? `Cashout @ ${co[1]}` : (r.kind === "bet" ? "Bet Staked" : "Game Win"),
        badge: co ? co[1] : (r.kind === "bet" ? "STAKE" : "WIN"),
        stake: Math.abs(r.amount),
        odds: co ? co[1] : "—",
        noteText: note,
      };
    }

    // Casino games: Dragon Tiger, Andar Bahar, Lucky 7, Teen Patti, Roulette, Blackjack, Ludo, Plinko
    const casinoList = ["Dragon Tiger", "Andar Bahar", "Lucky 7", "Teen Patti", "Roulette", "Blackjack", "Ludo", "Plinko", "Mines"];
    for (const c of casinoList) {
      if (note.toLowerCase().includes(c.toLowerCase())) {
        return {
          category: "Live Casino",
          sport: c,
          title: c,
          selection: r.kind === "bet" ? "Bet Placed" : r.kind === "win" ? "Win Payout" : "Game Round",
          badge: r.kind === "win" ? "WON" : r.kind === "bet" ? "BET" : "REFUND",
          stake: Math.abs(r.amount),
          odds: "—",
          noteText: note,
        };
      }
    }

    // Transfers
    if (r.kind === "transfer_in" || r.kind === "transfer_out") {
      return {
        category: "Transfer",
        sport: "Wallet",
        title: r.kind === "transfer_in" ? "Deposit / Transfer In" : "Withdrawal / Transfer Out",
        selection: note || (r.kind === "transfer_in" ? "Credited by Agent/Admin" : "Debited from Wallet"),
        badge: r.kind === "transfer_in" ? "DEPOSIT" : "WITHDRAWAL",
        stake: Math.abs(r.amount),
        odds: "—",
        noteText: note || (r.kind === "transfer_in" ? "Wallet Deposit" : "Wallet Withdrawal"),
      };
    }

    // Mints / Burns
    if (r.kind === "mint" || r.kind === "burn") {
      return {
        category: "Admin Mint/Burn",
        sport: "Admin",
        title: r.kind === "mint" ? "Admin Coins Mint" : "Admin Coins Burn",
        selection: note || "Admin wallet action",
        badge: r.kind === "mint" ? "MINT" : "BURN",
        stake: Math.abs(r.amount),
        odds: "—",
        noteText: note || "Admin balance adjustment",
      };
    }

    return {
      category: r.kind.toUpperCase(),
      sport: "Other",
      title: note || r.kind.replace("_", " ").toUpperCase(),
      selection: note || "—",
      badge: r.kind.toUpperCase(),
      stake: Math.abs(r.amount),
      odds: "—",
      noteText: note || "—",
    };
  };

  // Filtered Ledger Rows with search & type
  const filteredLedger = useMemo(() => {
    return ledgerData.filter((row) => {
      if (selectedUser !== "all" && row.user_id !== selectedUser) return false;
      if (txType !== "all") {
        if (txType === "deposit" && !["transfer_in", "mint"].includes(row.kind)) return false;
        if (txType === "withdraw" && !["transfer_out", "burn"].includes(row.kind)) return false;
        if (txType === "bet" && row.kind !== "bet") return false;
        if (txType === "win" && row.kind !== "win") return false;
        if (txType === "refund" && row.kind !== "refund") return false;
      }
      if (searchQ.trim()) {
        const u = byId.get(row.user_id);
        const text = `${u?.name || ""} ${u?.code || ""} ${u?.username || ""} ${u?.phone || ""} ${row.note || ""} ${row.kind} #${row.id}`.toLowerCase();
        if (!text.includes(searchQ.toLowerCase())) return false;
      }
      return true;
    });
  }, [ledgerData, selectedUser, txType, searchQ, byId]);

  // Account Settlement & Financial Reconciliation — over the whole period (search / type filters only narrow the
  // table). Balances are rewound from today's wallets: closing = now − everything after the period,
  // opening = closing − everything inside it. Only accounts in the visible list count, so the two always tie.
  const settlement = useMemo(() => {
    let deposits = 0;
    let withdrawals = 0;
    let bets = 0;
    let wins = 0;
    let refunds = 0;
    let periodNet = 0;

    const inScope = (uid: string) => (selectedUser === "all" ? byId.has(uid) : uid === selectedUser);
    ledgerData.forEach((r) => {
      if (!inScope(r.user_id)) return;
      const amt = Math.abs(Number(r.amount));
      periodNet += Number(r.amount);
      if (["transfer_in", "mint"].includes(r.kind)) deposits += amt;
      else if (["transfer_out", "burn"].includes(r.kind)) withdrawals += amt;
      else if (r.kind === "bet") bets += amt;
      else if (r.kind === "win") wins += amt;
      else if (r.kind === "refund") refunds += amt;
    });

    const winsAndRefunds = wins + refunds;
    const playerNetPL = winsAndRefunds - bets; // +ve: Player in profit, -ve: Player in loss
    const houseNetPL = bets - winsAndRefunds; // +ve: Platform/Agent in profit, -ve: Loss

    const scope = selectedUser === "all" ? accounts : accounts.filter((a) => a.id === selectedUser);
    let closing = 0;
    for (const a of scope) closing += a.coins - (afterEnd.get(a.id) ?? 0);
    const opening = closing - periodNet;

    // Reconciled math: Opening + Deposits - Withdrawals + Gaming Net
    const reconciled = opening + deposits - withdrawals + playerNetPL;

    return {
      opening,
      closing,
      deposits,
      withdrawals,
      bets,
      wins,
      refunds,
      winsAndRefunds,
      playerNetPL,
      houseNetPL,
      reconciled,
      txCount: ledgerData.length,
    };
  }, [ledgerData, afterEnd, accounts, selectedUser, byId]);

  // Gaming activity per account (bets / wins+refunds) in the period, and per game.
  const perUser = useMemo(() => {
    const m = new Map<string, { bets: number; returns: number; count: number }>();
    for (const r of ledgerData) {
      if (r.kind !== "bet" && r.kind !== "win" && r.kind !== "refund") continue;
      const v = m.get(r.user_id) ?? { bets: 0, returns: 0, count: 0 };
      if (r.kind === "bet") { v.bets += Math.abs(Number(r.amount)); v.count += 1; }
      else v.returns += Math.abs(Number(r.amount));
      m.set(r.user_id, v);
    }
    return m;
  }, [ledgerData]);

  const perGame = useMemo(() => {
    const m = new Map<string, { name: string; category: string; bets: number; returns: number; count: number; players: Set<string> }>();
    for (const r of ledgerData) {
      if (r.kind !== "bet" && r.kind !== "win" && r.kind !== "refund") continue;
      const g = gameOf(r.note);
      const v = m.get(g.key) ?? { name: g.name, category: g.category, bets: 0, returns: 0, count: 0, players: new Set<string>() };
      if (r.kind === "bet") { v.bets += Math.abs(Number(r.amount)); v.count += 1; v.players.add(r.user_id); }
      else v.returns += Math.abs(Number(r.amount));
      m.set(g.key, v);
    }
    return [...m.values()].sort((a, b) => b.bets - a.bets);
  }, [ledgerData]);

  // Party win/loss: each admin / agent rolls up its whole downline; a player is just itself.
  const partyRows = useMemo(() => {
    const kids = new Map<string, Account[]>();
    for (const a of accounts) if (a.parentId) kids.set(a.parentId, [...(kids.get(a.parentId) ?? []), a]);
    const roll = (a: Account): { bets: number; returns: number; count: number } => {
      const own = perUser.get(a.id) ?? { bets: 0, returns: 0, count: 0 };
      const t = { ...own };
      for (const k of kids.get(a.id) ?? []) {
        const c = roll(k);
        t.bets += c.bets; t.returns += c.returns; t.count += c.count;
      }
      return t;
    };
    return accounts
      .filter((a) => a.role !== "superadmin" && (selectedUser === "all" || a.id === selectedUser))
      .map((a) => ({ a, ...roll(a) }))
      .sort((x, y) => y.bets - x.bets || x.a.name.localeCompare(y.a.name));
  }, [accounts, perUser, selectedUser]);

  // Paginated ledger rows
  const paginatedLedger = useMemo(() => {
    if (pageSize >= 999999) return filteredLedger;
    const start = (page - 1) * pageSize;
    return filteredLedger.slice(start, start + pageSize);
  }, [filteredLedger, page, pageSize]);

  const totalPages = Math.max(1, Math.ceil(filteredLedger.length / (pageSize >= 999999 ? filteredLedger.length || 1 : pageSize)));

  // Selected player account object
  const selectedAccount = selectedUser !== "all" ? byId.get(selectedUser) : null;

  // Export to CSV function
  const exportToCSV = (filename: string, rows: Record<string, unknown>[]) => {
    if (!rows.length) return;
    const headers = Object.keys(rows[0]).join(",");
    const csvContent = [
      headers,
      ...rows.map((r) =>
        Object.values(r)
          .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
          .join(",")
      ),
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `${filename}_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
  };

  return (
    <div className="space-y-6">
      {/* Top Header & Breadcrumb */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-white/5">
        <div>
          <div className="text-xs text-sky-400 font-medium tracking-wide uppercase">
            Reports & Statement Hub
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2 mt-0.5">
            <FileText size={24} className="text-sky-400" />
            {REPORT_TABS_LIST.find((t) => t.id === activeTab)?.label || "Account Statement"}
          </h1>
        </div>

        {/* Date Filter & Control Bar */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <div className="flex items-center gap-1.5 bg-[#0d1435] p-1.5 rounded-2xl border border-white/10 shrink-0 overflow-x-auto max-w-full">
            {[
              { id: "all", label: "All Time" },
              { id: "today", label: "Today" },
              { id: "yesterday", label: "Yesterday" },
              { id: "7days", label: "7 Days" },
              { id: "30days", label: "30 Days" },
              { id: "custom", label: "Custom" },
            ].map((d) => (
              <button
                key={d.id}
                onClick={() => {
                  setDateRange(d.id as any);
                  setPage(1);
                }}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition ${
                  dateRange === d.id
                    ? "bg-sky-500/20 text-sky-300 font-bold border border-sky-400/40 shadow-sm shadow-sky-500/10"
                    : "text-white/60 hover:text-white hover:bg-white/5"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>

          {/* Custom Date Pickers */}
          {dateRange === "custom" && (
            <div className="flex items-center gap-2 bg-[#0d1435] p-1.5 rounded-2xl border border-white/10 text-xs">
              <Calendar size={13} className="text-sky-400 shrink-0 ml-1" />
              <input
                type="date"
                value={customStart}
                onChange={(e) => {
                  setCustomStart(e.target.value);
                  setPage(1);
                }}
                className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-white outline-none text-xs"
                placeholder="Start Date"
              />
              <span className="text-white/40">to</span>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => {
                  setCustomEnd(e.target.value);
                  setPage(1);
                }}
                className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-white outline-none text-xs"
                placeholder="End Date"
              />
            </div>
          )}

          {/* Live Refresh Button */}
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            disabled={loading}
            title="Refresh Data"
            className="p-2 rounded-2xl bg-[#0d1435] hover:bg-white/10 text-white/70 hover:text-white border border-white/10 transition flex items-center justify-center shrink-0 shadow-sm"
          >
            <RefreshCw size={15} className={loading ? "animate-spin text-sky-400" : "text-white/70"} />
          </button>
        </div>
      </div>

      {/* Submenu Tabs Bar (Horizontal scrolling) */}
      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
        {REPORT_TABS_LIST.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap flex items-center gap-2 border transition ${
                isActive
                  ? "bg-sky-500/20 border-sky-400/50 text-sky-300 shadow-sm shadow-sky-500/10"
                  : "bg-white/5 border-white/5 text-white/60 hover:text-white hover:bg-white/10"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Main Report Container */}
      <div className="card p-5 bg-[#0b102e] border border-white/10 rounded-2xl space-y-5">
        {/* ============================================================== */}
        {/* 1. ACCOUNT STATEMENT */}
        {/* ============================================================== */}
        {activeTab === "account_statement" && (
          <div className="space-y-5">
            {/* 1. PLAYER PROFILE & IDENTITY CARD (When an account is selected) */}
            {selectedAccount ? (
              <div className="relative overflow-hidden rounded-2xl border border-sky-500/20 bg-gradient-to-br from-sky-950/40 via-[#0b1338] to-[#070b24] p-5 shadow-xl">
                <div className="absolute -right-20 -top-20 w-64 h-64 bg-sky-500/10 rounded-full blur-3xl pointer-events-none" />

                <div className="relative z-10 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
                  {/* Left: Player Profile & Identity */}
                  <div className="flex items-start sm:items-center gap-4 min-w-0">
                    <div className="relative shrink-0">
                      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-sky-500/20 to-blue-600/30 border border-sky-400/30 flex items-center justify-center text-sky-300 font-bold text-2xl shadow-inner">
                        {selectedAccount.name?.charAt(0).toUpperCase() || "P"}
                      </div>
                      <div
                        className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-[#0b1338] ${
                          selectedAccount.status === "Active" ? "bg-emerald-500 animate-pulse" : "bg-rose-500"
                        }`}
                        title={`Status: ${selectedAccount.status}`}
                      />
                    </div>

                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl font-bold text-white tracking-tight truncate">
                          {selectedAccount.name}
                        </h2>
                        <span className="px-2 py-0.5 rounded-lg text-[10px] font-bold tracking-wide uppercase bg-sky-500/20 text-sky-300 border border-sky-500/30">
                          {ROLE_LABEL[selectedAccount.role]}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-lg text-[10px] font-semibold uppercase ${
                            selectedAccount.status === "Active"
                              ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                              : "bg-rose-500/15 text-rose-300 border border-rose-500/30"
                          }`}
                        >
                          {selectedAccount.status}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/60">
                        <span className="flex items-center gap-1 font-mono text-sky-300 font-semibold">
                          <Hash size={12} className="text-sky-400" />
                          {selectedAccount.code}
                          <button
                            type="button"
                            onClick={() => copyToClipboard(selectedAccount.code, "code")}
                            className="text-white/40 hover:text-white transition ml-0.5"
                            title="Copy Code"
                          >
                            {copiedKey === "code" ? (
                              <Check size={12} className="text-emerald-400" />
                            ) : (
                              <Copy size={12} />
                            )}
                          </button>
                        </span>

                        {selectedAccount.username && (
                          <span className="flex items-center gap-1">
                            <span className="text-white/40">Username:</span>
                            <span className="text-white/90 font-mono font-medium">@{selectedAccount.username}</span>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(selectedAccount.username!, "user")}
                              className="text-white/40 hover:text-white transition ml-0.5"
                              title="Copy Username"
                            >
                              {copiedKey === "user" ? (
                                <Check size={12} className="text-emerald-400" />
                              ) : (
                                <Copy size={12} />
                              )}
                            </button>
                          </span>
                        )}

                        {selectedAccount.phone && (
                          <span className="flex items-center gap-1">
                            <span className="text-white/40">Mobile:</span>
                            <span className="text-white/90 font-mono">{fmtPhone(selectedAccount.phone)}</span>
                          </span>
                        )}

                        <span className="flex items-center gap-1">
                          <span className="text-white/40">State:</span>
                          <span className="text-white/80">{selectedAccount.state || "Maharashtra"}</span>
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-white/40 pt-0.5">
                        <span>
                          Created By:{" "}
                          <span className="text-white/70 font-medium">
                            {selectedAccount.parentId
                              ? byId.get(selectedAccount.parentId)?.name
                                ? `${byId.get(selectedAccount.parentId)!.name} (${byId.get(selectedAccount.parentId)!.code})`
                                : "Upline Agent"
                              : "Direct Super Admin"}
                          </span>
                        </span>
                        <span>•</span>
                        <span>
                          Registered:{" "}
                          <span className="text-white/70">
                            {selectedAccount.createdAt ? fmtDate(selectedAccount.createdAt) : selectedAccount.created}
                          </span>
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Right: Live Balance & Quick Action Buttons */}
                  <div className="flex flex-wrap sm:flex-nowrap items-center gap-4 shrink-0 w-full lg:w-auto justify-between lg:justify-end border-t lg:border-t-0 pt-4 lg:pt-0 border-white/10">
                    <div className="bg-gradient-to-br from-amber-500/10 via-amber-500/5 to-transparent border border-amber-500/30 rounded-2xl p-3.5 px-5 shadow-lg">
                      <div className="text-[10px] text-amber-300/70 uppercase tracking-wider font-semibold flex items-center gap-1.5">
                        <Coins size={12} className="text-amber-400" /> Current Live Wallet Balance
                      </div>
                      <div className="text-2xl font-black text-amber-300 font-mono tabular-nums tracking-tight mt-0.5">
                        🪙 {fmt(selectedAccount.coins)}
                      </div>
                      <div className="text-[10px] text-white/40 mt-0.5">Verified from public.wallets</div>
                    </div>

                    <div className="flex sm:flex-col gap-2 shrink-0">
                      {onOpenDetails && (
                        <button
                          type="button"
                          onClick={() => onOpenDetails(selectedAccount)}
                          className="px-3 py-2 rounded-xl text-xs font-semibold bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 border border-sky-500/40 transition flex items-center gap-1.5 shadow-sm"
                        >
                          <User size={13} /> View Full Profile
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedUser("all");
                          setPage(1);
                        }}
                        className="px-3 py-2 rounded-xl text-xs font-medium bg-white/5 hover:bg-white/10 text-white/70 hover:text-white border border-white/10 transition flex items-center gap-1.5"
                      >
                        <RotateCcw size={13} /> Show All Accounts
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              /* All Accounts Overview Banner */
              <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400">
                    <Users size={20} />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white">All Accounts Statement Overview</h3>
                    <p className="text-xs text-white/50">
                      Viewing consolidated platform transactions. Select any specific player from the dropdown below to view their dedicated account settlement.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs font-mono text-white/60 shrink-0">
                  <span className="px-3 py-1.5 rounded-xl bg-white/5 border border-white/10">
                    Accounts: <b className="text-white">{accounts.length}</b>
                  </span>
                  <span className="px-3 py-1.5 rounded-xl bg-white/5 border border-white/10">
                    Players: <b className="text-sky-300">{accounts.filter((a) => a.role === "player").length}</b>
                  </span>
                </div>
              </div>
            )}

            {/* 2. ACCOUNT SETTLEMENT & RECONCILIATION HUB */}
            <div className="space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <DollarSign size={16} className="text-emerald-400" />
                    Account Settlement & Financial Reconciliation
                  </h3>
                  <p className="text-[11px] text-white/50">
                    100% mathematically reconciled from every single ledger transaction in the selected period.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                    <ShieldCheck size={12} />
                    Double-Entry Verified
                  </span>
                  <span className="text-[11px] text-white/40 font-mono">
                    {settlement.txCount} Records Analyzed
                  </span>
                  {capped && <span className="text-[11px] text-amber-300">First {settlement.txCount.toLocaleString("en-IN")} only — pick a shorter period</span>}
                </div>
              </div>

              {/* 6 Settlement Metric Cards */}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                {/* 1. Opening Balance */}
                <div className="card p-3.5 bg-white/5 border border-white/5 rounded-xl">
                  <div className="text-[10px] text-white/50 uppercase tracking-wider font-semibold">Opening Balance</div>
                  <div className="text-lg font-bold text-white/90 mt-1 tabular-nums font-mono">
                    🪙 {fmt(settlement.opening)}
                  </div>
                  <div className="text-[10px] text-white/40 mt-0.5">Start of period</div>
                </div>

                {/* 2. Total Inward / Deposits */}
                <div className="card p-3.5 bg-emerald-500/5 border border-emerald-500/20 rounded-xl">
                  <div className="text-[10px] text-emerald-400/80 uppercase tracking-wider font-semibold">Total Deposits (+)</div>
                  <div className="text-lg font-bold text-emerald-400 mt-1 tabular-nums font-mono">
                    +{fmt(settlement.deposits)}
                  </div>
                  <div className="text-[10px] text-emerald-400/60 mt-0.5">Transfers In & Mints</div>
                </div>

                {/* 3. Total Outward / Withdrawals */}
                <div className="card p-3.5 bg-rose-500/5 border border-rose-500/20 rounded-xl">
                  <div className="text-[10px] text-rose-400/80 uppercase tracking-wider font-semibold">Total Withdrawals (-)</div>
                  <div className="text-lg font-bold text-rose-400 mt-1 tabular-nums font-mono">
                    -{fmt(settlement.withdrawals)}
                  </div>
                  <div className="text-[10px] text-rose-400/60 mt-0.5">Transfers Out & Burns</div>
                </div>

                {/* 4. Total Bets / Turnover */}
                <div className="card p-3.5 bg-amber-500/5 border border-amber-500/20 rounded-xl">
                  <div className="text-[10px] text-amber-300/80 uppercase tracking-wider font-semibold">Turnover / Bets Staked</div>
                  <div className="text-lg font-bold text-amber-300 mt-1 tabular-nums font-mono">
                    🪙 {fmt(settlement.bets)}
                  </div>
                  <div className="text-[10px] text-amber-300/60 mt-0.5">Total gaming stakes</div>
                </div>

                {/* 5. Total Wins & Refunds */}
                <div className="card p-3.5 bg-sky-500/5 border border-sky-500/20 rounded-xl">
                  <div className="text-[10px] text-sky-300/80 uppercase tracking-wider font-semibold">Wins & Refunds (+)</div>
                  <div className="text-lg font-bold text-sky-300 mt-1 tabular-nums font-mono">
                    +{fmt(settlement.winsAndRefunds)}
                  </div>
                  <div className="text-[10px] text-sky-300/60 mt-0.5">Payouts returned</div>
                </div>

                {/* 6. Net Gaming P/L */}
                <div
                  className={`card p-3.5 rounded-xl border ${
                    settlement.playerNetPL >= 0
                      ? "bg-emerald-500/10 border-emerald-500/30"
                      : "bg-rose-500/10 border-rose-500/30"
                  }`}
                >
                  <div className="text-[10px] uppercase tracking-wider font-semibold text-white/70">
                    Player Net P/L
                  </div>
                  <div
                    className={`text-lg font-bold mt-1 tabular-nums font-mono ${
                      settlement.playerNetPL >= 0 ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    {settlement.playerNetPL >= 0 ? "+" : ""}
                    {fmt(settlement.playerNetPL)}
                  </div>
                  <div className="text-[10px] text-white/50 mt-0.5">
                    House: {settlement.houseNetPL >= 0 ? "+" : ""}
                    {fmt(settlement.houseNetPL)}
                  </div>
                </div>
              </div>

              {/* Settlement Reconciliation Audit Formula Bar */}
              <div className="bg-[#0e173e] border border-white/10 rounded-xl p-3 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-xs">
                <div className="flex flex-wrap items-center gap-2 font-mono">
                  <span className="text-white/60">Formula:</span>
                  <span className="px-2 py-0.5 rounded bg-white/5 text-white/80">
                    Opening ({fmt(settlement.opening)})
                  </span>
                  <span className="text-emerald-400 font-bold">+</span>
                  <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300">
                    Inward ({fmt(settlement.deposits)})
                  </span>
                  <span className="text-rose-400 font-bold">-</span>
                  <span className="px-2 py-0.5 rounded bg-rose-500/10 text-rose-300">
                    Outward ({fmt(settlement.withdrawals)})
                  </span>
                  <span className="text-sky-400 font-bold">+</span>
                  <span
                    className={`px-2 py-0.5 rounded ${
                      settlement.playerNetPL >= 0
                        ? "bg-emerald-500/10 text-emerald-300"
                        : "bg-rose-500/10 text-rose-300"
                    }`}
                  >
                    Gaming Net ({settlement.playerNetPL >= 0 ? "+" : ""}
                    {fmt(settlement.playerNetPL)})
                  </span>
                  <span className="text-amber-400 font-bold">=</span>
                  <span className="px-2.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30">
                    Reconciled Closing: 🪙 {fmt(settlement.reconciled)}
                  </span>
                </div>

                <div className="shrink-0 flex items-center gap-2">
                  {selectedAccount && (
                    <span className="text-[11px] text-emerald-400 flex items-center gap-1 font-medium bg-emerald-500/10 px-2.5 py-1 rounded-lg border border-emerald-500/20">
                      <CheckCircle2 size={13} />
                      {dateRange === "all" ? "100% Matches Live Balance" : "Period Settlement Verified"}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* 3. FILTERS & TOOLS ROW */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <div className="flex flex-wrap items-center gap-2.5">
                {/* Search Input */}
                <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs min-w-[220px]">
                  <Search size={14} className="text-white/40" />
                  <input
                    value={searchQ}
                    onChange={(e) => {
                      setSearchQ(e.target.value);
                      setPage(1);
                    }}
                    placeholder="Search note, game, ID, runner..."
                    className="bg-transparent outline-none text-white w-full"
                  />
                </div>

                {/* Account Selector (Grouped by Players and Agents) */}
                <select
                  value={selectedUser}
                  onChange={(e) => {
                    setSelectedUser(e.target.value);
                    setPage(1);
                  }}
                  className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-sky-400/50"
                >
                  <option value="all" className="bg-[#0b102e]">
                    All Accounts ({accounts.length} total)
                  </option>
                  <optgroup label="Players" className="bg-[#0b102e] text-sky-400 font-semibold">
                    {accounts
                      .filter((a) => a.role === "player")
                      .map((a) => (
                        <option key={a.id} value={a.id} className="bg-[#0b102e] text-white">
                          {a.name} ({a.code}) {a.username ? `• @${a.username}` : ""} — 🪙 {fmt(a.coins)}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label="Agents / Admins" className="bg-[#0b102e] text-purple-400 font-semibold">
                    {accounts
                      .filter((a) => a.role !== "player")
                      .map((a) => (
                        <option key={a.id} value={a.id} className="bg-[#0b102e] text-white">
                          {a.name} ({a.code} • {ROLE_LABEL[a.role]}) — 🪙 {fmt(a.coins)}
                        </option>
                      ))}
                  </optgroup>
                </select>

                {/* Transaction Type Filter */}
                <select
                  value={txType}
                  onChange={(e) => {
                    setTxType(e.target.value);
                    setPage(1);
                  }}
                  className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-sky-400/50"
                >
                  <option value="all" className="bg-[#0b102e]">
                    All Transaction Types
                  </option>
                  <option value="bet" className="bg-[#0b102e]">
                    Game Bets Staked
                  </option>
                  <option value="win" className="bg-[#0b102e]">
                    Game Wins Paid
                  </option>
                  <option value="refund" className="bg-[#0b102e]">
                    Bet Refunds
                  </option>
                  <option value="deposit" className="bg-[#0b102e]">
                    Deposits / Transfers In
                  </option>
                  <option value="withdraw" className="bg-[#0b102e]">
                    Withdrawals / Transfers Out
                  </option>
                </select>

                {/* Page Size Selector */}
                <div className="flex items-center gap-1.5 text-xs text-white/50">
                  <span>Show:</span>
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setPage(1);
                    }}
                    className="bg-white/5 border border-white/10 rounded-xl px-2 py-1.5 text-xs text-white outline-none"
                  >
                    <option value={25} className="bg-[#0b102e]">25</option>
                    <option value={50} className="bg-[#0b102e]">50</option>
                    <option value={100} className="bg-[#0b102e]">100</option>
                    <option value={250} className="bg-[#0b102e]">250</option>
                    <option value={999999} className="bg-[#0b102e]">All ({filteredLedger.length})</option>
                  </select>
                </div>
              </div>

              {/* Export Buttons */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    exportToCSV(
                      selectedAccount
                        ? `account_statement_${selectedAccount.code}_${dateRange}`
                        : `account_statement_${dateRange}`,
                      filteredLedger.map((r) => {
                        const u = byId.get(r.user_id);
                        const p = parseTxnNarration(r);
                        return {
                          "Txn ID": `#${r.id}`,
                          Date: fmtDate(r.created_at),
                          "User Name": u?.name || r.user_id,
                          "User Code": u?.code || "—",
                          Username: u?.username || "—",
                          Role: u?.role || "—",
                          Type: r.kind,
                          Category: p.category,
                          "Debit (-)": r.amount < 0 ? Math.abs(r.amount) : 0,
                          "Credit (+)": r.amount > 0 ? r.amount : 0,
                          "Balance After": r.balance_after,
                          Narration: r.note || "—",
                        };
                      })
                    )
                  }
                  className="btn-ghost px-3 py-2 rounded-xl text-xs flex items-center gap-1.5 border border-white/10"
                  title="Export Statement to CSV"
                >
                  <Download size={14} /> Export CSV ({filteredLedger.length})
                </button>
              </div>
            </div>

            {/* 4. DETAILED TRANSACTIONS TABLE */}
            <div className="overflow-x-auto rounded-xl border border-white/10 bg-white/[0.01]">
              <table className="w-full text-sm text-left">
                <thead className="bg-white/5 text-[11px] text-white/50 uppercase border-b border-white/10">
                  <tr>
                    <th className="px-4 py-3 whitespace-nowrap">Txn ID</th>
                    <th className="px-4 py-3 whitespace-nowrap">Date & Time</th>
                    <th className="px-4 py-3 whitespace-nowrap">Account / User</th>
                    <th className="px-4 py-3 whitespace-nowrap">Type</th>
                    <th className="px-4 py-3">Event / Game Narration</th>
                    <th className="px-4 py-3 text-right whitespace-nowrap">Debit (-)</th>
                    <th className="px-4 py-3 text-right whitespace-nowrap">Credit (+)</th>
                    <th className="px-4 py-3 text-right whitespace-nowrap">Balance After</th>
                    <th className="px-4 py-3 text-center whitespace-nowrap">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-xs">
                  {paginatedLedger.map((r) => {
                    const u = byId.get(r.user_id);
                    const isCredit = r.amount > 0;
                    const isDebit = r.amount < 0;
                    const parsed = parseTxnNarration(r);

                    return (
                      <tr key={r.id} className="hover:bg-white/[0.03] transition">
                        {/* Txn ID */}
                        <td className="px-4 py-3 font-mono text-[11px] text-sky-400/90 whitespace-nowrap">
                          #{r.id}
                        </td>

                        {/* Date & Time */}
                        <td className="px-4 py-3 text-white/70 whitespace-nowrap font-mono text-[11px]">
                          {fmtDate(r.created_at)}
                        </td>

                        {/* User Account */}
                        <td className="px-4 py-3 whitespace-nowrap">
                          {u ? (
                            <div
                              className="cursor-pointer group"
                              onClick={() => onOpenDetails && onOpenDetails(u)}
                            >
                              <div className="font-semibold text-white group-hover:text-sky-300 transition">
                                {u.name}
                              </div>
                              <div className="text-[10px] text-white/40 font-mono">
                                {u.code} {u.username ? `• @${u.username}` : ""}
                              </div>
                            </div>
                          ) : (
                            <span className="font-mono text-white/50">{r.user_id.slice(0, 8)}</span>
                          )}
                        </td>

                        {/* Type Badge */}
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span
                            className={`px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase tracking-wider ${
                              r.kind === "bet"
                                ? "bg-amber-500/15 text-amber-300 border border-amber-500/25"
                                : r.kind === "win"
                                ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/25"
                                : r.kind === "refund"
                                ? "bg-purple-500/15 text-purple-300 border border-purple-500/25"
                                : r.kind === "transfer_in" || r.kind === "mint"
                                ? "bg-sky-500/15 text-sky-300 border border-sky-500/25"
                                : "bg-rose-500/15 text-rose-300 border border-rose-500/25"
                            }`}
                          >
                            {r.kind.replace("_", " ")}
                          </span>
                        </td>

                        {/* Narration & Parsed Details */}
                        <td className="px-4 py-3 min-w-[240px] max-w-[380px]">
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-[10px] font-semibold text-white/90 bg-white/5 px-1.5 py-0.5 rounded border border-white/5">
                                {parsed.category}
                              </span>
                              {parsed.badge && parsed.badge !== parsed.category && (
                                <span className="text-[10px] font-mono text-sky-300 bg-sky-500/10 px-1.5 py-0.5 rounded border border-sky-500/20">
                                  {parsed.badge}
                                </span>
                              )}
                            </div>
                            <div className="text-white/80 text-[11px] font-medium line-clamp-2 break-words">
                              {r.note || "—"}
                            </div>
                          </div>
                        </td>

                        {/* Debit */}
                        <td className="px-4 py-3 text-right font-mono font-bold text-rose-400 whitespace-nowrap">
                          {isDebit ? `- 🪙 ${fmt(Math.abs(r.amount))}` : "—"}
                        </td>

                        {/* Credit */}
                        <td className="px-4 py-3 text-right font-mono font-bold text-emerald-400 whitespace-nowrap">
                          {isCredit ? `+ 🪙 ${fmt(r.amount)}` : "—"}
                        </td>

                        {/* Balance After */}
                        <td className="px-4 py-3 text-right font-mono font-bold text-amber-300 whitespace-nowrap">
                          🪙 {fmt(r.balance_after)}
                        </td>

                        {/* Inspect Action */}
                        <td className="px-4 py-3 text-center whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => setViewRow(r)}
                            className="p-1.5 rounded-lg bg-white/5 hover:bg-sky-500/20 text-white/60 hover:text-sky-300 transition"
                            title="Inspect full transaction"
                          >
                            <Eye size={15} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}

                  {filteredLedger.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-4 py-16 text-center text-white/40 text-sm">
                        {loading ? (
                          <div className="flex items-center justify-center gap-2 text-sky-400">
                            <RefreshCw size={16} className="animate-spin" />
                            Loading ledger transactions directly from database…
                          </div>
                        ) : (
                          <div className="space-y-1">
                            <div className="font-semibold text-white/60">No transactions found</div>
                            <div className="text-xs text-white/40">
                              {selectedAccount
                                ? `No ledger records found for ${selectedAccount.name} (${selectedAccount.code}) in this period.`
                                : "Try adjusting your filters or date range above."}
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

              {/* Table Footer with Totals & Pagination */}
              {filteredLedger.length > 0 && (
                <div className="bg-white/5 border-t border-white/10 px-4 py-3 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs">
                  {/* Totals Summary */}
                  <div className="flex flex-wrap items-center gap-4 text-[11px] font-mono">
                    <span className="text-white/50">
                      Total Records: <b className="text-white">{filteredLedger.length}</b>
                    </span>
                    <span>•</span>
                    <span className="text-rose-400">
                      Total Debits: <b>- 🪙 {fmt(settlement.withdrawals + settlement.bets)}</b>
                    </span>
                    <span>•</span>
                    <span className="text-emerald-400">
                      Total Credits: <b>+ 🪙 {fmt(settlement.deposits + settlement.winsAndRefunds)}</b>
                    </span>
                  </div>

                  {/* Pagination Navigation */}
                  {pageSize < 999999 && totalPages > 1 && (
                    <div className="flex items-center gap-2">
                      <span className="text-white/50 text-[11px]">
                        Page {page} of {totalPages}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setPage((p) => Math.max(1, p - 1))}
                          disabled={page === 1}
                          className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/70 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition"
                          title="Previous page"
                        >
                          <ChevronLeft size={14} />
                        </button>

                        {/* Page Numbers */}
                        {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                          let pNum = i + 1;
                          if (totalPages > 5) {
                            if (page > 3) pNum = Math.min(totalPages - 4 + i, page - 2 + i);
                          }
                          return (
                            <button
                              key={pNum}
                              type="button"
                              onClick={() => setPage(pNum)}
                              className={`w-7 h-7 rounded-lg text-xs font-mono font-medium transition ${
                                page === pNum
                                  ? "bg-sky-500/20 text-sky-300 font-bold border border-sky-500/40"
                                  : "bg-white/5 text-white/60 hover:text-white hover:bg-white/10"
                              }`}
                            >
                              {pNum}
                            </button>
                          );
                        })}

                        <button
                          type="button"
                          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                          disabled={page === totalPages}
                          className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/70 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition"
                          title="Next page"
                        >
                          <ChevronRight size={14} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* 2. PARTY WIN LOSS */}
        {/* ============================================================== */}
        {activeTab === "party_win_loss" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-white">Party-Wise Win / Loss Report</h3>
                <p className="text-xs text-white/50">
                  Bets and payouts in the selected period. Admins and agents include their whole downline.
                </p>
              </div>
              <button
                onClick={() =>
                  exportToCSV(
                    `party_win_loss_${dateRange}`,
                    partyRows.map((r) => ({
                      Name: r.a.name,
                      Code: r.a.code,
                      Role: ROLE_LABEL[r.a.role],
                      Balance: r.a.coins,
                      Turnover: r.bets,
                      Bets: r.count,
                      PlayerPL: r.returns - r.bets,
                      HousePL: r.bets - r.returns,
                    }))
                  )
                }
                className="btn-ghost px-3 py-1.5 rounded-xl text-xs flex items-center gap-1.5"
              >
                <Download size={13} /> Export
              </button>
            </div>

            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full text-sm text-left">
                <thead className="bg-white/5 text-[11px] text-white/50 uppercase border-b border-white/10">
                  <tr>
                    <th className="px-4 py-3">Party Name</th>
                    <th className="px-4 py-3">Role</th>
                    <th className="px-4 py-3 text-right">Balance Pts</th>
                    <th className="px-4 py-3 text-right">Turnover</th>
                    <th className="px-4 py-3 text-right">Bets</th>
                    <th className="px-4 py-3 text-right">Player Win / Loss</th>
                    <th className="px-4 py-3 text-right">House Net</th>
                    <th className="px-4 py-3 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-xs">
                  {partyRows.map(({ a: u, bets, returns, count }) => {
                    const pl = returns - bets;
                    const house = bets - returns;
                    return (
                      <tr key={u.id} className={`hover:bg-white/[0.02] transition ${count ? "" : "opacity-50"}`}>
                        <td className="px-4 py-3 font-semibold text-white">
                          <div>{u.name}</div>
                          <div className="text-[10px] text-white/40">{u.username || u.code}</div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 rounded text-[10px] bg-white/10 text-white/80">
                            {ROLE_LABEL[u.role]}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-gold-300">🪙 {fmt(u.coins)}</td>
                        <td className="px-4 py-3 text-right font-mono text-amber-300">🪙 {fmt(bets)}</td>
                        <td className="px-4 py-3 text-right font-mono text-white/70">{count}</td>
                        <td className={`px-4 py-3 text-right font-mono font-bold ${pl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{pl >= 0 ? "+" : ""}{fmt(pl)}</td>
                        <td className={`px-4 py-3 text-right font-mono font-bold ${house >= 0 ? "text-sky-400" : "text-rose-400"}`}>{house >= 0 ? "+" : ""}{fmt(house)}</td>
                        <td className="px-4 py-3 text-center">
                          <button
                            onClick={() => onOpenDetails && onOpenDetails(u)}
                            className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-sky-500/20 text-sky-300 hover:bg-sky-500/30 transition"
                          >
                            Details
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {partyRows.length === 0 && <tr><td colSpan={8} className="px-4 py-10 text-center text-white/40">No accounts.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* 3. CURRENT BETS */}
        {/* ============================================================== */}
        {activeTab === "current_bets" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                  Live Current In-Play Bets
                </h3>
                <p className="text-xs text-white/50">
                  Open cricket bets from every match, waiting for a declared result
                </p>
              </div>
              <div className="text-xs text-sky-300 font-medium">Real-time sync active</div>
            </div>

            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full text-sm text-left">
                <thead className="bg-white/5 text-[11px] text-white/50 uppercase border-b border-white/10">
                  <tr>
                    <th className="px-4 py-3">Bet ID</th>
                    <th className="px-4 py-3">Player</th>
                    <th className="px-4 py-3">Event / Game</th>
                    <th className="px-4 py-3">Market / Selection</th>
                    <th className="px-4 py-3 text-right">Odds / Rate</th>
                    <th className="px-4 py-3 text-right">Stake</th>
                    <th className="px-4 py-3 text-right">Potential P/L</th>
                    <th className="px-4 py-3 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-xs">
                  {openBets.map((b) => {
                    const u = byId.get(b.user_id);
                    return (
                      <tr key={b.id} className="hover:bg-white/[0.02]">
                        <td className="px-4 py-3 font-mono text-[11px] text-white/50">#BT-{b.id}</td>
                        <td className="px-4 py-3 font-semibold text-white whitespace-nowrap">
                          {u?.name || "Player"} ({u?.code || "—"})
                        </td>
                        <td className="px-4 py-3 text-sky-300 font-medium min-w-[180px]">{b.event_name}</td>
                        <td className="px-4 py-3 text-white/80 min-w-[160px]">
                          <div>{b.market_name}</div>
                          <div className="text-white/50">
                            {b.runner_name} •{" "}
                            <span className={b.bet_type === "BACK" ? "text-sky-300" : "text-pink-300"}>{b.bet_type}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-white/70">
                          {b.market_type === "FANCY" ? b.line : Number(b.odds)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-amber-300">🪙 {fmt(Number(b.stake))}</td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-emerald-400 whitespace-nowrap">
                          +{fmt(Number(b.profit))} / <span className="text-rose-400">-{fmt(Number(b.exposure))}</span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                            Active
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {openBets.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-white/40">
                        No active live bets placed right now.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* 4. USER HISTORY */}
        {/* ============================================================== */}
        {activeTab === "user_history" && (
          <div className="space-y-4">
            <h3 className="text-base font-bold text-white">User Activity & History Trail</h3>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full text-sm text-left">
                <thead className="bg-white/5 text-[11px] text-white/50 uppercase border-b border-white/10">
                  <tr>
                    <th className="px-4 py-3">Timestamp</th>
                    <th className="px-4 py-3">Actor / User</th>
                    <th className="px-4 py-3">Activity</th>
                    <th className="px-4 py-3">Before</th>
                    <th className="px-4 py-3">After</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-xs">
                  {auditData.map((a) => (
                    <tr key={a.id} className="hover:bg-white/[0.02]">
                      <td className="px-4 py-3 font-mono text-white/60 text-[11px]">
                        {fmtDate(a.created_at)}
                      </td>
                      <td className="px-4 py-3 font-semibold text-white">{a.actor_name || "System"}</td>
                      <td className="px-4 py-3 text-sky-300">{a.action}</td>
                      <td className="px-4 py-3 text-rose-300/80 font-mono text-[11px]">
                        {a.before || "—"}
                      </td>
                      <td className="px-4 py-3 text-emerald-400 font-mono text-[11px]">
                        {a.after || "—"}
                      </td>
                    </tr>
                  ))}
                  {auditData.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-10 text-center text-white/40">
                        No activity logs in this period.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* 5. GENERAL LOCK */}
        {/* ============================================================== */}
        {activeTab === "general_lock" && (
          <div className="space-y-4">
            <h3 className="text-base font-bold text-white">General Lock Management</h3>
            <p className="text-xs text-white/50">
              Manage account freezes, betting restrictions and financial security locks
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {accounts.map((a) => (
                <div
                  key={a.id}
                  className="p-4 rounded-xl border border-white/10 bg-white/5 flex items-center justify-between"
                >
                  <div>
                    <div className="font-semibold text-white text-sm">{a.name}</div>
                    <div className="text-xs text-white/50">
                      {a.code} • {ROLE_LABEL[a.role]}
                    </div>
                    <div className="text-xs text-gold-300 font-mono mt-1">
                      🪙 {fmt(a.coins)}
                    </div>
                  </div>

                  <div className="text-right">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        a.status === "Active"
                          ? "bg-emerald-500/20 text-emerald-300"
                          : "bg-rose-500/20 text-rose-300"
                      }`}
                    >
                      {a.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* 6. OUR CASINO RESULT & LIVE CASINO RESULT */}
        {/* ============================================================== */}
        {(activeTab === "our_casino_result" || activeTab === "live_casino_result") && (
          <div className="space-y-4">
            <div>
              <h3 className="text-base font-bold text-white">
                {activeTab === "our_casino_result" ? "Our Casino" : "Live Casino"} Results
              </h3>
              <p className="text-xs text-white/50">
                {activeTab === "our_casino_result" ? "Card and board tables (Teen Patti, Rummy, Ludo, Poker…)" : "Casino and instant games (Aviator, Roulette, Andar Bahar…)"} in the selected period
              </p>
            </div>
            <RoundLookup />
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full text-sm text-left">
                <thead className="bg-white/5 text-[11px] text-white/50 uppercase border-b border-white/10">
                  <tr>
                    <th className="px-4 py-3">Game</th>
                    <th className="px-4 py-3 text-right">Turnover</th>
                    <th className="px-4 py-3 text-right">Bets</th>
                    <th className="px-4 py-3 text-right">Players</th>
                    <th className="px-4 py-3 text-right">Paid Out</th>
                    <th className="px-4 py-3 text-right">House Net</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-xs">
                  {perGame.filter((g) => (activeTab === "our_casino_result" ? g.category === "card" || g.category === "board" : g.category === "casino")).map((g) => {
                    const net = g.bets - g.returns;
                    return (
                      <tr key={g.name} className="hover:bg-white/[0.02]">
                        <td className="px-4 py-3 font-semibold text-white">{g.name}</td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-amber-300">🪙 {fmt(g.bets)}</td>
                        <td className="px-4 py-3 text-right font-mono text-white/80">{g.count}</td>
                        <td className="px-4 py-3 text-right font-mono text-white/80">{g.players.size}</td>
                        <td className="px-4 py-3 text-right font-mono text-sky-300">🪙 {fmt(g.returns)}</td>
                        <td className={`px-4 py-3 text-right font-mono font-bold ${net >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{net >= 0 ? "+" : ""}{fmt(net)}</td>
                      </tr>
                    );
                  })}
                  {perGame.filter((g) => (activeTab === "our_casino_result" ? g.category === "card" || g.category === "board" : g.category === "casino")).length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-white/40">No games played in this period.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* 7. SPORTBOOK REPORT */}
        {/* ============================================================== */}
        {activeTab === "sportbook_report" && (
          <div className="space-y-4">
            <h3 className="text-base font-bold text-white">Sportbook Matches & Turnover</h3>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full text-sm text-left">
                <thead className="bg-white/5 text-[11px] text-white/50 uppercase border-b border-white/10">
                  <tr>
                    <th className="px-4 py-3">Event / Match</th>
                    <th className="px-4 py-3 text-right">Matched Volume</th>
                    <th className="px-4 py-3 text-right">Bets Count</th>
                    <th className="px-4 py-3 text-right">Platform Net P/L</th>
                    <th className="px-4 py-3 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-xs">
                  {bookRows.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-6 text-center text-white/50">No cricket bets yet.</td></tr>
                  )}
                  {bookRows.map((m, idx) => (
                    <tr key={idx} className="hover:bg-white/[0.02]">
                      <td className="px-4 py-3 font-semibold text-white">{m.match}</td>
                      <td className="px-4 py-3 text-right font-mono font-bold text-gold-300">
                        🪙 {fmt(m.vol)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-white/80">{m.bets}</td>
                      <td
                        className={`px-4 py-3 text-right font-mono font-bold ${
                          m.net >= 0 ? "text-emerald-400" : "text-rose-400"
                        }`}
                      >
                        {m.net >= 0 ? "+" : ""}
                        {fmt(m.net)}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            m.open
                              ? "bg-emerald-500/20 text-emerald-300"
                              : "bg-white/10 text-white/60"
                          }`}
                        >
                          {m.open ? `${m.open} open` : "Settled"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* 8. TURNOVER REPORT */}
        {/* ============================================================== */}
        {activeTab === "turnover" && (
          <div className="space-y-4">
            <div>
              <h3 className="text-base font-bold text-white">Game-Wise Turnover Summary</h3>
              <p className="text-xs text-white/50">Every game, cricket included, in the selected period</p>
            </div>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full text-sm text-left">
                <thead className="bg-white/5 text-[11px] text-white/50 uppercase border-b border-white/10">
                  <tr>
                    <th className="px-4 py-3">Game</th>
                    <th className="px-4 py-3 text-right">Turnover</th>
                    <th className="px-4 py-3 text-right">Bets</th>
                    <th className="px-4 py-3 text-right">Players</th>
                    <th className="px-4 py-3 text-right">Paid Out</th>
                    <th className="px-4 py-3 text-right">House Net</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-xs">
                  {perGame.map((g) => {
                    const net = g.bets - g.returns;
                    return (
                      <tr key={g.name} className="hover:bg-white/[0.02]">
                        <td className="px-4 py-3 font-semibold text-white">{g.name}</td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-amber-300">🪙 {fmt(g.bets)}</td>
                        <td className="px-4 py-3 text-right font-mono text-white/80">{g.count}</td>
                        <td className="px-4 py-3 text-right font-mono text-white/80">{g.players.size}</td>
                        <td className="px-4 py-3 text-right font-mono text-sky-300">🪙 {fmt(g.returns)}</td>
                        <td className={`px-4 py-3 text-right font-mono font-bold ${net >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{net >= 0 ? "+" : ""}{fmt(net)}</td>
                      </tr>
                    );
                  })}
                  {perGame.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-white/40">No bets in this period.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* 9. USER AUTH & REGISTER DETAIL */}
        {/* ============================================================== */}
        {(activeTab === "user_auth" || activeTab === "user_register") && (
          <div className="space-y-4">
            <h3 className="text-base font-bold text-white">
              {activeTab === "user_auth" ? "User Authentication Logs" : "User Registration Details"}
            </h3>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full text-sm text-left">
                <thead className="bg-white/5 text-[11px] text-white/50 uppercase border-b border-white/10">
                  <tr>
                    <th className="px-4 py-3">Registered Date</th>
                    <th className="px-4 py-3">User Name</th>
                    <th className="px-4 py-3">Mobile / Login</th>
                    <th className="px-4 py-3">Role</th>
                    <th className="px-4 py-3">State / City</th>
                    <th className="px-4 py-3 text-right">Balance</th>
                    <th className="px-4 py-3 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-xs">
                  {accounts.filter((u) => activeTab === "user_auth" || inRange(u.createdAt, bounds)).map((u) => (
                    <tr key={u.id} className="hover:bg-white/[0.02]">
                      <td className="px-4 py-3 font-mono text-[11px] text-white/60">
                        {u.createdAt ? fmtDate(u.createdAt) : u.created}
                      </td>
                      <td className="px-4 py-3 font-semibold text-white">
                        <div>{u.name}</div>
                        <div className="text-[10px] text-white/40">{u.username || u.code}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-white/70">
                        {u.phone ? `+91 ${u.phone}` : u.username || "—"}
                      </td>
                      <td className="px-4 py-3 text-white/80">{ROLE_LABEL[u.role]}</td>
                      <td className="px-4 py-3 text-white/60">{u.state || "—"}</td>
                      <td className="px-4 py-3 text-right font-mono font-bold text-gold-300">
                        🪙 {fmt(u.coins)}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                            u.status === "Active"
                              ? "bg-emerald-500/20 text-emerald-300"
                              : "bg-rose-500/20 text-rose-300"
                          }`}
                        >
                          {u.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* 10. TOTAL PROFIT LOSS & USER WIN LOSS */}
        {/* ============================================================== */}
        {activeTab === "total_profit_loss" && (
          <div className="space-y-4">
            <h3 className="text-base font-bold text-white">Total Profit & Loss</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 rounded-xl border border-white/10 bg-white/5">
                <div className="text-xs text-white/50">Platform Turnover</div>
                <div className="text-2xl font-bold text-gold-300 font-mono mt-1">🪙 {fmt(settlement.bets)}</div>
              </div>
              <div className="p-4 rounded-xl border border-white/10 bg-white/5">
                <div className="text-xs text-white/50">Player Payouts (wins + refunds)</div>
                <div className="text-2xl font-bold text-sky-400 font-mono mt-1">🪙 {fmt(settlement.winsAndRefunds)}</div>
              </div>
              <div className="p-4 rounded-xl border border-white/10 bg-white/5">
                <div className="text-xs text-white/50">Net House Profit</div>
                <div className={`text-2xl font-bold font-mono mt-1 ${settlement.houseNetPL >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                  🪙 {settlement.houseNetPL >= 0 ? "+" : ""}{fmt(settlement.houseNetPL)}
                </div>
              </div>
            </div>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full text-sm text-left">
                <thead className="bg-white/5 text-[11px] text-white/50 uppercase border-b border-white/10">
                  <tr>
                    <th className="px-4 py-3">Game</th>
                    <th className="px-4 py-3 text-right">Turnover</th>
                    <th className="px-4 py-3 text-right">Bets</th>
                    <th className="px-4 py-3 text-right">Players</th>
                    <th className="px-4 py-3 text-right">Paid Out</th>
                    <th className="px-4 py-3 text-right">House Net</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-xs">
                  {perGame.map((g) => {
                    const net = g.bets - g.returns;
                    return (
                      <tr key={g.name} className="hover:bg-white/[0.02]">
                        <td className="px-4 py-3 font-semibold text-white">{g.name}</td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-amber-300">🪙 {fmt(g.bets)}</td>
                        <td className="px-4 py-3 text-right font-mono text-white/80">{g.count}</td>
                        <td className="px-4 py-3 text-right font-mono text-white/80">{g.players.size}</td>
                        <td className="px-4 py-3 text-right font-mono text-sky-300">🪙 {fmt(g.returns)}</td>
                        <td className={`px-4 py-3 text-right font-mono font-bold ${net >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{net >= 0 ? "+" : ""}{fmt(net)}</td>
                      </tr>
                    );
                  })}
                  {perGame.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-white/40">No bets in this period.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === "user_win_loss" && (
          <div className="space-y-4">
            <div>
              <h3 className="text-base font-bold text-white">User Win Loss Summary</h3>
              <p className="text-xs text-white/50">Players who bet in the selected period</p>
            </div>
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full text-sm text-left">
                <thead className="bg-white/5 text-[11px] text-white/50 uppercase border-b border-white/10">
                  <tr>
                    <th className="px-4 py-3">Player</th>
                    <th className="px-4 py-3 text-right">Turnover</th>
                    <th className="px-4 py-3 text-right">Bets</th>
                    <th className="px-4 py-3 text-right">Won + Refunds</th>
                    <th className="px-4 py-3 text-right">Win / Loss</th>
                    <th className="px-4 py-3 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-xs">
                  {partyRows.filter((r) => r.a.role === "player" && r.count > 0).map(({ a: u, bets, returns, count }) => {
                    const pl = returns - bets;
                    return (
                      <tr key={u.id} className="hover:bg-white/[0.02]">
                        <td className="px-4 py-3 font-semibold text-white">
                          <div>{u.name}</div>
                          <div className="text-[10px] text-white/40">{u.username || u.code}</div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-amber-300">🪙 {fmt(bets)}</td>
                        <td className="px-4 py-3 text-right font-mono text-white/70">{count}</td>
                        <td className="px-4 py-3 text-right font-mono text-sky-300">🪙 {fmt(returns)}</td>
                        <td className={`px-4 py-3 text-right font-mono font-bold ${pl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{pl >= 0 ? "+" : ""}{fmt(pl)}</td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-gold-300">🪙 {fmt(u.coins)}</td>
                      </tr>
                    );
                  })}
                  {!partyRows.some((r) => r.a.role === "player" && r.count > 0) && <tr><td colSpan={6} className="px-4 py-10 text-center text-white/40">No player bets in this period.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {viewRow && (() => {
        const u = byId.get(viewRow.user_id);
        const parsed = parseTxnNarration(viewRow);
        const isCredit = viewRow.amount > 0;
        const isDebit = viewRow.amount < 0;

        const fields: [string, React.ReactNode][] = [
          ["Transaction ID", (
            <span className="flex items-center gap-1.5 font-mono text-sky-300 font-semibold">
              #{viewRow.id}
              <button
                type="button"
                onClick={() => copyToClipboard(String(viewRow.id), "txId")}
                className="text-white/40 hover:text-white"
                title="Copy Transaction ID"
              >
                {copiedKey === "txId" ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
              </button>
            </span>
          )],
          ["Date & Time", <span className="font-mono text-white/80">{fmtDate(viewRow.created_at)}</span>],
          ["Account / User", u ? (
            <div className="text-right">
              <span className="font-semibold text-white">{u.name}</span>
              <div className="text-xs text-white/40 font-mono">
                {u.code} {u.username ? `• @${u.username}` : ""} • {ROLE_LABEL[u.role]}
              </div>
            </div>
          ) : viewRow.user_id],
          ["Category", (
            <span className="px-2 py-0.5 rounded-lg text-xs font-semibold bg-white/10 text-white">
              {parsed.category}
            </span>
          )],
          ["Transaction Type", (
            <span
              className={`px-2 py-0.5 rounded-lg text-xs font-bold uppercase ${
                viewRow.kind === "bet"
                  ? "bg-amber-500/15 text-amber-300 border border-amber-500/30"
                  : viewRow.kind === "win"
                  ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                  : viewRow.kind === "refund"
                  ? "bg-purple-500/15 text-purple-300 border border-purple-500/30"
                  : viewRow.kind === "transfer_in" || viewRow.kind === "mint"
                  ? "bg-sky-500/15 text-sky-300 border border-sky-500/30"
                  : "bg-rose-500/15 text-rose-300 border border-rose-500/30"
              }`}
            >
              {viewRow.kind.replace("_", " ")}
            </span>
          )],
          ...(parsed.title !== viewRow.note
            ? ([
                ["Event / Match", parsed.title],
                ["Selection / Market", parsed.selection],
                ...(parsed.odds !== "—" ? [["Odds / Rate", <span className="font-mono text-sky-300 font-bold">{parsed.odds}</span>]] : []),
              ] as [string, React.ReactNode][])
            : []),
          ["Flow Amount", (
            <span
              className={`font-mono font-bold ${
                isCredit ? "text-emerald-400" : isDebit ? "text-rose-400" : "text-white"
              }`}
            >
              {isCredit ? `+ 🪙 ${fmt(viewRow.amount)} (Credit)` : `- 🪙 ${fmt(Math.abs(viewRow.amount))} (Debit)`}
            </span>
          )],
          ["Wallet Balance After", (
            <span className="font-mono font-bold text-amber-300">
              🪙 {fmt(viewRow.balance_after)}
            </span>
          )],
        ];

        return (
          <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm grid place-items-center p-4" onClick={() => setViewRow(null)}>
            <div
              className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl border border-white/10 bg-[#0b102e] p-6 space-y-5 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-white/10 pb-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-sky-500/20 text-sky-300 flex items-center justify-center font-bold">
                    <FileText size={16} />
                  </div>
                  <div>
                    <h3 className="font-bold text-white text-base">Transaction Details</h3>
                    <p className="text-xs text-white/40">Audit ledger record #{viewRow.id}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setViewRow(null)}
                  className="p-1 rounded-lg text-white/50 hover:text-white hover:bg-white/5 transition"
                >
                  <XCircle size={20} />
                </button>
              </div>

              <div className="divide-y divide-white/5 text-sm">
                {fields.map(([k, v]) => (
                  <div key={k} className="flex justify-between items-center gap-4 py-2.5">
                    <span className="text-white/50 shrink-0 text-xs uppercase tracking-wide">{k}</span>
                    <span className="text-white text-right break-words min-w-0">{v}</span>
                  </div>
                ))}
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wider text-white/50 font-semibold mb-1.5 flex items-center gap-1.5">
                  <Activity size={13} className="text-sky-400" /> Complete System Narration
                </div>
                <div className="rounded-xl bg-white/5 border border-white/10 p-3.5 text-xs text-white/80 font-mono break-words whitespace-pre-wrap leading-relaxed select-all">
                  {viewRow.note || "—"}
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setViewRow(null)}
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-white/10 hover:bg-white/15 text-white transition"
                >
                  Close Inspection
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
