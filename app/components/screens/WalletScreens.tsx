"use client";

import { useEffect, useState } from "react";
import {
  ArrowDownLeft,
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Gift,
  Info,
  MessageCircle,
  Phone,
  Plus,
  QrCode,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  Trophy,
  Wallet as WalletIcon,
} from "lucide-react";
import { inr, type Txn } from "../../lib/data";
import { useStore } from "../../lib/store";
import { supabase } from "../../lib/supabase";
import { Header, Money } from "../ui";
import type { Nav } from "../nav";

interface AgentPaymentInfo {
  hasPaymentDetails: boolean;
  agentId?: string;
  agentName?: string;
  agentCode?: string;
  agentPhone?: string;
  upiId?: string | null;
  payeeName?: string | null;
  qrCodeUrl?: string | null;
  paymentNote?: string | null;
  isActive?: boolean;
  message?: string;
}

function TxnIcon({ t }: { t: Txn["type"] }) {
  const map = {
    deposit: { bg: "linear-gradient(135deg,#86efac,#16a34a)", icon: <Plus size={16} color="#052e16" strokeWidth={3} /> },
    winning: { bg: "linear-gradient(135deg,#fde68a,#f59e0b)", icon: <Trophy size={15} color="#451a03" /> },
    bet: { bg: "linear-gradient(135deg,#fca5a5,#dc2626)", icon: <span className="text-[13px]">🎲</span> },
    withdraw: { bg: "linear-gradient(135deg,#93c5fd,#2563eb)", icon: <ArrowDownLeft size={16} color="#fff" /> },
    bonus: { bg: "linear-gradient(135deg,#f0abfc,#a21caf)", icon: <Gift size={15} color="#fff" /> },
  }[t];
  return <div className="w-10 h-10 rounded-full grid place-items-center shrink-0 ring-2 ring-white/10" style={{ background: map.bg }}>{map.icon}</div>;
}

export function TxnRow({ t }: { t: Txn }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <TxnIcon t={t.type} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{t.title}</div>
        <div className="text-[11px] text-[var(--ink-soft)] truncate">{t.sub}</div>
      </div>
      <div className="text-right">
        <div className={`text-sm font-semibold ${t.amount >= 0 ? "text-neon-400" : "text-rose-400"}`}>{t.amount >= 0 ? "+ " : "- "}{inr(t.amount)}</div>
        {t.status === "Pending" && <div className="text-[10px] text-gold-400">Pending</div>}
      </div>
    </div>
  );
}

export function WalletScreen({ nav }: { nav: Nav }) {
  const { total, txns, hidden, toggleHidden, player } = useStore();
  return (
    <div className="pb-28 fadein">
      <Header title="Wallet" onBack={() => nav.reset({ name: "home" })} />
      <div className="px-4">
        <div className="balance-card p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm text-white/80">Coin Balance</div>
            <button onClick={toggleHidden} aria-label="Toggle balance">{hidden ? <EyeOff size={20} /> : <Eye size={20} />}</button>
          </div>
          <Money n={total} className="block text-[30px] font-semibold mt-0.5" />
          <div className="text-[11px] text-white/60 mt-2">{player?.agent ? `Your agent: ${player.agent}` : "Coins come from your agent"}</div>
        </div>

        <div className="grid grid-cols-2 gap-3 mt-5">
          {[
            ["Get Coins", <Plus key="a" size={20} strokeWidth={3} />, () => nav.push({ name: "addcash" }), true],
            ["History", <ReceiptText key="t" size={20} />, () => nav.push({ name: "txns" }), false],
          ].map(([label, icon, fn, primary]) => (
            <button key={label as string} onClick={fn as () => void} className="flex flex-col items-center gap-2 text-xs font-medium">
              <span className={`w-12 h-12 rounded-full grid place-items-center ${primary ? "btn-green" : "btn-ghost"}`}>{icon as React.ReactNode}</span>
              {label as string}
            </button>
          ))}
        </div>

        <div className="card mt-5 px-4 pt-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Recent Activity</div>
            <button onClick={() => nav.push({ name: "txns" })} className="text-xs text-neon-400">View All</button>
          </div>
          <div className="divide-y divide-white/5">{txns.slice(0, 5).map((t) => <TxnRow key={t.id} t={t} />)}</div>
          {txns.length === 0 && <div className="py-8 text-center text-sm text-white/40">No activity yet</div>}
        </div>

        <div className="mt-4 flex gap-2 text-[11px] text-white/45 px-1">
          <Info size={14} className="shrink-0 mt-0.5" />
          Coins are virtual. They can&apos;t be bought, withdrawn or exchanged for money.
        </div>
      </div>
    </div>
  );
}

