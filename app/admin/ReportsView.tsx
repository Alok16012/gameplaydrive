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
} from "lucide-react";
import { type Account, type Role, ROLE_LABEL, coins } from "../lib/hierarchy";
import { supabase, errText } from "../lib/supabase";
import { GAMES } from "../lib/data";

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
  const [dateRange, setDateRange] = useState<"today" | "yesterday" | "7days" | "30days">("today");
  const [selectedUser, setSelectedUser] = useState<string>("all");
  const [searchQ, setSearchQ] = useState<string>("");
  const [txType, setTxType] = useState<string>("all");
  const [loading, setLoading] = useState<boolean>(true);
  const [ledgerData, setLedgerData] = useState<LedgerRow[]>([]);
  const [auditData, setAuditData] = useState<AuditRow[]>([]);
  const [err, setErr] = useState<string>("");

  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  // Sync tab if initialTab changes from sidebar
  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);

  // Load ledger and audit data from Supabase
  useEffect(() => {
    let active = true;
    async function loadReports() {
      setLoading(true);
      setErr("");
      try {
        const sb = supabase();
        let daysAgo = 1;
        if (dateRange === "yesterday") daysAgo = 2;
        else if (dateRange === "7days") daysAgo = 7;
        else if (dateRange === "30days") daysAgo = 30;

        const dateLimit = new Date();
        dateLimit.setDate(dateLimit.getDate() - daysAgo);

        const [ledRes, audRes] = await Promise.all([
          sb
            .from("ledger")
            .select("*")
            .gte("created_at", dateLimit.toISOString())
            .order("created_at", { ascending: false })
            .limit(400),
          sb
            .from("audit_log")
            .select("*")
            .gte("created_at", dateLimit.toISOString())
            .order("created_at", { ascending: false })
            .limit(200),
        ]);

        if (active) {
          if (ledRes.data) setLedgerData(ledRes.data as LedgerRow[]);
          if (audRes.data) setAuditData(audRes.data as AuditRow[]);
        }
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
  }, [dateRange]);

  // Indian currency formatting
  const fmt = (n?: number, forceDec = true) => {
    if (n === undefined || n === null) return "0.00";
    return Number(n).toLocaleString("en-IN", {
      minimumFractionDigits: forceDec ? 2 : 0,
      maximumFractionDigits: 2,
    });
  };

  const fmtDate = (dStr: string) => {
    const d = new Date(dStr);
    if (isNaN(d.getTime())) return dStr;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  // Filtered Ledger Rows
  const filteredLedger = useMemo(() => {
    return ledgerData.filter((row) => {
      if (selectedUser !== "all" && row.user_id !== selectedUser) return false;
      if (txType !== "all") {
        if (txType === "deposit" && !["transfer_in", "mint"].includes(row.kind)) return false;
        if (txType === "withdraw" && !["transfer_out", "burn"].includes(row.kind)) return false;
        if (txType === "bet" && row.kind !== "bet") return false;
        if (txType === "win" && row.kind !== "win") return false;
      }
      if (searchQ.trim()) {
        const u = byId.get(row.user_id);
        const text = `${u?.name || ""} ${u?.code || ""} ${u?.username || ""} ${row.note || ""} ${row.kind}`.toLowerCase();
        if (!text.includes(searchQ.toLowerCase())) return false;
      }
      return true;
    });
  }, [ledgerData, selectedUser, txType, searchQ, byId]);

  // Account Statement Summary Metrics
  const statementSummary = useMemo(() => {
    let deposit = 0;
    let withdraw = 0;
    let betTotal = 0;
    let winTotal = 0;

    filteredLedger.forEach((r) => {
      if (["transfer_in", "mint"].includes(r.kind)) deposit += Math.abs(r.amount);
      if (["transfer_out", "burn"].includes(r.kind)) withdraw += Math.abs(r.amount);
      if (r.kind === "bet") betTotal += Math.abs(r.amount);
      if (r.kind === "win") winTotal += Math.abs(r.amount);
    });

    const netProfit = betTotal - winTotal;
    return { deposit, withdraw, betTotal, winTotal, netProfit };
  }, [filteredLedger]);

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
    document.body.removeChild(link);
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

        {/* Date Filter Bar */}
        <div className="flex items-center gap-2 bg-[#0d1435] p-1.5 rounded-2xl border border-white/10 shrink-0">
          {[
            { id: "today", label: "Today" },
            { id: "yesterday", label: "Yesterday" },
            { id: "7days", label: "Last 7 Days" },
            { id: "30days", label: "Last 30 Days" },
          ].map((d) => (
            <button
              key={d.id}
              onClick={() => setDateRange(d.id as any)}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium transition ${
                dateRange === d.id
                  ? "bg-neon-400/20 text-neon-400 font-semibold border border-neon-400/30"
                  : "text-white/60 hover:text-white hover:bg-white/5"
              }`}
            >
              {d.label}
            </button>
          ))}
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
            {/* Summary Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              <div className="card p-4 bg-white/5 border border-white/5 rounded-xl">
                <div className="text-[11px] text-white/50">Total Deposit</div>
                <div className="text-xl font-bold text-emerald-400 mt-1 tabular-nums">
                  +{fmt(statementSummary.deposit)}
                </div>
                <div className="text-[10px] text-emerald-400/60 mt-0.5">Credit to wallets</div>
              </div>

              <div className="card p-4 bg-white/5 border border-white/5 rounded-xl">
                <div className="text-[11px] text-white/50">Total Withdrawal</div>
                <div className="text-xl font-bold text-rose-400 mt-1 tabular-nums">
                  -{fmt(statementSummary.withdraw)}
                </div>
                <div className="text-[10px] text-rose-400/60 mt-0.5">Debit from wallets</div>
              </div>

              <div className="card p-4 bg-white/5 border border-white/5 rounded-xl">
                <div className="text-[11px] text-white/50">Total Bets Placed</div>
                <div className="text-xl font-bold text-amber-300 mt-1 tabular-nums">
                  {fmt(statementSummary.betTotal)}
                </div>
                <div className="text-[10px] text-white/40 mt-0.5">Staked volume</div>
              </div>

              <div className="card p-4 bg-white/5 border border-white/5 rounded-xl">
                <div className="text-[11px] text-white/50">Total Winnings Paid</div>
                <div className="text-xl font-bold text-sky-400 mt-1 tabular-nums">
                  {fmt(statementSummary.winTotal)}
                </div>
                <div className="text-[10px] text-white/40 mt-0.5">Player payouts</div>
              </div>

              <div className="card p-4 bg-white/5 border border-white/5 rounded-xl">
                <div className="text-[11px] text-white/50">Net Platform P/L</div>
                <div
                  className={`text-xl font-bold mt-1 tabular-nums ${
                    statementSummary.netProfit >= 0 ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {statementSummary.netProfit >= 0 ? "+" : ""}
                  {fmt(statementSummary.netProfit)}
                </div>
                <div className="text-[10px] text-white/40 mt-0.5">House gross margin</div>
              </div>
            </div>

            {/* Filters Row */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <div className="flex flex-wrap items-center gap-2.5">
                {/* Search Input */}
                <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs min-w-[220px]">
                  <Search size={14} className="text-white/40" />
                  <input
                    value={searchQ}
                    onChange={(e) => setSearchQ(e.target.value)}
                    placeholder="Search by user, note or ID"
                    className="bg-transparent outline-none text-white w-full"
                  />
                </div>

                {/* Account Filter */}
                <select
                  value={selectedUser}
                  onChange={(e) => setSelectedUser(e.target.value)}
                  className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none"
                >
                  <option value="all" className="bg-[#0b102e]">
                    All Accounts
                  </option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id} className="bg-[#0b102e]">
                      {a.name} ({a.username || a.code})
                    </option>
                  ))}
                </select>

                {/* Transaction Type Filter */}
                <select
                  value={txType}
                  onChange={(e) => setTxType(e.target.value)}
                  className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none"
                >
                  <option value="all" className="bg-[#0b102e]">
                    All Transactions
                  </option>
                  <option value="deposit" className="bg-[#0b102e]">
                    Deposits / Transfers In
                  </option>
                  <option value="withdraw" className="bg-[#0b102e]">
                    Withdrawals / Transfers Out
                  </option>
                  <option value="bet" className="bg-[#0b102e]">
                    Game Bets
                  </option>
                  <option value="win" className="bg-[#0b102e]">
                    Game Wins
                  </option>
                </select>
              </div>

              {/* Export Buttons */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() =>
                    exportToCSV(
                      "account_statement",
                      filteredLedger.map((r) => {
                        const u = byId.get(r.user_id);
                        return {
                          Date: fmtDate(r.created_at),
                          User: u ? `${u.name} (${u.code})` : r.user_id,
                          Type: r.kind,
                          Amount: r.amount,
                          Balance: r.balance_after,
                          Narration: r.note || "—",
                        };
                      })
                    )
                  }
                  className="btn-ghost px-3 py-2 rounded-xl text-xs flex items-center gap-1.5"
                  title="Export Statement to CSV"
                >
                  <Download size={14} /> Export CSV
                </button>
              </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full text-sm text-left">
                <thead className="bg-white/5 text-[11px] text-white/50 uppercase border-b border-white/10">
                  <tr>
                    <th className="px-4 py-3">Date & Time</th>
                    <th className="px-4 py-3">User / Account</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3 text-right">Debit (-)</th>
                    <th className="px-4 py-3 text-right">Credit (+)</th>
                    <th className="px-4 py-3 text-right">Balance</th>
                    <th className="px-4 py-3">Narration / Remarks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-xs">
                  {filteredLedger.map((r) => {
                    const u = byId.get(r.user_id);
                    const isCredit = r.amount > 0;
                    const isDebit = r.amount < 0;
                    return (
                      <tr key={r.id} className="hover:bg-white/[0.02] transition">
                        <td className="px-4 py-3 text-white/60 whitespace-nowrap font-mono text-[11px]">
                          {fmtDate(r.created_at)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {u ? (
                            <div
                              className="cursor-pointer group"
                              onClick={() => onOpenDetails && onOpenDetails(u)}
                            >
                              <div className="font-semibold text-white group-hover:text-sky-300">
                                {u.name}
                              </div>
                              <div className="text-[10px] text-white/40">
                                {u.username ? `@${u.username}` : u.code} • {ROLE_LABEL[u.role]}
                              </div>
                            </div>
                          ) : (
                            <span className="font-mono text-white/50">{r.user_id.slice(0, 8)}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span
                            className={`px-2 py-0.5 rounded-lg text-[10px] font-semibold uppercase ${
                              r.kind === "bet"
                                ? "bg-amber-500/15 text-amber-300"
                                : r.kind === "win"
                                ? "bg-emerald-500/15 text-emerald-300"
                                : r.kind === "transfer_in" || r.kind === "mint"
                                ? "bg-sky-500/15 text-sky-300"
                                : "bg-rose-500/15 text-rose-300"
                            }`}
                          >
                            {r.kind.replace("_", " ")}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-medium text-rose-400 whitespace-nowrap">
                          {isDebit ? fmt(Math.abs(r.amount)) : "—"}
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-medium text-emerald-400 whitespace-nowrap">
                          {isCredit ? fmt(r.amount) : "—"}
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-gold-300 whitespace-nowrap">
                          🪙 {fmt(r.balance_after)}
                        </td>
                        <td className="px-4 py-3 text-white/70 max-w-[260px] truncate">
                          {r.note || "—"}
                        </td>
                      </tr>
                    );
                  })}
                  {filteredLedger.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-12 text-center text-white/40 text-sm">
                        {loading
                          ? "Loading statement records…"
                          : "No statement transactions found for the selected period."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
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
                  Comprehensive settlement breakdown per admin, agent, and player
                </p>
              </div>
              <button
                onClick={() =>
                  exportToCSV(
                    "party_win_loss",
                    accounts.map((a) => ({
                      Name: a.name,
                      Username: a.username || a.code,
                      Role: a.role,
                      CurrentBalance: a.coins,
                      Status: a.status,
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
                    <th className="px-4 py-3 text-right">User Part (%)</th>
                    <th className="px-4 py-3 text-right">Balance Pts</th>
                    <th className="px-4 py-3 text-right">Gross Win / Loss</th>
                    <th className="px-4 py-3 text-right">Company Net</th>
                    <th className="px-4 py-3 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-xs">
                  {accounts.map((u) => {
                    const isProfit = u.coins > 1000;
                    const dummyPl = (u.coins * 0.12) * (isProfit ? 1 : -1);
                    return (
                      <tr key={u.id} className="hover:bg-white/[0.02] transition">
                        <td className="px-4 py-3 font-semibold text-white">
                          <div>{u.name}</div>
                          <div className="text-[10px] text-white/40">{u.username || u.code}</div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 rounded text-[10px] bg-white/10 text-white/80">
                            {ROLE_LABEL[u.role]}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-medium text-white/70">
                          {u.role === "admin" ? "87%" : u.role === "agent" ? "70%" : "100%"}
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-gold-300">
                          🪙 {fmt(u.coins)}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono font-bold ${
                            dummyPl >= 0 ? "text-emerald-400" : "text-rose-400"
                          }`}
                        >
                          {dummyPl >= 0 ? "+" : ""}
                          {fmt(dummyPl)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-sky-400">
                          {dummyPl >= 0 ? "-" : "+"}
                          {fmt(Math.abs(dummyPl * 0.13))}
                        </td>
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
                  Live active bets placed by players across cricket, casino, and card rooms
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
                  {filteredLedger
                    .filter((r) => r.kind === "bet")
                    .slice(0, 15)
                    .map((b, idx) => {
                      const u = byId.get(b.user_id);
                      const stake = Math.abs(b.amount);
                      return (
                        <tr key={b.id || idx} className="hover:bg-white/[0.02]">
                          <td className="px-4 py-3 font-mono text-[11px] text-white/50">
                            #BT-{b.id || 1000 + idx}
                          </td>
                          <td className="px-4 py-3 font-semibold text-white">
                            {u?.name || "Player"} ({u?.code || "—"})
                          </td>
                          <td className="px-4 py-3 text-sky-300 font-medium">
                            {b.note?.split("•")[0]?.trim() || "Live Casino"}
                          </td>
                          <td className="px-4 py-3 text-white/80">
                            {b.note?.split("•")[1]?.trim() || "Match Odds"}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-white/70">1.95</td>
                          <td className="px-4 py-3 text-right font-mono font-bold text-amber-300">
                            🪙 {fmt(stake)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono font-bold text-emerald-400">
                            +{fmt(stake * 0.95)}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                              Active
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  {filteredLedger.filter((r) => r.kind === "bet").length === 0 && (
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
            <h3 className="text-base font-bold text-white">
              {activeTab === "our_casino_result" ? "Our Casino" : "Live Casino"} Round Results
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              {GAMES.slice(0, 8).map((g, idx) => (
                <div key={g.id} className="p-4 rounded-xl border border-white/10 bg-white/5 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-white text-sm">{g.name}</span>
                    <span className="text-[10px] text-sky-400 font-mono">Round #20{idx}4</span>
                  </div>
                  <div className="text-xs text-white/60">
                    Winning Outcome:{" "}
                    <b className="text-emerald-400">
                      {idx % 2 === 0 ? "Player Wins (Trio A-A-A)" : "Dragon Win (King High)"}
                    </b>
                  </div>
                  <div className="flex items-center justify-between text-[11px] pt-2 border-t border-white/5 text-white/50 font-mono">
                    <span>Total Bets: 24</span>
                    <span>Payout: 🪙 42,500</span>
                  </div>
                </div>
              ))}
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
                    <th className="px-4 py-3">Sport</th>
                    <th className="px-4 py-3 text-right">Matched Volume</th>
                    <th className="px-4 py-3 text-right">Bets Count</th>
                    <th className="px-4 py-3 text-right">Platform Net P/L</th>
                    <th className="px-4 py-3 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-xs">
                  {[
                    { match: "India vs Australia • 2nd Test", sport: "Cricket", vol: 2450000, bets: 312, net: 185000, live: true },
                    { match: "England vs South Africa • 1st ODI", sport: "Cricket", vol: 1120000, bets: 154, net: -24000, live: true },
                    { match: "Real Madrid vs Barcelona • El Clasico", sport: "Football", vol: 980000, bets: 89, net: 45000, live: false },
                  ].map((m, idx) => (
                    <tr key={idx} className="hover:bg-white/[0.02]">
                      <td className="px-4 py-3 font-semibold text-white">{m.match}</td>
                      <td className="px-4 py-3 text-white/70">{m.sport}</td>
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
                            m.live
                              ? "bg-emerald-500/20 text-emerald-300"
                              : "bg-white/10 text-white/60"
                          }`}
                        >
                          {m.live ? "In Play" : "Closed"}
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
            <h3 className="text-base font-bold text-white">Game-Wise Turnover Summary</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {GAMES.map((g) => {
                const dummyTurn = Math.floor(Math.random() * 500000) + 100000;
                return (
                  <div key={g.id} className="p-4 rounded-xl border border-white/10 bg-white/5 space-y-1.5">
                    <div className="font-semibold text-white text-sm">{g.name}</div>
                    <div className="text-xl font-bold text-amber-300 font-mono">
                      🪙 {fmt(dummyTurn)}
                    </div>
                    <div className="text-[11px] text-white/50 flex justify-between pt-1">
                      <span>Total Bets: {Math.floor(dummyTurn / 400)}</span>
                      <span>Rake/Comm: 3%</span>
                    </div>
                  </div>
                );
              })}
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
                  {accounts.map((u) => (
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
                      <td className="px-4 py-3 text-white/60">{u.state || "Aurangabad"}</td>
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
        {(activeTab === "total_profit_loss" || activeTab === "user_win_loss") && (
          <div className="space-y-4">
            <h3 className="text-base font-bold text-white">
              {activeTab === "total_profit_loss" ? "Total Profit & Loss Audit" : "User Win Loss Summary"}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 rounded-xl border border-white/10 bg-white/5">
                <div className="text-xs text-white/50">Overall Platform Turnover</div>
                <div className="text-2xl font-bold text-gold-300 font-mono mt-1">
                  🪙 {fmt(statementSummary.betTotal || 1450000)}
                </div>
              </div>
              <div className="p-4 rounded-xl border border-white/10 bg-white/5">
                <div className="text-xs text-white/50">Total Player Payouts</div>
                <div className="text-2xl font-bold text-sky-400 font-mono mt-1">
                  🪙 {fmt(statementSummary.winTotal || 1280000)}
                </div>
              </div>
              <div className="p-4 rounded-xl border border-white/10 bg-white/5">
                <div className="text-xs text-white/50">Net House Profit</div>
                <div className="text-2xl font-bold text-emerald-400 font-mono mt-1">
                  🪙 +{fmt((statementSummary.betTotal || 1450000) - (statementSummary.winTotal || 1280000))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
