"use client";

import { REJOIN_MS, clearActive, markActive } from "../../lib/rejoin";
import { sfx } from "../../lib/sound";
import { useCallback, useEffect, useRef, useState } from "react";
import { Undo2, ListOrdered } from "lucide-react";
import { inr, type Card } from "../../lib/data";
import { useStore } from "../../lib/store";
import { errText, supabase } from "../../lib/supabase";
import { Chip, Header, Money, PlayingCard, Sheet } from "../ui";
import type { Nav } from "../nav";

// Blackjack against the dealer. The database shuffles six decks for every hand, keeps the shoe and the dealer's
// hole card to itself, plays the dealer and pays out (supabase/migrations/012_roulette_blackjack_plinko.sql).
// Side bets — Perfect Pairs, 21+3, Hot 3 (settled on the deal) and Bust It (settled when the dealer is done) — sit
// around the main bet like Infinite Blackjack (071_blackjack_infinite_side_bets.sql).
// An unfinished hand is still there when you come back to this screen.

const CHIPS: { v: number; c: string }[] = [
  { v: 10, c: "#2563eb" },
  { v: 50, c: "#16a34a" },
  { v: 100, c: "#e11d48" },
  { v: 500, c: "#7c3aed" },
  { v: 1000, c: "#d97706" },
];
const MAIN_MAX = 10000;
const SIDE_MAX = 10000;

type Result = "blackjack" | "win" | "push" | "lose" | "bust";
interface Hand { cards: Card[]; bet: number; done: boolean; doubled: boolean; split: boolean; total: number; result?: Result; payout?: number }
interface SideResult { bet: number; pay?: number; pending?: boolean; hit?: { name: string; x: number } }
type Side = "pp" | "t3" | "h3" | "bi";
type Spot = "main" | Side;
const SIDES: Side[] = ["t3", "pp", "h3", "bi"];
const NONE: Record<Spot, number> = { main: 0, pp: 0, t3: 0, h3: 0, bi: 0 };
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
  side?: Partial<Record<Side, SideResult>>;
}

const SIDE_INFO: Record<Side, { label: string; odds: string }> = {
  t3: { label: "21+3", odds: "up to 100:1" },
  pp: { label: "PERFECT PAIRS", odds: "up to 25:1" },
  h3: { label: "HOT 3", odds: "up to 100:1" },
  bi: { label: "BUST IT", odds: "up to 250:1" },
};

const LABEL: Record<Result, { text: string; cls: string }> = {
  blackjack: { text: "Blackjack!", cls: "bg-gold-400 text-slate-900" },
  win: { text: "Win", cls: "bg-neon-500 text-slate-900" },
  push: { text: "Push", cls: "bg-sky-500" },
  lose: { text: "Lose", cls: "bg-rose-600" },
  bust: { text: "Bust", cls: "bg-rose-600" },
};

// Payouts & Limits (the table card), shown from the sheet.
const PAYOUTS: { title: string; limit: string; rows: [string, string][] }[] = [
  { title: "Blackjack", limit: "🪙 10 – 10,000", rows: [["Blackjack", "3:2"], ["Winning hand", "1:1"], ["Push", "Bet back"]] },
  { title: "Hot 3", limit: "🪙 10 – main bet", rows: [["7-7-7", "100:1"], ["Total 21 suited", "20:1"], ["Total 21 unsuited", "4:1"], ["Total 20", "2:1"], ["Total 19", "1:1"]] },
  { title: "21+3", limit: "🪙 10 – main bet", rows: [["Suited trips", "100:1"], ["Straight flush", "40:1"], ["Three of a kind", "25:1"], ["Straight", "10:1"], ["Flush", "5:1"]] },
  { title: "Perfect Pairs", limit: "🪙 10 – main bet", rows: [["Perfect pair (same suit)", "25:1"], ["Coloured pair", "12:1"], ["Mixed pair", "6:1"]] },
  { title: "Bust It", limit: "🪙 10 – main bet", rows: [["Dealer busts with 8+ cards", "250:1"], ["Bust with 7 cards", "100:1"], ["Bust with 6 cards", "50:1"], ["Bust with 5 cards", "9:1"], ["Bust with 4 cards", "2:1"], ["Bust with 3 cards", "1:1"]] },
];

