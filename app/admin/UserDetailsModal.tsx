"use client";

import { useState, useEffect } from "react";
import {
  X,
  User,
  Phone,
  Building2,
  Pencil,
  Coins,
  Check,
  Copy,
  Sliders,
  CheckCircle2,
  Save,
  KeyRound,
} from "lucide-react";
import { type Account, type Role, ROLE_LABEL, coins } from "../lib/hierarchy";
import { apiFetch, authToken, supabase } from "../lib/supabase";
import type { SportBetRow } from "../lib/cricketApi";
import { ResetSubordinatePasswordModal } from "../components/ChangePasswordModal";

export interface UserExchangeMeta {
  partnershipName?: string;
  userPart?: number;
  ourPart?: number;
  remark?: string;
  city?: string;
  creditPts?: number;
  availablePts?: number;
  clientPL?: number;
  exposure?: number;
  casinoPts?: number;
  sportsPts?: number;
  thirdPartyPts?: number;
}

// Live figures from /api/account-meta (computed from the ledger, never stored).
interface AccountStats {
  clientPL: number;
  userShare: number;
  ourShare: number;
  pts: number;
  players: number;
  deposits: number;
  withdrawals: number;
  turnover: number;
  returns: number;
  exposure: number;
  openBets: number;
}

interface UserDetailsModalProps {
  target: Account;
  me: Account;
  onClose: () => void;
  onOpenCoins?: (u: Account) => void;
  onOpenOutcome?: (u: Account) => void;
  onOpenResetPassword?: (u: Account) => void;
  onReload?: () => Promise<void>;
}

