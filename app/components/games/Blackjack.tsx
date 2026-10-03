"use client";

import { useCallback, useEffect, useState } from "react";
import { inr, type Card } from "../../lib/data";
import { useStore } from "../../lib/store";
import { errText, supabase } from "../../lib/supabase";
import { Chip, Header, Money, PlayingCard } from "../ui";
import type { Nav } from "../nav";

// Blackjack against the dealer. The database shuffles six decks for every hand, keeps the shoe and the dealer's
// hole card to itself, plays the dealer and pays out (supabase/migrations/012_roulette_blackjack_plinko.sql).
// An unfinished hand is still there when you come back to this screen.

const CHIPS: { v: number; c: string }[] = [
  { v: 10, c: "#2563eb" },
  { v: 50, c: "#16a34a" },
  { v: 100, c: "#e11d48" },
  { v: 500, c: "#7c3aed" },
  { v: 1000, c: "#d97706" },
];

type Result = "blackjack" | "win" | "push" | "lose" | "bust";
interface Hand { cards: Card[]; bet: number; done: boolean; doubled: boolean; split: boolean; total: number; result?: Result; payout?: number }
interface View {
  status: "idle" | "playing" | "done";
  balance: number;
  id?: number;
  bet?: number;
  active?: number;
  payout?: number;
  dealer?: Card[];
  dealer_total?: number;
  hands?: Hand[];
  can_double?: boolean;
  can_split?: boolean;
}

const LABEL: Record<Result, { text: string; cls: string }> = {
  blackjack: { text: "Blackjack!", cls: "bg-gold-400 text-slate-900" },
  win: { text: "Win", cls: "bg-neon-500 text-slate-900" },
  push: { text: "Push", cls: "bg-sky-500" },
  lose: { text: "Lose", cls: "bg-rose-600" },
  bust: { text: "Bust", cls: "bg-rose-600" },
};

