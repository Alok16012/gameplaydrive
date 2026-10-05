"use client";

import { sfx, vibrate } from "../../lib/sound";
import { useCallback, useEffect, useRef, useState } from "react";
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

// The server answers each action with the finished state, so the table deals it out card by card, like a real
// dealer: player, dealer up-card, player, hole card; then each hit; then the hole card turns over and the dealer
// draws one card at a time. The result and the new balance only show once the last card is down.
interface Frame { dealer: Card[]; hands: Card[][]; hole: boolean; ms: number }

const cardValue = (r: string) => (r === "A" ? 11 : r === "K" || r === "Q" || r === "J" || r === "10" ? 10 : Number(r));
function count(cards: Card[]) {
  let t = 0, aces = 0;
  for (const c of cards) { const n = cardValue(c.r as string); t += n; if (n === 11) aces++; }
  while (t > 21 && aces) { t -= 10; aces--; }
  return t;
}

function plan(prev: View | null, next: View): Frame[] {
  const nh = next.hands ?? [], nd = next.dealer ?? [];
  const same = !!prev && prev.id === next.id && prev.status === "playing";
  const ph = same ? prev!.hands ?? [] : [];
  const split = same && nh.length > ph.length;
  let d: Card[] = same ? nd.slice(0, 1) : [];
  const hs: Card[][] = nh.map((h, i) => {
    if (!same) return [];
    if (split) return h.cards.slice(0, 1);
    let k = 0;
    const old = ph[i]?.cards ?? [];
    while (k < old.length && k < h.cards.length && old[k].r === h.cards[k].r && old[k].s === h.cards[k].s) k++;
    return h.cards.slice(0, k);
  });
  const out: Frame[] = [];
  const push = (hole: boolean, ms: number) => out.push({ dealer: [...d], hands: hs.map((h) => [...h]), hole, ms });
  if (!same) {
    nh.forEach((h, i) => { hs[i] = h.cards.slice(0, 1); });
    push(false, 0);
    d = nd.slice(0, 1);
    push(false, 550);
    nh.forEach((h, i) => { hs[i] = h.cards.slice(0, 2); });
    push(false, 550);
    push(true, 550);
  } else {
    push(true, 0);
  }
  nh.forEach((h, i) => {
    while (hs[i].length < h.cards.length) { hs[i] = h.cards.slice(0, hs[i].length + 1); push(true, 600); }
  });
  if (next.status === "done") {
    let first = true;
    while (d.length < nd.length) { d = nd.slice(0, d.length + 1); push(false, first ? 900 : 1000); first = false; }
  }
  return out;
}