export function UserDetailsModal({
  target,
  me,
  onClose,
  onOpenCoins,
  onOpenOutcome,
  onOpenResetPassword,
  onReload,
}: UserDetailsModalProps) {
  const [meta, setMeta] = useState<UserExchangeMeta>({
    partnershipName: "",
    userPart: 0,
    ourPart: 0,
    remark: "",
    city: "",
  });

  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<UserExchangeMeta>(meta);
  const [statsErr, setStatsErr] = useState("");
  const [stats, setStats] = useState<AccountStats | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showSportsExposure, setShowSportsExposure] = useState(false);
  const [showResetPw, setShowResetPw] = useState(false);

  // Saved partnership details plus live ledger figures.
  useEffect(() => {
    let active = true;
    async function loadMeta() {
      setStatsErr("");
      try {
        const res = await apiFetch(`/api/account-meta?id=${target.id}`);
        const json = await res.json();
        if (!active) return;
        if (!res.ok) throw new Error(json?.error || "Could not load figures");
        setStats(json?.stats ?? null);
        if (!json?.stats) setStatsErr("Could not load live figures");
        const m = json?.meta ?? {};
        // Accounts created before this fix had these placeholders saved as if they were real values.
        const real = (v: unknown, placeholder: string) => (typeof v === "string" && v.trim() !== placeholder ? v : "");
        const merged: UserExchangeMeta = {
          partnershipName: real(m.partnershipName, "Partnership With No Return"),
          userPart: m.userPart ?? 0,
          ourPart: m.ourPart ?? 0,
          remark: real(m.remark, "Nothing"),
          city: real(m.city, "Aurangabad"),
        };
        setMeta(merged);
        setForm(merged);
      } catch (e) {
        if (active) setStatsErr(e instanceof Error ? e.message : "Could not load live figures");
      } finally {
        if (active) setLoading(false);
      }
    }
    loadMeta();
    return () => {
      active = false;
    };
  }, [target.id, target.coins, reloadKey]);

  const saveMeta = async () => {
    const up = Number(form.userPart ?? 0);
    const our = Number(form.ourPart ?? 0);
    if (up < 0 || up > 100 || our < 0 || our > 100 || up + our > 100) {
      showToast("User Part + Our Part must be between 0 and 100");
      return;
    }
    setSaving(true);
    try {
      const token = await authToken();

      const res = await fetch("/api/account-meta", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ id: target.id, meta: form }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save");

      setMeta(form);
      setEditing(false);
      setReloadKey((k) => k + 1);
      showToast("Partnership & Details saved successfully!");
      if (onReload) await onReload();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Error saving";
      showToast(msg);
    } finally {
      setSaving(false);
    }
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handlePhoneAction = () => {
    if (target.phone) {
      navigator.clipboard?.writeText(target.phone);
      showToast(`Phone +91 ${target.phone} copied!`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      showToast("No mobile number added");
    }
  };

  const handleBankAction = () => {
    showToast(`Bank & Network: ${target.name} (${target.code}) • Balance: ${coins(target.coins)}`);
  };

  // Format Points / Currencies
  const formatPts = (num?: number, forceDecimals = false) => {
    if (num === undefined || num === null) return "0";
    if (num === 0) return "0";
    return Number(num).toLocaleString("en-IN", {
      minimumFractionDigits: forceDecimals ? 2 : Number.isInteger(num) ? 0 : 2,
      maximumFractionDigits: 2,
    });
  };

  // Format exact Date & Time: 24/03/2026 12:24:19
  const formatExactDate = (dateStr?: string) => {
    if (!dateStr) return "—";
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const pad = (n: number) => String(n).padStart(2, "0");
    const day = pad(d.getDate());
    const month = pad(d.getMonth() + 1);
    const year = d.getFullYear();
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    const seconds = pad(d.getSeconds());
    return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
  };

  // Capitalized Title Bar Username
  const titleDisplay = (target.username || target.code || target.name).toUpperCase();

  const currentPts = stats?.pts ?? target.coins;
  const clientPL = stats?.clientPL ?? 0;
  const isPlayer = target.role === "player";
  const live = (n: number | undefined, dec = true) => (loading ? "…" : stats ? formatPts(n ?? 0, dec) : "—");
  const plColor = (n: number) => (n < 0 ? "text-rose-600 font-medium" : n > 0 ? "text-emerald-600 font-medium" : "text-slate-700");

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[480px] bg-[#f4f6f9] text-slate-900 rounded-2xl overflow-hidden shadow-2xl border border-white/10 my-auto animate-in fade-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Dark Header */}
        <div className="bg-[#1e2430] text-white px-5 py-3.5 flex items-center justify-between border-b border-white/5 select-none">
          <div className="font-bold tracking-wider text-[15px] font-sans uppercase">
            {titleDisplay}
          </div>
          <button
            onClick={onClose}
            className="text-white/70 hover:text-white p-1 rounded-lg hover:bg-white/10 transition"
            aria-label="Close"
          >
            <X size={19} />
          </button>
        </div>

        {/* Modal Scrollable Body */}
        <div className="p-4 sm:p-5 space-y-4 max-h-[82vh] overflow-y-auto">
          {/* User Profile Summary Card */}
          <div className="bg-white rounded-2xl p-5 border border-slate-200/70 shadow-sm flex flex-col items-center text-center">
            <div className="w-16 h-16 rounded-full bg-slate-100 border border-slate-200/80 flex items-center justify-center text-slate-500 mb-2.5">
              <User size={32} className="text-slate-600" />
            </div>

            <div className="text-[19px] font-bold text-slate-800 tracking-tight">
              {target.username || target.code}
            </div>
            <div className="text-sm text-slate-500 font-normal mt-0.5">
              {target.name}
            </div>

            {/* Action Buttons: Phone & Bank/Office */}
            <div className="flex items-center justify-center gap-6 mt-4 pt-3 border-t border-slate-100 w-full">
              <button
                onClick={handlePhoneAction}
                title={target.phone ? `Call / Copy: +91 ${target.phone}` : "No phone available"}
                className="w-11 h-11 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 flex items-center justify-center text-slate-700 shadow-sm hover:border-slate-300 transition active:scale-95"
              >
                {copied ? <Check size={18} className="text-emerald-600" /> : <Phone size={18} />}
              </button>

              <button
                onClick={handleBankAction}
                title="Account / Network Info"
                className="w-11 h-11 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 flex items-center justify-center text-slate-700 shadow-sm hover:border-slate-300 transition active:scale-95"
              >
                <Building2 size={18} />
              </button>
            </div>
          </div>

          {/* Edit Form Toggle View */}
          {editing ? (
            <div className="bg-white rounded-2xl p-5 border border-slate-200/70 shadow-sm space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <h3 className="text-[15px] font-bold text-slate-800">
                  Edit Partnership & Points
                </h3>
                <button
                  onClick={() => setEditing(false)}
                  className="text-xs text-slate-500 hover:text-slate-800"
                >
                  Cancel
                </button>
              </div>

              <div className="space-y-3 text-xs">
                <div>
                  <label className="font-semibold text-slate-600 block mb-1">
                    Partnership Name
                  </label>
                  <input
                    value={form.partnershipName || ""}
                    onChange={(e) => setForm({ ...form, partnershipName: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="font-semibold text-slate-600 block mb-1">User Part (%)</label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={form.userPart ?? 0}
                      onChange={(e) => setForm({ ...form, userPart: Number(e.target.value) })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="font-semibold text-slate-600 block mb-1">Our Part (%)</label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={form.ourPart ?? 0}
                      onChange={(e) => setForm({ ...form, ourPart: Number(e.target.value) })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="font-semibold text-slate-600 block mb-1">Remark</label>
                  <input
                    value={form.remark || ""}
                    onChange={(e) => setForm({ ...form, remark: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="font-semibold text-slate-600 block mb-1">City</label>
                  <input
                    value={form.city || ""}
                    onChange={(e) => setForm({ ...form, city: e.target.value })}
                    placeholder={target.state || ""}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500"
                  />
                </div>

                <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 space-y-1">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Client P/L (live)</span>
                    <span className={plColor(clientPL)}>{formatPts(clientPL, true)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">User share ({form.userPart ?? 0}%)</span>
                    <span className={plColor((-clientPL * (form.userPart ?? 0)) / 100)}>{formatPts((-clientPL * (form.userPart ?? 0)) / 100, true)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Our share ({form.ourPart ?? 0}%)</span>
                    <span className={plColor((-clientPL * (form.ourPart ?? 0)) / 100)}>{formatPts((-clientPL * (form.ourPart ?? 0)) / 100, true)}</span>
                  </div>
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="flex-1 py-2 rounded-xl text-xs font-semibold border border-slate-200 text-slate-600 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={saveMeta}
                  className="flex-1 py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white flex items-center justify-center gap-1.5 shadow-md shadow-emerald-900/10"
                >
                  <Save size={14} />
                  {saving ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Card 1: Partnership Information — only admins and agents have a share */}
              {!isPlayer && (
              <div className="bg-white rounded-2xl p-5 border border-slate-200/70 shadow-sm">
                <h3 className="text-[15px] font-bold text-slate-800 mb-3.5 tracking-tight">
                  Partnership Information
                </h3>

                <div className="space-y-2 text-[13.5px]">
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Partnership Name:</span>
                    <span className="text-slate-700 font-normal">{meta.partnershipName || "—"}</span>
                  </div>
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">User Part:</span>
                    <span className="text-slate-700 font-normal">{meta.userPart ?? 0}%</span>
                  </div>
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Our Part:</span>
                    <span className="text-slate-700 font-normal">{meta.ourPart ?? 0}%</span>
                  </div>
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Players Under:</span>
                    <span className="text-slate-700 font-normal">{live(stats?.players, false)}</span>
                  </div>
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Client P/L:</span>
                    <span className={plColor(clientPL)}>{live(clientPL)}</span>
                  </div>
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">User Share P/L:</span>
                    <span className={plColor(stats?.userShare ?? 0)}>{live(stats?.userShare)}</span>
                  </div>
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Our Share P/L:</span>
                    <span className={plColor(stats?.ourShare ?? 0)}>{live(stats?.ourShare)}</span>
                  </div>
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Remark:</span>
                    <span className="text-slate-700 font-normal">{meta.remark || "—"}</span>
                  </div>
                </div>
              </div>
              )}

              {/* Card 2: Account details and live ledger figures */}
              <div className="bg-white rounded-2xl p-5 border border-slate-200/70 shadow-sm">
                <h3 className="text-[15px] font-bold text-slate-800 mb-3.5 tracking-tight">
                  Additional Information
                </h3>

                <div className="space-y-2 text-[13.5px]">
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">User Name:</span>
                    <span className="text-slate-700 font-normal">{target.username || "—"}</span>
                  </div>
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Full Name:</span>
                    <span className="text-slate-700 font-normal">{target.name}</span>
                  </div>
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Role:</span>
                    <span className="text-slate-700 font-normal">{ROLE_LABEL[target.role]}</span>
                  </div>
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Mobile Number:</span>
                    <span className="text-slate-700 font-normal">{target.phone ? `+91 ${target.phone}` : "—"}</span>
                  </div>
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">City / State:</span>
                    <span className="text-slate-700 font-normal">{meta.city || target.state || "—"}</span>
                  </div>
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Balance pts:</span>
                    <span className="text-slate-900 font-semibold">{live(currentPts)}</span>
                  </div>
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Total Deposit:</span>
                    <span className="text-emerald-600 font-medium">{live(stats?.deposits)}</span>
                  </div>
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Total Withdraw:</span>
                    <span className="text-rose-600 font-medium">{live(stats?.withdrawals)}</span>
                  </div>
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Turnover (bets):</span>
                    <span className="text-slate-700 font-normal">{live(stats?.turnover)}</span>
                  </div>
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Won + Refunds:</span>
                    <span className="text-slate-700 font-normal">{live(stats?.returns)}</span>
                  </div>
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Client P/L:</span>
                    <span className={plColor(clientPL)}>{live(clientPL)}</span>
                  </div>

                  <div
                    className={`grid grid-cols-[140px_1fr] items-baseline ${isPlayer && stats?.openBets ? "cursor-pointer hover:bg-slate-50 p-1 -ml-1 rounded transition" : ""}`}
                    onClick={() => isPlayer && stats?.openBets && setShowSportsExposure(true)}
                  >
                    <span className="font-bold text-slate-700">Exposure:</span>
                    <span className={isPlayer && stats?.openBets ? "text-blue-600 font-semibold underline decoration-blue-300 underline-offset-2" : "text-slate-700 font-normal"}>
                      {live(stats?.exposure)}
                      {stats?.openBets ? ` (${stats.openBets} open bet${stats.openBets === 1 ? "" : "s"})` : ""}
                    </span>
                  </div>

                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Created Date :</span>
                    <span className="text-slate-700 font-normal">{formatExactDate(target.createdAt)}</span>
                  </div>
                </div>
                {statsErr && <div className="text-xs text-rose-600 mt-3">{statsErr}</div>}
                {!isPlayer && stats && (
                  <div className="text-[11px] text-slate-500 mt-3">Turnover, P/L and exposure cover all {stats.players} players under this account.</div>
                )}
              </div>
            </>
          )}

          {/* Toast message inside modal */}
          {toast && (
            <div className="p-3 bg-slate-900 text-white rounded-xl text-xs flex items-center gap-2 shadow-lg animate-in fade-in">
              <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
              <span>{toast}</span>
            </div>
          )}

          {/* Quick Action Footer Buttons */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-200">
            <div className="flex gap-2">
              {!editing && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 flex items-center gap-1.5 transition shadow-sm"
                >
                  <Pencil size={13} />
                  Edit Details
                </button>
              )}

              {onOpenCoins && (
                <button
                  type="button"
                  onClick={() => onOpenCoins(target)}
                  className="px-3 py-2 rounded-xl text-xs font-semibold bg-amber-500/10 border border-amber-500/30 text-amber-700 hover:bg-amber-500/20 flex items-center gap-1.5 transition"
                >
                  <Coins size={13} />
                  Coins
                </button>
              )}

              <button
                type="button"
                onClick={() => onOpenResetPassword ? onOpenResetPassword(target) : setShowResetPw(true)}
                className="px-3 py-2 rounded-xl text-xs font-semibold bg-sky-500/10 border border-sky-500/30 text-sky-700 hover:bg-sky-500/20 flex items-center gap-1.5 transition"
                title="Reset account password"
              >
                <KeyRound size={13} />
                Password
              </button>

              {onOpenOutcome && me.role === "superadmin" && (
                <button
                  type="button"
                  onClick={() => onOpenOutcome(target)}
                  className="px-3 py-2 rounded-xl text-xs font-semibold bg-purple-500/10 border border-purple-500/30 text-purple-700 hover:bg-purple-500/20 flex items-center gap-1.5 transition"
                >
                  <Sliders size={13} />
                  Outcome
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-white transition ml-auto"
            >
              Close
            </button>
          </div>
        </div>
      </div>

      {showSportsExposure && (
        <LiveSportsExposureModal target={target} onClose={() => setShowSportsExposure(false)} />
      )}

      {showResetPw && (
        <ResetSubordinatePasswordModal
          target={target}
          onClose={() => setShowResetPw(false)}
          onSuccess={onReload}
        />
      )}
    </div>
  );
}

function LiveSportsExposureModal({ target, onClose }: { target: Account; onClose: () => void }) {
  const [bets, setBets] = useState<SportBetRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    supabase()
      .from("sport_bets")
      .select("*")
      .eq("user_id", target.id)
      .eq("status", "OPEN")
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (!active) return;
        setBets((data as SportBetRow[]) ?? []);
        setLoading(false);
      });
    return () => { active = false; };
  }, [target.id]);

  return (
    <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-3 sm:p-4 animate-in fade-in zoom-in-95" onClick={onClose}>
      <div className="w-full max-w-[420px] bg-[#1e2430] text-slate-200 rounded-2xl overflow-hidden shadow-2xl border border-white/10" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-white/10 flex items-center justify-between bg-slate-900">
          <h3 className="font-bold tracking-wider text-sm text-white">LIVE SPORTS EXPOSURE</h3>
          <button onClick={onClose} className="text-white/60 hover:text-white p-1 rounded-lg bg-white/5"><X size={16} /></button>
        </div>
        <div className="px-4 py-3 bg-slate-800/50 text-xs text-white/50 border-b border-white/5">
          Coins locked in open cricket bets, waiting for a result
        </div>
        <div className="p-4 max-h-[60vh] overflow-y-auto space-y-2">
          {loading ? (
            <div className="py-8 text-center text-white/40 text-sm">Loading bets...</div>
          ) : bets.length === 0 ? (
            <div className="py-8 text-center text-white/40 text-sm">No open bets.</div>
          ) : (
            bets.map((b) => (
              <div key={b.id} className="flex items-center gap-3 py-3 border-b border-white/5 last:border-0">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white truncate">{b.event_name}</div>
                  <div className="text-[11px] text-white/50 truncate">
                    {b.market_name} • {b.runner_name} • {b.bet_type} @ {b.market_type === "FANCY" ? b.line : Number(b.odds)}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-bold text-rose-400 font-mono">
                    - {Number(b.exposure).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                  <div className="text-[10px] text-white/40">Stake {Number(b.stake).toLocaleString("en-IN")}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
