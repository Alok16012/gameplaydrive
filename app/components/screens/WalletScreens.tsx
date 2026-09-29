"use client";

import { useState } from "react";
import { ArrowDownLeft, Building2, CheckCircle2, CreditCard, Eye, EyeOff, Gift, Info, Plus, ReceiptText, Smartphone, Trophy, Wallet as WalletIcon } from "lucide-react";
import { USER, inr, type Txn } from "../../lib/data";
import { useStore } from "../../lib/store";
import { Header, Money } from "../ui";
import type { Nav } from "../nav";

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
  const { wallet, total, txns, hidden, toggleHidden } = useStore();
  return (
    <div className="pb-28 fadein">
      <Header title="Wallet" onBack={() => nav.reset({ name: "home" })} />
      <div className="px-4">
        <div className="balance-card p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm text-white/80">Total Balance</div>
            <button onClick={toggleHidden} aria-label="Toggle balance">{hidden ? <EyeOff size={20} /> : <Eye size={20} />}</button>
          </div>
          <Money n={total} className="block text-[30px] font-semibold mt-0.5" />
          <div className="grid grid-cols-3 gap-2 mt-4">
            {[
              ["Deposit Cash", wallet.deposit, "#4ade80"],
              ["Winning Cash", wallet.winning, "#93c5fd"],
              ["Bonus / Promo", wallet.bonus, "#f0abfc"],
            ].map(([l, n, c]) => (
              <div key={l as string} className="rounded-xl bg-black/20 p-2.5">
                <div className="text-[10px] flex items-center gap-1" style={{ color: c as string }}><span className="w-2 h-2 rounded-full" style={{ background: c as string }} />{l}</div>
                <Money n={n as number} className="block text-base font-semibold mt-1" />
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 mt-5">
          {[
            ["Add Cash", <Plus key="a" size={20} strokeWidth={3} />, () => nav.push({ name: "addcash" }), true],
            ["Withdraw", <ArrowDownLeft key="w" size={20} />, () => nav.push({ name: "withdraw" }), false],
            ["Transactions", <ReceiptText key="t" size={20} />, () => nav.push({ name: "txns" }), false],
          ].map(([label, icon, fn, primary]) => (
            <button key={label as string} onClick={fn as () => void} className="flex flex-col items-center gap-2 text-xs font-medium">
              <span className={`w-12 h-12 rounded-full grid place-items-center ${primary ? "btn-green" : "btn-ghost"}`}>{icon as React.ReactNode}</span>
              {label as string}
            </button>
          ))}
        </div>

        <div className="card mt-5 px-4 pt-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Recent Transactions</div>
            <button onClick={() => nav.push({ name: "txns" })} className="text-xs text-neon-400">View All</button>
          </div>
          <div className="divide-y divide-white/5">{txns.slice(0, 5).map((t) => <TxnRow key={t.id} t={t} />)}</div>
        </div>

        <div className="mt-4 flex gap-2 text-[11px] text-white/45 px-1">
          <Info size={14} className="shrink-0 mt-0.5" />
          Entry fees use Bonus first (max 10% of entry), then Deposit Cash, then Winning Cash. Only Winning Cash can be withdrawn.
        </div>
      </div>
    </div>
  );
}

export function AddCash({ nav }: { nav: Nav }) {
  const { deposit, showToast, limits } = useStore();
  const [amt, setAmt] = useState(500);
  const [method, setMethod] = useState("UPI");
  const [stage, setStage] = useState<"form" | "paying" | "done">("form");
  const bonus = Math.min(Math.round(amt * 0.1), 500);
  const overLimit = amt > limits.deposit;

  const pay = () => {
    setStage("paying");
    setTimeout(() => {
      deposit(amt, method, bonus);
      setStage("done");
      showToast(`${inr(amt)} added to wallet`);
    }, 1600);
  };

  if (stage === "done")
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center px-6 text-center fadein">
        <div className="pop"><CheckCircle2 size={84} className="text-neon-400" /></div>
        <div className="text-2xl font-semibold mt-4">Payment Successful</div>
        <div className="text-[var(--ink-soft)] mt-1">{inr(amt)} added to Deposit Cash</div>
        {bonus > 0 && <div className="mt-3 pill px-3 py-1 text-xs bg-fuchsia-500/15 text-fuchsia-300">+ {inr(bonus)} bonus credited</div>}
        <div className="text-[11px] text-white/40 mt-6">Txn ID: GH{Date.now().toString().slice(-10)}</div>
        <button onClick={() => nav.reset({ name: "home" })} className="btn-green w-full py-3.5 rounded-2xl mt-8">Start Playing</button>
        <button onClick={nav.back} className="text-sm text-white/60 mt-4">Back to Wallet</button>
      </div>
    );

  return (
    <div className="pb-32 fadein">
      <Header title="Add Cash" onBack={nav.back} />
      <div className="px-4">
        <div className="card p-5 text-center">
          <div className="text-xs text-[var(--ink-soft)]">Enter amount</div>
          <div className="flex items-center justify-center mt-1 text-4xl font-semibold">
            ₹
            <input value={amt || ""} inputMode="numeric" onChange={(e) => setAmt(Number(e.target.value.replace(/\D/g, "").slice(0, 6)))} className="bg-transparent outline-none w-40 text-center" />
          </div>
          <div className="flex gap-2 justify-center mt-4">
            {[100, 500, 1000, 2000].map((v) => (
              <button key={v} onClick={() => setAmt(v)} className={`pill px-3.5 py-1.5 text-xs ${amt === v ? "btn-green" : "bg-white/5"}`}>₹{v}</button>
            ))}
          </div>
        </div>

        <div className="mt-4 rounded-2xl p-3.5 flex items-center gap-3 border border-fuchsia-400/20" style={{ background: "linear-gradient(90deg,rgba(192,38,211,.18),rgba(91,33,182,.12))" }}>
          <Gift className="text-fuchsia-300" />
          <div className="flex-1 text-sm">Get <b>{inr(bonus)}</b> bonus<div className="text-[11px] text-white/50">10% extra on every deposit, up to ₹500</div></div>
        </div>

        <div className="text-sm font-semibold mt-6 mb-2">Payment method</div>
        <div className="card divide-y divide-white/5">
          {[
            ["UPI", "GPay, PhonePe, Paytm & more", <Smartphone key="u" size={20} />],
            ["NetBanking", "All major banks", <Building2 key="n" size={20} />],
            ["Card", "Debit / Credit card", <CreditCard key="c" size={20} />],
          ].map(([id, sub, icon]) => (
            <button key={id as string} onClick={() => setMethod(id as string)} className="w-full flex items-center gap-3 p-3.5 text-left">
              <span className="w-10 h-10 rounded-xl bg-white/5 grid place-items-center">{icon as React.ReactNode}</span>
              <div className="flex-1"><div className="text-sm font-medium">{id as string}</div><div className="text-[11px] text-[var(--ink-soft)]">{sub as string}</div></div>
              <span className={`w-5 h-5 rounded-full border-2 grid place-items-center ${method === id ? "border-neon-400" : "border-white/25"}`}>{method === id && <span className="w-2.5 h-2.5 rounded-full bg-neon-400" />}</span>
            </button>
          ))}
        </div>
        {overLimit && <div className="mt-3 text-xs text-rose-400">This exceeds your daily deposit limit of {inr(limits.deposit)} (Responsible Gaming).</div>}
      </div>
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] p-4 bg-[#080c26]/95 border-t border-white/5">
        <button disabled={amt < 10 || overLimit || stage === "paying"} onClick={pay} className="btn-green w-full py-3.5 rounded-2xl">
          {stage === "paying" ? "Processing payment…" : `Add ${inr(amt)}`}
        </button>
        <div className="text-center text-[10px] text-white/40 mt-2">Demo mode — no real payment is made</div>
      </div>
    </div>
  );
}

export function Withdraw({ nav }: { nav: Nav }) {
  const { wallet, withdraw, showToast } = useStore();
  const [amt, setAmt] = useState(Math.min(500, Math.floor(wallet.winning)));
  const [to, setTo] = useState<"bank" | "upi">("bank");
  const [done, setDone] = useState(false);
  const over = amt > wallet.winning;

  if (done)
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center px-6 text-center fadein">
        <div className="pop w-20 h-20 rounded-full bg-gold-400/15 grid place-items-center"><ArrowDownLeft size={40} className="text-gold-400" /></div>
        <div className="text-2xl font-semibold mt-4">Withdrawal Requested</div>
        <div className="text-[var(--ink-soft)] mt-1">{inr(amt)} to {to === "bank" ? USER.bank : USER.upi}</div>
        <div className="text-xs text-white/50 mt-2">Usually credited within 30 minutes. Large withdrawals may need admin approval.</div>
        <button onClick={() => nav.reset({ name: "wallet" })} className="btn-green w-full py-3.5 rounded-2xl mt-8">Done</button>
      </div>
    );

  return (
    <div className="pb-32 fadein">
      <Header title="Withdraw" onBack={nav.back} />
      <div className="px-4">
        <div className="card p-4 flex items-center justify-between">
          <div>
            <div className="text-xs text-[var(--ink-soft)]">Withdrawable (Winning Cash)</div>
            <Money n={wallet.winning} className="block text-2xl font-semibold mt-0.5" />
          </div>
          <span className="pill px-2.5 py-1 text-[10px] bg-neon-400/15 text-neon-400 flex items-center gap-1"><CheckCircle2 size={12} /> KYC Verified</span>
        </div>
        <div className="card p-5 text-center mt-4">
          <div className="text-xs text-[var(--ink-soft)]">Withdraw amount</div>
          <div className="flex items-center justify-center mt-1 text-4xl font-semibold">
            ₹
            <input value={amt || ""} inputMode="numeric" onChange={(e) => setAmt(Number(e.target.value.replace(/\D/g, "").slice(0, 6)))} className="bg-transparent outline-none w-40 text-center" />
          </div>
          <button onClick={() => setAmt(Math.floor(wallet.winning))} className="text-xs text-neon-400 mt-2">Withdraw all</button>
          {over && <div className="text-xs text-rose-400 mt-2">Amount is more than your Winning Cash.</div>}
        </div>
        <div className="text-sm font-semibold mt-6 mb-2">Send to</div>
        <div className="card divide-y divide-white/5">
          {([["bank", USER.bank, "IMPS • instant", <Building2 key="b" size={20} />], ["upi", USER.upi, "UPI • instant", <Smartphone key="u" size={20} />]] as const).map(([id, label, sub, icon]) => (
            <button key={id} onClick={() => setTo(id)} className="w-full flex items-center gap-3 p-3.5 text-left">
              <span className="w-10 h-10 rounded-xl bg-white/5 grid place-items-center">{icon}</span>
              <div className="flex-1"><div className="text-sm font-medium">{label}</div><div className="text-[11px] text-[var(--ink-soft)]">{sub}</div></div>
              <span className={`w-5 h-5 rounded-full border-2 grid place-items-center ${to === id ? "border-neon-400" : "border-white/25"}`}>{to === id && <span className="w-2.5 h-2.5 rounded-full bg-neon-400" />}</span>
            </button>
          ))}
        </div>
        <div className="mt-3 flex gap-2 text-[11px] text-white/45"><Info size={14} className="shrink-0 mt-0.5" />TDS is deducted on net winnings as per government rules.</div>
      </div>
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] p-4 bg-[#080c26]/95 border-t border-white/5">
        <button
          disabled={amt < 100 || over}
          onClick={() => { if (withdraw(amt)) { setDone(true); showToast("Withdrawal requested"); } }}
          className="btn-green w-full py-3.5 rounded-2xl"
        >
          Withdraw {inr(amt)}
        </button>
        <div className="text-center text-[10px] text-white/40 mt-2">Minimum ₹100</div>
      </div>
    </div>
  );
}

export function Transactions({ nav }: { nav: Nav }) {
  const { txns } = useStore();
  const [f, setF] = useState<"all" | Txn["type"]>("all");
  const tabs: [typeof f, string][] = [["all", "All"], ["deposit", "Deposits"], ["winning", "Winnings"], ["bet", "Bets"], ["withdraw", "Withdrawals"], ["bonus", "Bonus"]];
  const list = txns.filter((t) => f === "all" || t.type === f);
  return (
    <div className="pb-10 fadein">
      <Header title="Transactions" sub="Every rupee, traceable" onBack={nav.back} right={<WalletIcon size={20} className="text-white/50" />} />
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
