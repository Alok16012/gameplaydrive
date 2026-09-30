"use client";

import { useState } from "react";
import { ArrowDownLeft, Eye, EyeOff, Gift, Info, Plus, ReceiptText, Trophy, Wallet as WalletIcon } from "lucide-react";
import { inr, type Txn } from "../../lib/data";
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

/** "Get coins" — there is no payment: coins are handed out by the player's agent. */
export function AddCash({ nav }: { nav: Nav }) {
  const { player, refresh, total, showToast } = useStore();
  return (
    <div className="pb-10 fadein">
      <Header title="Get Coins" onBack={nav.back} />
      <div className="px-4">
        <div className="card p-5 text-center">
          <div className="text-5xl">🪙</div>
          <div className="text-lg font-semibold mt-3">Coins come from your agent</div>
          <div className="text-sm text-[var(--ink-soft)] mt-1">
            {player?.agent ? <>Ask <b className="text-white">{player.agent}</b> to add coins to your account.</> : "Ask the person who created your account to add coins."}
          </div>
          <div className="mt-4 rounded-xl bg-white/5 p-3 text-sm">Your player ID: <b>{player?.code}</b></div>
          <div className="text-xs text-white/50 mt-2">Current balance: <Money n={total} /></div>
          <button onClick={async () => { await refresh(); showToast("Balance updated"); }} className="btn-green w-full py-3 rounded-2xl mt-5">Refresh balance</button>
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