export function Blackjack({ nav }: { nav: Nav }) {
  const { total, showToast, applyBalance } = useStore();
  const [v, setV] = useState<View | null>(null);
  const [bet, setBet] = useState(0);
  const [lastBet, setLastBet] = useState(0);
  const [busy, setBusy] = useState(false);

  const [anim, setAnim] = useState<Frame | null>(null);
  const seq = useRef(0);
  const vRef = useRef<View | null>(null);
  useEffect(() => () => { seq.current++; }, []);

  const take = useCallback((view: View, animate = false) => {
    const prev = vRef.current;
    vRef.current = view;
    setV(view);
    if (!animate) { setAnim(null); applyBalance(view.balance); return; }
    const frames = plan(prev, view);
    const tok = ++seq.current;
    let i = 0;
    const step = () => {
      if (seq.current !== tok) return;
      if (i >= frames.length) {
        setAnim(null);
        applyBalance(view.balance);
        if (view.status === "done") {
          const st = (view.hands ?? []).reduce((a, h) => a + h.bet, 0), pay = view.payout ?? 0;
          if (pay > st) { (view.hands ?? []).some((h) => h.result === "blackjack") ? sfx.bigWin() : sfx.win(); vibrate(50); }
          else if (pay < st) sfx.lose();
        }
        return;
      }
      const f = frames[i++], was = i > 1 ? frames[i - 2] : null;
      if (was && !f.hole && was.hole) sfx.flip(); else sfx.card();
      setAnim(f);
      window.setTimeout(step, i < frames.length ? frames[i].ms : view.status === "done" ? 700 : 250);
    };
    window.setTimeout(step, frames[0]?.ms ?? 0);
  }, [applyBalance]);

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
    take(data as View, true);
  };

  const deal = async (amount: number) => {
    if (amount < 10) return showToast("Minimum bet is 🪙 10");
    if (amount > total) return showToast("Not enough coins — ask your agent");
    setLastBet(amount);
    setBet(0);
    await call("bj_deal", { p_bet: amount });
  };

  const dealing = anim !== null;
  const playing = v?.status === "playing" || dealing;
  const done = v?.status === "done" && !dealing;
  const hands: Hand[] = anim
    ? (v?.hands ?? []).map((h, i) => ({ ...h, cards: anim.hands[i] ?? [], total: count(anim.hands[i] ?? []), result: undefined }))
    : v?.hands ?? [];
  const dealerCards = anim ? anim.dealer : v?.dealer ?? [];
  const holeDown = anim ? anim.hole : v?.status === "playing";
  const dealerTotal = anim ? count(anim.dealer) : v?.dealer_total;
  const staked = (v?.hands ?? []).reduce((a, h) => a + h.bet, 0);
  const locked = busy || dealing;

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
            {dealerCards.map((c, i) => (
              <PlayingCard key={i} card={c} size="lg" className="flip -ml-6 first:ml-0 shadow-xl" />
            ))}
            {holeDown && <PlayingCard faceDown size="lg" className="flip -ml-6 shadow-xl" />}
          </div>
          {dealerCards.length > 0 && <div className="text-center mt-1.5"><span className="pill px-2.5 py-0.5 text-[12px] bg-black/40">{dealerTotal}</span></div>}

          <div className="my-4 text-center text-[11px] text-gold-300/70 tracking-wide">BLACKJACK PAYS 3 TO 2 • DEALER STANDS ON ALL 17s</div>

          <div className={`grid gap-3 ${hands.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
            {hands.map((h, hi) => {
              const active = playing && !dealing && v?.active === hi && hands.length > 1;
              return (
                <div key={hi} className={`flex flex-col items-center rounded-2xl py-2 ${active ? "bg-white/10 ring-2 ring-gold-300/70" : ""}`}>
                  <div className="flex justify-center min-h-[90px]">
                    {h.cards.map((c, i) => (
                      <PlayingCard key={i} card={c} size={hands.length > 1 ? "md" : "lg"} className={`flip shadow-xl ${i ? (hands.length > 1 ? "-ml-7" : "-ml-6") : ""} ${h.doubled && i === 2 ? "rotate-90 ml-1" : ""}`} />
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1.5">
                    {h.cards.length > 0 && <span className="pill px-2.5 py-0.5 text-[12px] bg-black/40">{h.total}</span>}
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
            <button disabled={locked} onClick={() => call("bj_act", { p_action: "hit" })} className="btn-green rounded-2xl py-3.5 font-bold">HIT</button>
            <button disabled={locked} onClick={() => call("bj_act", { p_action: "stand" })} className="rounded-2xl py-3.5 font-bold bg-rose-600 active:scale-[.98] disabled:opacity-50">STAND</button>
            <button disabled={locked || !v?.can_double} onClick={() => call("bj_act", { p_action: "double" })} className="rounded-2xl py-3 font-bold bg-gradient-to-b from-amber-300 to-orange-500 text-slate-900 active:scale-[.98] disabled:opacity-35">DOUBLE</button>
            <button disabled={locked || !v?.can_split} onClick={() => call("bj_act", { p_action: "split" })} className="rounded-2xl py-3 font-bold bg-sky-600 active:scale-[.98] disabled:opacity-35">SPLIT</button>
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