export function Blackjack({ nav }: { nav: Nav }) {
  const { total, showToast, applyBalance } = useStore();
  const [v, setV] = useState<View | null>(null);
  const [bet, setBet] = useState(0);
  const [lastBet, setLastBet] = useState(0);
  const [busy, setBusy] = useState(false);

  const take = useCallback((view: View) => { setV(view); applyBalance(view.balance); }, [applyBalance]);

  useEffect(() => {
    supabase().rpc("bj_state").then(({ data, error }) => {
      if (error) showToast(errText(error));
      else take(data as View);
    });
  }, [take, showToast]);

  const call = async (fn: "bj_deal" | "bj_act", args: Record<string, unknown>) => {
    setBusy(true);
    const { data, error } = await supabase().rpc(fn, args);
    setBusy(false);
    if (error) { showToast(errText(error)); return; }
    take(data as View);
  };

  const deal = async (amount: number) => {
    if (amount < 10) return showToast("Minimum bet is 🪙 10");
    if (amount > total) return showToast("Not enough coins — ask your agent");
    setLastBet(amount);
    setBet(0);
    await call("bj_deal", { p_bet: amount });
  };

  const playing = v?.status === "playing";
  const done = v?.status === "done";
  const hands = v?.hands ?? [];
  const staked = hands.reduce((a, h) => a + h.bet, 0);

  return (
    <div className="pb-6 fadein min-h-dvh flex flex-col">
      <Header
        title="Blackjack"
        sub="Blackjack pays 3:2 • Dealer stands on 17 • Min 🪙 10 • Max 🪙 10,000"
        onBack={nav.back}
        right={<div className="text-right"><div className="text-[10px] text-white/50">Balance</div><Money n={total - (playing ? 0 : bet)} className="text-sm font-semibold text-neon-400" /></div>}
      />

      <div className="px-4">
        {/* Table */}
        <div className="rounded-[28px] felt p-4 relative overflow-hidden" style={{ minHeight: 360 }}>
          <div className="text-center text-[10px] tracking-[0.3em] text-white/40 uppercase">Dealer</div>
          <div className="flex justify-center mt-2 min-h-[90px]">
            {(v?.dealer ?? []).map((c, i) => (
              <PlayingCard key={i} card={c} size="lg" className="flip -ml-6 first:ml-0 shadow-xl" style={{ animationDelay: `${i * 0.12}s` }} />
            ))}
            {playing && <PlayingCard faceDown size="lg" className="-ml-6" />}
          </div>
          {v?.dealer && <div className="text-center mt-1.5"><span className="pill px-2.5 py-0.5 text-[12px] bg-black/40">{v.dealer_total}</span></div>}

          <div className="my-4 text-center text-[11px] text-gold-300/70 tracking-wide">BLACKJACK PAYS 3 TO 2 • DEALER STANDS ON ALL 17s</div>

          <div className={`grid gap-3 ${hands.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
            {hands.map((h, hi) => {
              const active = playing && v?.active === hi && hands.length > 1;
              return (
                <div key={hi} className={`flex flex-col items-center rounded-2xl py-2 ${active ? "bg-white/10 ring-2 ring-gold-300/70" : ""}`}>
                  <div className="flex justify-center min-h-[90px]">
                    {h.cards.map((c, i) => (
                      <PlayingCard key={i} card={c} size={hands.length > 1 ? "md" : "lg"} className={`flip shadow-xl ${i ? (hands.length > 1 ? "-ml-7" : "-ml-6") : ""} ${h.doubled && i === 2 ? "rotate-90 ml-1" : ""}`} style={{ animationDelay: `${i * 0.12}s` }} />
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <span className="pill px-2.5 py-0.5 text-[12px] bg-black/40">{h.total}</span>
                    {h.result && <span className={`pill pop px-2.5 py-0.5 text-[12px] font-semibold ${LABEL[h.result].cls}`}>{LABEL[h.result].text}</span>}
                  </div>
                  <div className="text-[11px] text-white/60 mt-1">{inr(h.bet)}{h.doubled ? " • doubled" : ""}</div>
                </div>
              );
            })}
            {!hands.length && <div className="text-center text-white/45 text-sm py-10">Pick your chips and press Deal</div>}
          </div>
        </div>

        <div className="mt-3 text-center text-sm h-6">
          {done && (
            <span className={`pop inline-block font-semibold ${(v?.payout ?? 0) > staked ? "text-neon-400" : (v?.payout ?? 0) === staked ? "text-sky-300" : "text-rose-400"}`}>
              {(v?.payout ?? 0) > staked ? `🎉 You won ${inr(v!.payout! - staked)}!` : (v?.payout ?? 0) === staked ? "Push — bet returned" : "Dealer wins"}
            </span>
          )}
          {!playing && !done && bet > 0 && <span className="text-white/70">Your bet: <b className="text-white">{inr(bet)}</b></span>}
        </div>

        {playing ? (
          <div className="grid grid-cols-2 gap-2.5 mt-3">
            <button disabled={busy} onClick={() => call("bj_act", { p_action: "hit" })} className="btn-green rounded-2xl py-3.5 font-bold">HIT</button>
            <button disabled={busy} onClick={() => call("bj_act", { p_action: "stand" })} className="rounded-2xl py-3.5 font-bold bg-rose-600 active:scale-[.98] disabled:opacity-50">STAND</button>
            <button disabled={busy || !v?.can_double} onClick={() => call("bj_act", { p_action: "double" })} className="rounded-2xl py-3 font-bold bg-gradient-to-b from-amber-300 to-orange-500 text-slate-900 active:scale-[.98] disabled:opacity-35">DOUBLE</button>
            <button disabled={busy || !v?.can_split} onClick={() => call("bj_act", { p_action: "split" })} className="rounded-2xl py-3 font-bold bg-sky-600 active:scale-[.98] disabled:opacity-35">SPLIT</button>
          </div>
        ) : (
          <>
            <div className="flex justify-between items-center mt-3 px-1">
              {CHIPS.map((c) => (
                <Chip
                  key={c.v}
                  value={c.v >= 1000 ? "1K" : c.v}
                  color={c.c}
                  size={50}
                  onClick={() => {
                    if (bet + c.v > 10000) return showToast("Max bet is 🪙 10,000");
                    if (bet + c.v > total) return showToast("Not enough coins — ask your agent");
                    setBet(bet + c.v);
                  }}
                />
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2 mt-4">
              <button disabled={!bet} onClick={() => setBet(0)} className="btn-ghost rounded-xl py-2.5 text-xs disabled:opacity-40">Clear</button>
              <button disabled={!lastBet || busy} onClick={() => deal(lastBet)} className="btn-ghost rounded-xl py-2.5 text-xs disabled:opacity-40">Rebet {lastBet ? inr(lastBet) : ""}</button>
            </div>
            <button disabled={busy || !bet} onClick={() => deal(bet)} className="w-full btn-green rounded-2xl py-3.5 mt-3 font-bold text-lg disabled:opacity-50">
              {bet ? `DEAL • ${inr(bet)}` : "Tap chips to bet"}
            </button>
          </>
        )}
        <div className="text-center text-[12px] text-white/35 mt-3">Six decks, shuffled by the server for every hand. Split one pair once; split aces get one card each.</div>
      </div>
    </div>
  );
}