// The server answers each action with the finished state, so the table deals it out card by card, like a real
// dealer: player, dealer up-card, player, hole card; then each hit; then the hole card turns over and the dealer
// draws one card at a time. The result and the new balance only show once the last card is down.
interface Frame { dealer: Card[]; hands: Card[][]; hole: boolean; ms: number }

/**
 * Fills the space it is given and scales its content down (never up) so all of it shows without scrolling — the
 * table keeps its layout on any phone and the buttons below stay in view. Content shorter than the space is centred.
 */
function FitBox({ children }: { children: React.ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, s: 1, top: 0 });
  useEffect(() => {
    const o = outer.current, i = inner.current;
    if (!o || !i) return;
    const measure = () => {
      const w = o.clientWidth, h = o.clientHeight;
      if (!w || !h) return;
      setBox((b) => {
        // height of the content laid out at the width it currently has (w / scale), back in screen pixels
        const need = i.scrollHeight;
        const s = Math.min(1, h / (need || 1));
        const top = Math.max(0, (h - need * s) / 2);
        return Math.abs(b.s - s) < 0.004 && Math.abs(b.w - w) < 1 && Math.abs(b.top - top) < 1 ? b : { w, s, top };
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(o);
    ro.observe(i);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={outer} className="relative flex-1 min-h-0 overflow-hidden">
      <div
        ref={inner}
        className="absolute left-0 top-0 flex flex-col origin-top-left"
        style={{ width: box.w ? box.w / box.s : "100%", transform: `translateY(${box.top}px) scale(${box.s})` }}
      >
        {children}
      </div>
    </div>
  );
}

/** Phones and short windows: smaller cards and betting circles so the whole table and the action buttons fit on one
 *  screen without scrolling (an iPhone is 852px tall; the full-size table needs about 900). */
function useCompact(): { compact: boolean; tight: boolean } {
  const [m, setM] = useState({ compact: false, tight: false });
  useEffect(() => {
    const c = window.matchMedia("(max-height: 900px), (max-width: 420px)");
    const t = window.matchMedia("(max-height: 800px)");
    const on = () => setM({ compact: c.matches, tight: t.matches });
    on();
    c.addEventListener("change", on);
    t.addEventListener("change", on);
    return () => { c.removeEventListener("change", on); t.removeEventListener("change", on); };
  }, []);
  return m;
}
const DEAL_MS = 850;    // each card of the opening deal
const HIT_MS = 800;     // a card you asked for
const REVEAL_MS = 1200; // the dealer turns the hole card
const DRAW_MS = 1300;   // each card the dealer draws
const END_MS = 900;     // pause before the result

const cardValue = (r: string) => (r === "A" ? 11 : r === "K" || r === "Q" || r === "J" || r === "10" ? 10 : Number(r));
function count(cards: Card[]) {
  let t = 0, aces = 0;
  for (const c of cards) { const n = cardValue(c.r as string); t += n; if (n === 11) aces++; }
  while (t > 21 && aces) { t -= 10; aces--; }
  return t;
}

const sidePay = (v: View) => SIDES.reduce((a, k) => a + (v.side?.[k]?.pay ?? 0), 0);
const sum = (st: Record<Spot, number>) => st.main + st.pp + st.t3 + st.h3 + st.bi;

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
    push(false, DEAL_MS);
    nh.forEach((h, i) => { hs[i] = h.cards.slice(0, 2); });
    push(false, DEAL_MS);
    push(true, DEAL_MS);
  } else {
    push(true, 0);
  }
  nh.forEach((h, i) => {
    while (hs[i].length < h.cards.length) { hs[i] = h.cards.slice(0, hs[i].length + 1); push(true, HIT_MS); }
  });
  if (next.status === "done") {
    let first = true;
    while (d.length < nd.length) { d = nd.slice(0, d.length + 1); push(false, first ? REVEAL_MS : DRAW_MS); first = false; }
  }
  return out;
}

export function Blackjack({ nav }: { nav: Nav }) {
  const { total, showToast, applyBalance, holdWinnings } = useStore();
  const [v, setV] = useState<View | null>(null);
  const [chip, setChip] = useState(100);
  const [stakes, setStakes] = useState<Record<Spot, number>>(NONE);
  const [history, setHistory] = useState<Record<Spot, number>[]>([]); // for Undo
  const [lastStakes, setLastStakes] = useState<Record<Spot, number> | null>(null);
  const [busy, setBusy] = useState(false);
  const [payouts, setPayouts] = useState(false);

  const [anim, setAnim] = useState<Frame | null>(null);
  const seq = useRef(0);
  const vRef = useRef<View | null>(null);
  useEffect(() => () => { seq.current++; }, []);

  const take = useCallback((view: View, animate = false) => {
    const prev = vRef.current;
    vRef.current = view;
    setV(view);
    // Rejoin: an unfinished hand stays on the server; offer it on Home until it is settled.
    if (view.status === "playing") markActive({ name: "blackjack" }, `Blackjack • hand of 🪙 ${view.bet ?? ""} in play`, REJOIN_MS.blackjack);
    else clearActive({ name: "blackjack" });
    if (!animate) { setAnim(null); applyBalance(view.balance); return; }
    const frames = plan(prev, view);
    // The stake leaves at once; whatever this action paid (side bets, the hand) shows when the last card is down.
    const before = prev && prev.id === view.id ? (prev.payout ?? 0) + sidePay(prev) : 0;
    const release = holdWinnings((view.payout ?? 0) + sidePay(view) - before, 30000);
    applyBalance(view.balance);
    const tok = ++seq.current;
    let i = 0;
    const step = () => {
      if (seq.current !== tok) return;
      if (i >= frames.length) {
        setAnim(null);
        release();
        if (view.status === "done") {
          const st = (view.hands ?? []).reduce((a, h) => a + h.bet, 0), pay = (view.payout ?? 0) + (view.side?.bi?.pay ?? 0);
          if (pay > st + (view.side?.bi?.bet ?? 0)) { (view.hands ?? []).some((h) => h.result === "blackjack") ? sfx.bigWin() : sfx.win(); }
          else if (pay < st) sfx.lose();
        }
        return;
      }
      const f = frames[i++], was = i > 1 ? frames[i - 2] : null;
      if (was && !f.hole && was.hole) sfx.flip(); else sfx.card();
      setAnim(f);
      window.setTimeout(step, i < frames.length ? frames[i].ms : view.status === "done" ? END_MS : 250);
    };
    window.setTimeout(step, frames[0]?.ms ?? 0);
  }, [applyBalance, holdWinnings]);

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

  const bet = sum(stakes);
  const dealing = anim !== null;
  const playing = v?.status === "playing" || dealing;
  const done = v?.status === "done" && !dealing;
  const betting = !playing;

  /** Check a would-be stake layout; returns the problem, or null. */
  const problem = (next: Record<Spot, number>): string | null => {
    if (next.main > MAIN_MAX) return `Max bet is ${inr(MAIN_MAX)}`;
    if (SIDES.some((k) => next[k] > SIDE_MAX)) return `Max side bet is ${inr(SIDE_MAX)}`;
    if (sum(next) > total) return "Not enough coins — ask your agent";
    return null;
  };
  const apply = (next: Record<Spot, number>) => {
    const p = problem(next);
    if (p) return showToast(p);
    sfx.chip();
    setHistory((h) => [...h.slice(-30), stakes]);
    setStakes(next);
  };
  const place = (spot: Spot) => {
    if (!betting) return;
    apply({ ...stakes, [spot]: stakes[spot] + chip });
  };
  const allSides = () => {
    if (!betting) return;
    const next = { ...stakes };
    for (const k of SIDES) next[k] += chip;
    apply(next);
  };
  const doubleAll = () => {
    if (!betting || !bet) return;
    const next = { ...stakes };
    for (const k of Object.keys(next) as Spot[]) next[k] *= 2;
    apply(next);
  };
  const undo = () => {
    if (!betting || !history.length) return;
    setStakes(history[history.length - 1]);
    setHistory((h) => h.slice(0, -1));
  };
  const clear = () => { setStakes(NONE); setHistory([]); };

  const deal = async (st: Record<Spot, number>) => {
    if (st.main < 10) return showToast("Put at least 🪙 10 on the main bet");
    const sideOver = SIDES.find((k) => st[k] > st.main);
    if (sideOver) return showToast(`${SIDE_INFO[sideOver].label} can't be more than your main bet`);
    const sideLow = SIDES.find((k) => st[k] > 0 && st[k] < 10);
    if (sideLow) return showToast("Side bets start at 🪙 10");
    if (sum(st) > total) return showToast("Not enough coins — ask your agent");
    setLastStakes(st);
    clear();
    // All five amounts name the Infinite-style bj_deal (071) unambiguously.
    await call("bj_deal", { p_bet: st.main, p_pp: st.pp, p_t3: st.t3, p_h3: st.h3, p_bi: st.bi });
  };

  const hands: Hand[] = anim
    ? (v?.hands ?? []).map((h, i) => ({ ...h, cards: anim.hands[i] ?? [], total: count(anim.hands[i] ?? []), result: undefined }))
    : v?.hands ?? [];
  const dealerCards = anim ? anim.dealer : v?.dealer ?? [];
  const holeDown = anim ? anim.hole : v?.status === "playing";
  const dealerTotal = anim ? count(anim.dealer) : v?.dealer_total;
  const staked = (v?.hands ?? []).reduce((a, h) => a + h.bet, 0);
  const locked = busy || dealing;

  // Side-bet results show once the opening deal is on the table (Bust It once the dealer is done), and stay until
  // you start the next bet.
  const opened = !anim || (anim.hands[0]?.length ?? 0) >= 2 && anim.dealer.length >= 1;
  const side = v?.side && opened && (playing || (done && bet === 0)) ? v.side : undefined;
  const sideShown = (k: Side): SideResult | undefined => {
    const r = side?.[k];
    if (!r) return undefined;
    if (k === "bi" && (r.pending || dealing)) return { ...r, pending: true };
    return r;
  };
  const sideKey = side ? `${v?.id}:${v?.status}` : "";
  const sideSeen = useRef("");
  useEffect(() => {
    if (!sideKey || sideSeen.current === sideKey || !side || dealing) return;
    sideSeen.current = sideKey;
    const paid = SIDES.reduce((a, k) => a + (side[k]?.pay ?? 0), 0);
    if (paid > 0) sfx.win();
  }, [sideKey, side, dealing]);

  const shown = (spot: Spot): number =>
    betting && bet > 0 ? stakes[spot] : spot === "main" ? (playing || done ? v?.bet ?? 0 : 0) : (playing || done ? (v?.side?.[spot]?.bet ?? 0) : 0);

  const net = (v?.payout ?? 0) + (v?.side?.bi?.pay ?? 0) - staked - (v?.side?.bi?.bet ?? 0);
  const { compact, tight } = useCompact();
  const cardSize = tight ? "md" : "lg";
  const cardRow = tight ? "min-h-[74px]" : "min-h-[96px]";
  const spotPos: Record<Spot, React.CSSProperties> = tight
    ? {
        t3: { left: "14%", top: 0 },
        pp: { right: "14%", top: 0 },
        main: { left: "50%", top: 36, transform: "translateX(-50%)" },
        h3: { left: 0, top: 78 },
        bi: { right: 0, top: 78 },
      }
    : {
        t3: { left: "14%", top: 0 },
        pp: { right: "14%", top: 0 },
        main: { left: "50%", top: 46, transform: "translateX(-50%)" },
        h3: { left: 0, top: 96 },
        bi: { right: 0, top: 96 },
      };

  return (
    <div className="pb-3 fadein h-dvh flex flex-col overflow-hidden">
      <Header
        title="Blackjack"
        sub="Pays 3:2 • Dealer stands on 17 • Four side bets"
        onBack={nav.back}
        right={<div className="text-right"><div className="text-[10px] text-white/50">Balance</div><Money n={total - (betting ? bet : 0)} className="text-sm font-semibold text-neon-400" /></div>}
      />

      <div className="px-4 flex-1 min-h-0 flex flex-col">
        {/* Table: fills the screen above the buttons; its content shrinks to fit when the screen is short, so nothing
            needs scrolling. */}
        <div className={`rounded-[28px] felt relative overflow-hidden flex flex-col flex-1 min-h-0 ${compact ? "p-3 pb-2" : "p-4 pb-3"}`}>
          {/* the shoe */}
          <div className="absolute right-3 top-3 w-10 h-14 rounded-md bg-gradient-to-b from-[#7f1d1d] to-[#450a0a] border border-black/40 shadow-lg rotate-[8deg]">
            <div className="absolute inset-1 rounded-sm border border-white/20 bg-[repeating-linear-gradient(45deg,#991b1b_0_4px,#7f1d1d_4px_8px)]" />
          </div>
          <FitBox>
          <div className="text-center text-[10px] tracking-[0.3em] text-white/40 uppercase">Dealer</div>
          <div className={`flex justify-center mt-2 ${cardRow}`}>
            {dealerCards.map((c, i) => (
              <span key={i} className={i ? "-ml-6" : ""}>
                <PlayingCard card={c} size={cardSize} className={`shadow-xl ${i === 1 ? "flip" : "dealin-d"}`} />
              </span>
            ))}
            {holeDown && <span className="-ml-6"><PlayingCard faceDown size={cardSize} className="dealin-d shadow-xl" /></span>}
          </div>
          <div className="text-center mt-1.5 h-6">{dealerCards.length > 0 && <span className="pill px-2.5 py-0.5 text-[12px] bg-black/40">{dealerTotal}</span>}</div>

          <div className="my-2 text-center text-[10.5px] text-gold-300/70 tracking-wide">BLACKJACK PAYS 3 TO 2 • DEALER STANDS ON ALL 17s</div>

          <div className={`grid gap-3 my-3 ${hands.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
            {hands.map((h, hi) => {
              const active = playing && !dealing && v?.active === hi && hands.length > 1;
              return (
                <div key={hi} className={`flex flex-col items-center rounded-2xl py-2 ${active ? "bg-white/10 ring-2 ring-gold-300/70" : ""}`}>
                  <div className={`flex justify-center ${cardRow}`}>
                    {h.cards.map((c, i) => (
                      <span key={i} className={`inline-block ${i ? (hands.length > 1 ? "-ml-7" : "-ml-6") : ""} ${h.doubled && i === 2 ? "rotate-90 ml-1" : ""}`}>
                        <PlayingCard card={c} size={hands.length > 1 ? (tight ? "sm" : "md") : cardSize} className="dealin shadow-xl" />
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1.5 h-6">
                    {h.cards.length > 0 && <span className="pill px-2.5 py-0.5 text-[12px] bg-black/40">{h.total}</span>}
                    {h.result && <span className={`pill pop px-2.5 py-0.5 text-[12px] font-semibold ${LABEL[h.result].cls}`}>{LABEL[h.result].text}</span>}
                  </div>
                </div>
              );
            })}
            {!hands.length && <div className="text-center text-white/45 text-sm py-6">Pick a chip, then tap the main bet (and any side bets you like)</div>}
          </div>

          {/* Betting spots: the four side bets around the main bet, like Infinite Blackjack */}
          <div className="pt-2 flex flex-col items-center">
            <button
              data-sfx="off"
              disabled={!betting}
              onClick={allSides}
              className="pill px-4 py-1.5 text-[11px] tracking-wide border border-white/25 bg-black/25 text-white/75 disabled:opacity-30 active:scale-95"
            >
              ◎ ALL SIDE BETS
            </button>
            <div className="relative mt-2 w-full max-w-[320px]" style={{ height: tight ? 148 : 178 }}>
              {(["t3", "pp", "main", "h3", "bi"] as Spot[]).map((spot) => (
                <div key={spot} className="absolute" style={spotPos[spot]}>
                  {spot === "main" ? (
                    <BetSpot label="BET" odds="" amount={shown("main")} compact={tight} onTap={betting ? () => place("main") : undefined} />
                  ) : (
                    <BetSpot label={SIDE_INFO[spot].label} odds={SIDE_INFO[spot].odds} amount={shown(spot)} small compact={tight} result={sideShown(spot)} onTap={betting ? () => place(spot) : undefined} />
                  )}
                </div>
              ))}
            </div>
          </div>
          </FitBox>
        </div>

        <div className="mt-2 text-center text-sm h-6 shrink-0">
          {done && (
            <span className={`pop inline-block font-semibold ${net > 0 ? "text-neon-400" : net === 0 ? "text-sky-300" : "text-rose-400"}`}>
              {net > 0 ? `🎉 You won ${inr(net)}!` : net === 0 ? "Push — bet returned" : "Dealer wins"}
            </span>
          )}
          {betting && !done && bet > 0 && <span className="text-white/70">Total bet: <b className="text-white">{inr(bet)}</b></span>}
        </div>

        {playing ? (
          <div className="grid grid-cols-2 gap-2.5 mt-2 shrink-0">
            <button disabled={locked} onClick={() => call("bj_act", { p_action: "hit" })} className="btn-green rounded-2xl py-3 font-bold">HIT</button>
            <button disabled={locked} onClick={() => call("bj_act", { p_action: "stand" })} className="rounded-2xl py-3 font-bold bg-rose-600 active:scale-[.98] disabled:opacity-50">STAND</button>
            <button disabled={locked || !v?.can_double} onClick={() => call("bj_act", { p_action: "double" })} className="rounded-2xl py-3 font-bold bg-gradient-to-b from-amber-300 to-orange-500 text-slate-900 active:scale-[.98] disabled:opacity-35">DOUBLE</button>
            <button disabled={locked || !v?.can_split} onClick={() => call("bj_act", { p_action: "split" })} className="rounded-2xl py-3 font-bold bg-sky-600 active:scale-[.98] disabled:opacity-35">SPLIT</button>
          </div>
        ) : (
          <>
            {/* Undo • chips • ×2 Double */}
            <div className="flex items-center justify-between mt-2 px-0.5 shrink-0">
              <button data-sfx="off" disabled={!history.length} onClick={undo} className="w-11 h-11 rounded-full grid place-items-center bg-white/10 border border-white/15 disabled:opacity-30 active:scale-95" aria-label="Undo last chip">
                <Undo2 size={18} />
              </button>
              <div className="flex items-center gap-1.5">
                {CHIPS.map((c) => (
                  <Chip key={c.v} value={c.v >= 1000 ? "1K" : c.v} color={c.c} size={42} active={chip === c.v} onClick={() => setChip(c.v)} />
                ))}
              </div>
              <button data-sfx="off" disabled={!bet} onClick={doubleAll} className="w-11 h-11 rounded-full grid place-items-center bg-white/10 border border-white/15 text-[13px] font-bold disabled:opacity-30 active:scale-95" aria-label="Double every bet">
                ×2
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-2 shrink-0">
              <button disabled={!bet} onClick={clear} className="btn-ghost rounded-xl py-2.5 text-xs disabled:opacity-40">Clear</button>
              <button disabled={!lastStakes || busy || bet > 0} onClick={() => lastStakes && deal(lastStakes)} className="btn-ghost rounded-xl py-2.5 text-xs disabled:opacity-40">
                Rebet {lastStakes ? inr(sum(lastStakes)) : ""}
              </button>
              <button onClick={() => setPayouts(true)} className="btn-ghost rounded-xl py-2.5 text-xs flex items-center justify-center gap-1"><ListOrdered size={14} /> Payouts</button>
            </div>
            <button disabled={busy || stakes.main < 10} onClick={() => deal(stakes)} className="w-full btn-green rounded-2xl py-3 mt-2 font-bold text-lg disabled:opacity-50 shrink-0">
              {stakes.main ? `DEAL • ${inr(bet)}` : "Tap chips, then the main bet"}
            </button>
          </>
        )}
        <div className="hidden">
          Six decks, shuffled by the server for every hand. Split one pair once; split aces get one card each.<br />
          Side bets up to your main bet. Perfect Pairs, 21+3 and Hot 3 are paid on the deal; Bust It when the dealer is done.
        </div>
      </div>

      <Sheet open={payouts} onClose={() => setPayouts(false)} title="Payouts & Limits">
        <div className="text-sm space-y-4">
          <div className="text-[12px] text-[var(--ink-soft)]">Table: Blackjack • Main bet 🪙 10 – 10,000 • Each side bet 🪙 10 up to your main bet</div>
          {PAYOUTS.map((g) => (
            <div key={g.title}>
              <div className="flex items-baseline justify-between mb-1">
                <div className="font-semibold text-gold-300 uppercase text-[12px] tracking-wide">{g.title}</div>
                <div className="text-[11px] text-white/45">{g.limit}</div>
              </div>
              <div className="divide-y divide-white/5">
                {g.rows.map(([name, pay]) => (
                  <div key={name} className="flex justify-between py-1.5 text-[13px]"><span className="text-white/80">{name}</span><span className="font-semibold">{pay}</span></div>
                ))}
              </div>
            </div>
          ))}
          <div className="text-[11px] text-white/40">Hot 3 and 21+3 use your two cards plus the dealer&apos;s up-card. With a Bust It bet down the dealer always plays the hand out.</div>
        </div>
      </Sheet>
    </div>
  );
}

/** A betting circle on the felt: your stack, and (for side bets) what it paid. */
function BetSpot({ label, odds, amount, small, compact, result, onTap }: { label: string; odds: string; amount: number; small?: boolean; compact?: boolean; result?: SideResult; onTap?: () => void }) {
  const size = small ? (compact ? 58 : 68) : compact ? 80 : 92;
  const won = !!result && (result.pay ?? 0) > 0;
  return (
    <div className="flex flex-col items-center gap-1" style={{ width: small ? (compact ? 80 : 92) : compact ? 96 : 110 }}>
      <button
        data-sfx="off"
        disabled={!onTap}
        onClick={onTap}
        className={`relative rounded-full grid place-items-center text-center transition ${onTap ? "active:scale-95" : ""} ${won ? "shadow-[0_0_18px_#fde047]" : ""}`}
        style={{ width: size, height: size, border: `2px solid ${won ? "#fde047" : "rgba(253,230,138,.55)"}`, background: "rgba(0,0,0,.18)" }}
      >
        {amount > 0 ? (
          <span className="pop"><Chip value={amount >= 1000 ? `${Math.round(amount / 100) / 10}K` : amount} color={amount >= 1000 ? "#d97706" : amount >= 500 ? "#7c3aed" : amount >= 100 ? "#e11d48" : amount >= 50 ? "#16a34a" : "#2563eb"} size={small ? (compact ? 34 : 40) : compact ? 44 : 50} /></span>
        ) : (
          <span className="px-1">
            <span className={`block font-bold text-gold-200/90 leading-tight ${small ? "text-[9.5px]" : "text-[15px]"}`}>{label}</span>
            {odds && <span className="block text-[8px] text-white/50 mt-0.5">{odds}</span>}
          </span>
        )}
      </button>
      <div className="h-4 text-[10px] leading-4 whitespace-nowrap">
        {result ? (
          result.pending ? <span className="text-white/50">{label} • riding</span>
          : won ? <span className="pop inline-block font-semibold text-gold-300">{result.hit?.name} +{inr(result.pay ?? 0)}</span>
          : <span className="text-white/40">No win</span>
        ) : amount > 0 && small ? <span className="text-white/50">{label}</span> : null}
      </div>
    </div>
  );
}