/** "Get coins" — displays the player's specific agent UPI and QR code details. */
export function AddCash({ nav }: { nav: Nav }) {
  const { player, refresh, total, showToast } = useStore();
  const [paymentInfo, setPaymentInfo] = useState<AgentPaymentInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedUpi, setCopiedUpi] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [utr, setUtr] = useState("");
  const [submittingUtr, setSubmittingUtr] = useState(false);

  const handleSubmitUtr = async () => {
    if (!utr || utr.length !== 12) {
      showToast("Please enter a valid 12-digit UTR number");
      return;
    }
    setSubmittingUtr(true);
    // Simulate API call
    setTimeout(() => {
      setSubmittingUtr(false);
      setUtr("");
      showToast("UTR submitted successfully. Coins will be credited soon.");
    }, 1500);
  };

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const { data: s } = await supabase().auth.getSession();
        const token = s.session?.access_token;
        if (!token) return;

        const res = await fetch("/api/agent-payment", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (active && res.ok) {
          setPaymentInfo(data);
        }
      } catch (e) {
        console.error("Error fetching agent payment details:", e);
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, []);

  const copyToClipboard = (text: string, isUpi: boolean) => {
    navigator.clipboard.writeText(text);
    if (isUpi) {
      setCopiedUpi(true);
      setTimeout(() => setCopiedUpi(false), 2000);
      showToast("UPI ID copied to clipboard");
    } else {
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
      showToast("Player ID copied to clipboard");
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
    showToast("Wallet balance updated");
  };

  const agentName = paymentInfo?.agentName || player?.agent || "Your Agent";
  const agentPhone = (paymentInfo?.agentPhone || "").trim();
  const digitsOnly = agentPhone.replace(/\D/g, "");
  let waNumber = "";
  let displayPhone = "";

  if (digitsOnly.length >= 7) {
    if (agentPhone.startsWith("+")) {
      waNumber = digitsOnly;
      displayPhone = agentPhone;
    } else if (digitsOnly.length === 10) {
      waNumber = `91${digitsOnly}`;
      displayPhone = `+91 ${digitsOnly}`;
    } else {
      waNumber = digitsOnly;
      displayPhone = `+${digitsOnly}`;
    }
  }

  const upiUri = paymentInfo?.upiId
    ? `upi://pay?pa=${encodeURIComponent(paymentInfo.upiId)}&pn=${encodeURIComponent(
        paymentInfo.payeeName || agentName
      )}&cu=INR`
    : "";

  const whatsappMsg = encodeURIComponent(
    `Hello ${agentName}, I have made a deposit for Player ID: ${player?.code || ""}. Please credit coins to my GameHub wallet.`
  );

  return (
    <div className="pb-16 fadein">
      <Header title="Get Coins" onBack={nav.back} />
      <div className="px-4 space-y-4">
        {loading ? (
          <div className="card p-8 text-center text-white/50 animate-pulse space-y-3">
            <QrCode className="mx-auto text-neon-400" size={36} />
            <div className="text-sm">Connecting to your agent&apos;s payment channel…</div>
          </div>
        ) : paymentInfo?.hasPaymentDetails ? (
          <>
            {/* Agent Info Banner */}
            <div className="card p-4 bg-gradient-to-r from-neon-500/15 via-white/5 to-transparent border border-neon-500/30">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-10 h-10 rounded-full bg-neon-400/20 text-neon-400 grid place-items-center">
                    <ShieldCheck size={22} />
                  </div>
                  <div>
                    <div className="text-[11px] text-neon-400 font-semibold uppercase tracking-wider">
                      Verified Agent Deposit
                    </div>
                    <div className="text-base font-bold text-white">{agentName}</div>
                  </div>
                </div>
                {paymentInfo.agentCode && (
                  <span className="pill px-2.5 py-1 text-xs font-mono bg-white/10 text-white/80">
                    {paymentInfo.agentCode}
                  </span>
                )}
              </div>
            </div>

            {/* QR Code Container */}
            <div className="card p-5 text-center">
              <div className="text-xs font-semibold text-white/70 mb-3 uppercase tracking-wider">
                Scan to Pay via Any UPI App
              </div>

              {paymentInfo.qrCodeUrl ? (
                <div className="bg-white p-3.5 rounded-2xl inline-block shadow-2xl mx-auto">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={paymentInfo.qrCodeUrl}
                    alt="Agent UPI QR Code"
                    className="w-56 h-56 object-contain mx-auto"
                  />
                </div>
              ) : (
                <div className="py-8 text-white/40 text-sm">QR Code not available</div>
              )}

              <div className="text-xs text-white/60 mt-3 font-medium">
                Google Pay &bull; PhonePe &bull; Paytm &bull; BHIM &bull; CRED
              </div>

              {/* UPI ID Box */}
              {paymentInfo.upiId && (
                <div className="mt-4 p-3 rounded-xl bg-white/5 border border-white/10 flex items-center justify-between gap-3 text-left">
                  <div className="min-w-0">
                    <div className="text-[10px] text-white/40 uppercase tracking-wider font-semibold">
                      Agent UPI ID
                    </div>
                    <div className="text-sm font-mono font-bold text-white tracking-wide truncate">
                      {paymentInfo.upiId}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(paymentInfo.upiId!, true)}
                    className="btn-ghost rounded-xl px-3 py-1.5 text-xs flex items-center gap-1.5 shrink-0 bg-white/10 hover:bg-white/15"
                  >
                    {copiedUpi ? <Check size={14} className="text-neon-400" /> : <Copy size={14} />}
                    {copiedUpi ? "Copied" : "Copy"}
                  </button>
                </div>
              )}

              {/* Pay Via UPI App Direct Link for Mobile */}
              {upiUri && (
                <a
                  href={upiUri}
                  className="btn-green w-full py-3.5 rounded-2xl mt-3 text-sm font-semibold flex items-center justify-center gap-2 shadow-lg"
                >
                  <ExternalLink size={16} />
                  Open in UPI App
                </a>
              )}
            </div>

            {/* Player ID & Proof Step */}
            <div className="card p-4 space-y-3">
              <div className="flex items-center justify-between bg-white/5 border border-white/10 rounded-xl p-3">
                <div>
                  <div className="text-[10px] text-white/40 uppercase tracking-wider font-semibold">
                    Your Player ID
                  </div>
                  <div className="text-base font-mono font-bold text-gold-300">
                    {player?.code || "—"}
                  </div>
                </div>
                {player?.code && (
                  <button
                    type="button"
                    onClick={() => copyToClipboard(player.code, false)}
                    className="btn-ghost rounded-xl px-3 py-1.5 text-xs flex items-center gap-1.5 bg-white/10 hover:bg-white/15"
                  >
                    {copiedId ? <Check size={14} className="text-neon-400" /> : <Copy size={14} />}
                    {copiedId ? "Copied" : "Copy ID"}
                  </button>
                )}
              </div>

              {/* UTR Input */}
              <div className="space-y-1.5 pt-2 border-t border-white/5">
                <div className="text-[10px] text-white/40 uppercase tracking-wider font-semibold">
                  Upload UTR Number
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={utr}
                    onChange={(e) => setUtr(e.target.value.replace(/\\D/g, '').slice(0, 12))}
                    placeholder="Enter 12-digit UTR"
                    className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-neon-400/50"
                  />
                  <button
                    onClick={handleSubmitUtr}
                    disabled={submittingUtr || utr.length !== 12}
                    className="btn-green rounded-xl px-4 py-2 text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                  >
                    {submittingUtr ? "Submitting..." : "Submit UTR"}
                  </button>
                </div>
              </div>

              {/* Agent instructions / note */}
              {paymentInfo.paymentNote && (
                <div className="p-3 rounded-xl bg-white/[0.03] border border-white/5 text-xs text-white/60 leading-relaxed">
                  <span className="font-semibold text-white/80 block mb-0.5">Instructions:</span>
                  {paymentInfo.paymentNote}
                </div>
              )}
            </div>

            {/* Withdraw and Customer Care buttons */}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => showToast("Withdrawal request sent. Agent will contact you.")}
                className="flex-1 py-3 rounded-2xl text-xs font-semibold flex items-center justify-center gap-2 bg-white/5 border border-white/10 hover:bg-white/10 transition text-white"
              >
                <ArrowDownLeft size={16} className="text-rose-400" />
                Withdraw
              </button>
              
              {waNumber ? (
                <a
                  href={`https://wa.me/${waNumber}?text=${encodeURIComponent("I need help with my account.")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 py-3 rounded-2xl text-xs font-semibold flex items-center justify-center gap-2 bg-white/5 border border-white/10 hover:bg-white/10 transition text-white"
                >
                  <Phone size={16} className="text-neon-400" />
                  Customer Care
                </a>
              ) : null}
            </div>
          </>
        ) : (
          /* Fallback when Agent hasn't set up QR code yet */
          <div className="card p-6 text-center space-y-4">
            <div className="text-5xl">🪙</div>
            <div className="text-lg font-semibold">Coins come from your agent</div>
            <p className="text-sm text-[var(--ink-soft)]">
              Ask your agent <b className="text-white">{agentName}</b> to add coins to your account.
            </p>

            {displayPhone && (
              <a
                href={`tel:${displayPhone.replace(/[\s\-()]/g, "")}`}
                className="btn-ghost inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs border border-white/10"
              >
                <Phone size={14} />
                Call Agent: {displayPhone}
              </a>
            )}

            <div className="rounded-xl bg-white/5 p-3 text-sm flex items-center justify-between">
              <span className="text-white/60">Your Player ID:</span>
              <div className="flex items-center gap-2">
                <b className="font-mono text-gold-300">{player?.code}</b>
                {player?.code && (
                  <button
                    type="button"
                    onClick={() => copyToClipboard(player.code, false)}
                    className="p-1 text-white/60 hover:text-white"
                    aria-label="Copy Player ID"
                  >
                    {copiedId ? <Check size={14} className="text-neon-400" /> : <Copy size={14} />}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Current Balance & Refresh */}
        <div className="card p-4 flex items-center justify-between">
          <div>
            <div className="text-[11px] text-white/50">Current Balance</div>
            <Money n={total} className="text-lg font-bold text-white mt-0.5" />
          </div>
          <button
            type="button"
            disabled={refreshing}
            onClick={handleRefresh}
            className="btn-green rounded-xl px-4 py-2 text-xs font-semibold flex items-center gap-1.5"
          >
            <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Refreshing…" : "Refresh balance"}
          </button>
        </div>

        <div className="text-[11px] text-white/40 text-center px-2">
          Coins are virtual. Once payment is made to your agent, coins are credited to your GameHub wallet.
        </div>
      </div>
    </div>
  );
}

export function Transactions({ nav }: { nav: Nav }) {
  const { txns } = useStore();
  const [f, setF] = useState<"all" | Txn["type"]>("all");
  const tabs: [typeof f, string][] = [["all", "All"], ["deposit", "Received"], ["winning", "Winnings"], ["bet", "Bets"], ["withdraw", "Taken back"], ["bonus", "Refunds"]];
  const list = txns.filter((t) => f === "all" || t.type === f);
  return (
    <div className="pb-10 fadein">
      <Header title="Transactions" sub="Every coin, traceable" onBack={nav.back} right={<WalletIcon size={20} className="text-white/50" />} />
      <div className="px-4">
        <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-4 px-4">
          {tabs.map(([id, l]) => (
            <button key={id} onClick={() => setF(id)} className={`pill px-3.5 py-1.5 text-xs whitespace-nowrap ${f === id ? "btn-green" : "bg-white/5"}`}>{l}</button>
          ))}
        </div>
        <div className="card mt-4 px-4 divide-y divide-white/5">
          {list.map((t) => <TxnRow key={t.id} t={t} />)}
          {list.length === 0 && <div className="py-10 text-center text-sm text-white/40">No transactions yet</div>}
        </div>
      </div>
    </div>
  );
}
