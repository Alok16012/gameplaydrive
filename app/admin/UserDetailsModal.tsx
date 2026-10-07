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
} from "lucide-react";
import { type Account, type Role, ROLE_LABEL, coins } from "../lib/hierarchy";
import { supabase } from "../lib/supabase";

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

interface AccountStats {
  clientPL: number;
  userShare: number;
  ourShare: number;
  pts: number;
  players: number;
}

interface UserDetailsModalProps {
  target: Account;
  me: Account;
  onClose: () => void;
  onOpenCoins?: (u: Account) => void;
  onOpenOutcome?: (u: Account) => void;
  onReload?: () => Promise<void>;
}

export function UserDetailsModal({
  target,
  me,
  onClose,
  onOpenCoins,
  onOpenOutcome,
  onReload,
}: UserDetailsModalProps) {
  const [meta, setMeta] = useState<UserExchangeMeta>({
    partnershipName: "Partnership With No Return",
    userPart: 87,
    ourPart: 0,
    remark: "Nothing",
    city: target.state || "Aurangabad",
    creditPts: 300000,
    exposure: 0,
    casinoPts: 0,
    sportsPts: 0,
    thirdPartyPts: 0,
  });

  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<UserExchangeMeta>(meta);
  const [stats, setStats] = useState<AccountStats | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Load saved metadata from app_settings or fallback
  useEffect(() => {
    let active = true;
    async function loadMeta() {
      try {
        const res = await fetch(`/api/account-meta?id=${target.id}`);
        const json = await res.json();
        if (active) setStats(json?.stats ?? null);
        if (active && json?.meta) {
          const merged: UserExchangeMeta = {
            partnershipName: json.meta.partnershipName ?? "Partnership With No Return",
            userPart: json.meta.userPart ?? 87,
            ourPart: json.meta.ourPart ?? 0,
            remark: json.meta.remark ?? "Nothing",
            city: json.meta.city || target.state || "Aurangabad",
            creditPts: json.meta.creditPts ?? 300000,
            exposure: json.meta.exposure ?? 0,
            casinoPts: json.meta.casinoPts ?? 0,
            sportsPts: json.meta.sportsPts ?? 0,
            thirdPartyPts: json.meta.thirdPartyPts ?? 0,
          };
          setMeta(merged);
          setForm(merged);
        } else if (active) {
          const fallback: UserExchangeMeta = {
            partnershipName: "Partnership With No Return",
            userPart: 87,
            ourPart: 0,
            remark: "Nothing",
            city: target.state || "Aurangabad",
            creditPts: 300000,
            exposure: 0,
            casinoPts: 0,
            sportsPts: 0,
            thirdPartyPts: 0,
          };
          setMeta(fallback);
          setForm(fallback);
        }
      } catch {
        // Fallback defaults
      } finally {
        if (active) setLoading(false);
      }
    }
    loadMeta();
    return () => {
      active = false;
    };
  }, [target.id, target.state, target.coins, reloadKey]);

  const saveMeta = async () => {
    const up = Number(form.userPart ?? 0);
    const our = Number(form.ourPart ?? 0);
    if (up < 0 || up > 100 || our < 0 || our > 100 || up + our > 100) {
      showToast("User Part + Our Part must be between 0 and 100");
      return;
    }
    setSaving(true);
    try {
      const { data: s } = await supabase().auth.getSession();
      const token = s.session?.access_token;
      if (!token) throw new Error("Please sign in again");

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
    if (!dateStr) return "24/03/2026 12:24:19";
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

  // Current points (wallets balance or fallback)
  const currentPts = stats?.pts ?? target.coins;
  const clientPL = stats?.clientPL ?? 0;
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
                      value={form.userPart ?? 87}
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

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="font-semibold text-slate-600 block mb-1">City</label>
                    <input
                      value={form.city || ""}
                      onChange={(e) => setForm({ ...form, city: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="font-semibold text-slate-600 block mb-1">Credit pts</label>
                    <input
                      type="number"
                      value={form.creditPts ?? 300000}
                      onChange={(e) => setForm({ ...form, creditPts: Number(e.target.value) })}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500"
                    />
                  </div>
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
              {/* Card 1: Partnership Information */}
              <div className="bg-white rounded-2xl p-5 border border-slate-200/70 shadow-sm">
                <h3 className="text-[15px] font-bold text-slate-800 mb-3.5 tracking-tight">
                  Partnership Information
                </h3>

                <div className="space-y-2 text-[13.5px]">
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Partnership Name:</span>
                    <span className="text-slate-700 font-normal">
                      {meta.partnershipName || "Partnership With No Return"}
                    </span>
                  </div>

                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">User Part:</span>
                    <span className="text-slate-700 font-normal">
                      {meta.userPart ?? 87}
                    </span>
                  </div>

                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Our Part:</span>
                    <span className="text-slate-700 font-normal">
                      {meta.ourPart ?? 0}
                    </span>
                  </div>

                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">User Share P/L:</span>
                    <span className={plColor(stats?.userShare ?? 0)}>
                      {formatPts(stats?.userShare ?? 0, true)}
                    </span>
                  </div>

                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Our Share P/L:</span>
                    <span className={plColor(stats?.ourShare ?? 0)}>
                      {formatPts(stats?.ourShare ?? 0, true)}
                    </span>
                  </div>

                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Remark:</span>
                    <span className="text-slate-700 font-normal">
                      {meta.remark || "Nothing"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Card 2: Additional Information */}
              <div className="bg-white rounded-2xl p-5 border border-slate-200/70 shadow-sm">
                <h3 className="text-[15px] font-bold text-slate-800 mb-3.5 tracking-tight">
                  Additional Information
                </h3>

                <div className="space-y-2 text-[13.5px]">
                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">User Name:</span>
                    <span className="text-slate-700 font-normal">
                      {target.username || target.name}
                    </span>
                  </div>

                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Full Name:</span>
                    <span className="text-slate-700 font-normal">{target.name}</span>
                  </div>

                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Mobile Number:</span>
                    <span className="text-slate-700 font-normal">
                      {target.phone ? `+91 ${target.phone}` : ""}
                    </span>
                  </div>

                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">City:</span>
                    <span className="text-slate-700 font-normal">
                      {meta.city || target.state || "Aurangabad"}
                    </span>
                  </div>

                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Credit pts:</span>
                    <span className="text-slate-700 font-normal">
                      {formatPts(meta.creditPts ?? 300000)}
                    </span>
                  </div>

                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">pts:</span>
                    <span className="text-slate-700 font-normal">
                      {formatPts(currentPts, true)}
                    </span>
                  </div>

                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Available pts:</span>
                    <span className="text-slate-700 font-normal">
                      {formatPts(currentPts - (meta.exposure ?? 0))}
                    </span>
                  </div>

                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Client P/L:</span>
                    <span className={plColor(clientPL)}>
                      {formatPts(clientPL, true)}
                    </span>
                  </div>

                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Exposure:</span>
                    <span className="text-slate-700 font-normal">
                      {meta.exposure ?? 0}
                    </span>
                  </div>

                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Casino pts:</span>
                    <span className="text-slate-700 font-normal">
                      {meta.casinoPts ?? 0}
                    </span>
                  </div>

                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Sports pts:</span>
                    <span className="text-slate-700 font-normal">
                      {meta.sportsPts ?? 0}
                    </span>
                  </div>

                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Third Party pts:</span>
                    <span className="text-slate-700 font-normal">
                      {meta.thirdPartyPts ?? 0}
                    </span>
                  </div>

                  <div className="grid grid-cols-[140px_1fr] items-baseline">
                    <span className="font-bold text-slate-700">Created Date :</span>
                    <span className="text-slate-700 font-normal">
                      {formatExactDate(target.createdAt)}
                    </span>
                  </div>
                </div>
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
    </div>
  );
}
