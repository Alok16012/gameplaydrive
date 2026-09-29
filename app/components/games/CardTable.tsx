"use client";

import { useEffect, useReducer, useRef } from "react";
import { MoreVertical, Trophy } from "lucide-react";
import { AVATARS, BOT_NAMES, deck, gameById, inr, type Card, type GameId } from "../../lib/data";
import { POKER_NAMES, TP_NAMES, compare, pokerScore, teenPattiScore } from "../../lib/hands";
import { useStore } from "../../lib/store";
import { Avatar, Header, Money, PlayingCard, Sheet } from "../ui";
import type { Nav } from "../nav";

// Teen Patti (PRD §6.1) and Texas Hold'em demo table. Game logic runs locally against three bots;
// in production the table is a server-side FSM and the client only renders state + sends actions.

const TURN_SECS = 20;
const RAKE = 0.05;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Seat {
  name: string;
  emoji: string;
  bal: number;
  cards: Card[];
  packed: boolean;
  seen: boolean;
  action?: string;
}

interface G {
  phase: "idle" | "playing" | "done";
  me: { cards: Card[]; packed: boolean; seen: boolean; paid: number };
  bots: Seat[];
  pot: number;
  stake: number;
  round: number;
  stage: number; // poker: 0 pre-flop, 1 flop, 2 turn, 3 river
  community: Card[];
  turn: "me" | number | null;
  timerEnd: number;
  busy: boolean;
  result: { me: boolean; who: string; hand: string; amount: number } | null;
}

function fresh(): G {
  return {
    phase: "idle",
    me: { cards: [], packed: false, seen: false, paid: 0 },
    bots: [0, 1, 2].map((i) => ({ name: BOT_NAMES[i], emoji: AVATARS[i + 1], bal: [980, 1250, 1430][i], cards: [], packed: false, seen: false })),
    pot: 0,
    stake: 0,
    round: 1,
    stage: 0,
    community: [],
    turn: null,
    timerEnd: 0,
    busy: false,
    result: null,
  };
}

export function CardTable({ nav, gameId, table, buyIn }: { nav: Nav; gameId: GameId; table: string; buyIn: number }) {
  const game = gameById(gameId);
  const poker = gameId === "poker";
  const { total, debit, credit, showToast } = useStore();
  const g = useRef<G>(fresh());
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const s = g.current;
  const label = `${game.name} • Table #${table}`;

  const score = (cards: Card[]) => (poker ? pokerScore([...cards, ...s.community]) : teenPattiScore(cards));
  const handName = (cards: Card[]) => {
    if (poker) {
      const sc = pokerScore([...cards, ...s.community]);
      return sc[0] < 0 ? (cards[0].r === cards[1].r ? "Pocket Pair" : "High Card") : POKER_NAMES[sc[0]];
    }
    return TP_NAMES[teenPattiScore(cards)[0]];
  };

  const start = () => {
    if (!debit(buyIn, `${label} • Boot`)) return showToast("Not enough balance — add cash");
    const dk = deck();
    const n = poker ? 2 : 3;
    const prev = g.current;
    const next = fresh();
    next.bots = prev.bots.map((b) => ({ ...b, bal: b.bal - buyIn, cards: dk.splice(0, n), packed: false, seen: false, action: undefined }));
    next.me = { cards: dk.splice(0, n), packed: false, seen: poker, paid: buyIn };
    next.community = poker ? dk.splice(0, 5) : [];
    next.pot = buyIn * 4;
    next.stake = buyIn;
    next.phase = "playing";
    next.turn = "me";
    next.timerEnd = Date.now() + TURN_SECS * 1000;
    g.current = next;
    bump();
  };

  const finish = (winner: "me" | number, hand: string) => {
    const st = g.current;
    const payout = Math.floor(st.pot * (1 - RAKE));
    if (winner === "me") credit(payout, label);
    else st.bots[winner].bal += payout;
    st.result = { me: winner === "me", who: winner === "me" ? "You" : st.bots[winner].name, hand, amount: payout };
    st.phase = "done";
    st.turn = null;
    bump();
  };

  const showdown = () => {
    const st = g.current;
    st.me.seen = true;
    const contenders: ("me" | number)[] = [...(st.me.packed ? [] : ["me" as const]), ...st.bots.map((b, i) => (b.packed ? -1 : i)).filter((i) => i >= 0)];
    if (poker) st.stage = 4;
    let best = contenders[0];
    for (const c of contenders.slice(1)) {
      const a = score(c === "me" ? st.me.cards : st.bots[c].cards);
      const b = score(best === "me" ? st.me.cards : st.bots[best].cards);
      if (compare(a, b) > 0) best = c;
    }
    finish(best, handName(best === "me" ? st.me.cards : st.bots[best].cards));
  };

  const botsTurn = async () => {
    const st = g.current;
    st.busy = true;
    for (let i = 0; i < st.bots.length; i++) {
      const b = st.bots[i];
      if (b.packed || st.phase !== "playing") continue;
      st.turn = i;
      bump();
      await sleep(850);
      if (g.current !== st) return; // left / restarted
      const active = st.bots.filter((x) => !x.packed).length;
      if (Math.random() < 0.16 && (active > 1 || st.me.packed === false)) {
        b.packed = true;
        b.action = poker ? "Fold" : "Pack";
      } else {
        if (!poker && !b.seen && Math.random() < 0.35) b.seen = true;
        const amt = poker ? st.stake : b.seen ? st.stake * 2 : st.stake;
        b.bal -= amt;
        st.pot += amt;
        b.action = poker ? (st.stake ? `Call ₹${amt}` : "Check") : `${b.seen ? "Chaal" : "Blind"} ₹${amt}`;
      }
      bump();
    }
    st.busy = false;
    if (st.bots.every((b) => b.packed)) return finish("me", "Everyone else folded");
    if (poker) {
      st.stage += 1;
      st.stake = 0;
      if (st.stage > 3) return showdown();
    } else {
      st.round += 1;
      if (st.pot >= buyIn * 60) {
        showToast("Pot limit reached — automatic show");
        return showdown();
      }
    }
    st.turn = "me";
    st.timerEnd = Date.now() + TURN_SECS * 1000;
    bump();
  };

  const pay = (amt: number) => {
    if (amt > 0 && !debit(amt, label)) {
      showToast("Not enough balance");
      return false;
    }
    s.pot += amt;
    s.me.paid += amt;
    return true;
  };

  const act = (kind: "pack" | "see" | "chaal" | "raise" | "show") => {
    if (s.phase !== "playing" || s.turn !== "me" || s.busy) return;
    if (kind === "see") {
      s.me.seen = true;
      return bump();
    }
    if (kind === "pack") {
      s.me.packed = true;
      bump();
      const alive = s.bots.map((b, i) => (b.packed ? -1 : i)).filter((i) => i >= 0);
      return showdownAmong(alive);
    }
    if (kind === "raise") s.stake = poker ? Math.max(s.stake * 2, buyIn * 2) : s.stake * 2;
    const amt = poker ? s.stake : s.me.seen ? s.stake * 2 : s.stake;
    if (!pay(amt)) return;
    if (kind === "show") return showdown();
    botsTurn();
  };

  // Pot goes to the best remaining bot once you fold.
  const showdownAmong = (alive: number[]) => {
    let best = alive[0];
    for (const i of alive.slice(1)) if (compare(score(s.bots[i].cards), score(s.bots[best].cards)) > 0) best = i;
    finish(best, poker ? "You folded" : "You packed");
  };

  // Turn timer → auto-play (PRD AUTH-5): pack / fold on timeout.
  useEffect(() => {
    if (s.phase !== "playing" || s.turn !== "me") return;
    const t = setInterval(() => {
      if (Date.now() >= g.current.timerEnd && g.current.turn === "me") {
        showToast("Time's up — auto-packed");
        act("pack");
      } else bump();
    }, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.phase, s.turn]);

  useEffect(() => () => { g.current = fresh(); }, []);

  const secs = Math.max(0, Math.ceil((s.timerEnd - Date.now()) / 1000));
  const myTurn = s.phase === "playing" && s.turn === "me" && !s.busy;
  const reveal = s.phase === "done";
  const chaalAmt = poker ? s.stake : s.me.seen ? s.stake * 2 : s.stake;
  const activeBots = s.bots.filter((b) => !b.packed).length;
  const stageName = ["Pre-Flop", "Flop", "Turn", "River", "Showdown"][s.stage];

  const seatPos = ["left-1 top-[44%] -translate-y-1/2", "left-1/2 -translate-x-1/2 -top-3", "right-1 top-[44%] -translate-y-1/2"];

  return (
    <div className="min-h-dvh flex flex-col pb-5 fadein">
      <Header
        title={game.name}
        sub={`Table #${table} • 4 Players • Boot ₹${buyIn}`}
        onBack={nav.back}
        right={<div className="flex items-center gap-3"><Money n={total} className="text-sm font-semibold text-neon-400" /><MoreVertical size={20} className="text-white/60" /></div>}
      />

      <div className="px-3 flex-1 flex flex-col">
        <div className="relative mt-8 mx-3 felt" style={{ height: 330, borderRadius: "160px" }}>
          {s.bots.map((b, i) => (
            <div key={i} className={`absolute ${seatPos[i]} flex flex-col items-center z-10 w-24`}>
              <div className={`rounded-full ${s.turn === i ? "pulse-ring" : ""} ${b.packed ? "opacity-40 grayscale" : ""}`}>
                <Avatar emoji={b.emoji} size={46} />
              </div>
              <div className="mt-1 px-2 py-0.5 rounded-lg bg-black/55 text-center">
                <div className="text-[10px] font-medium leading-tight">{b.name}</div>
                <div className="text-[10px] text-gold-300 leading-tight">₹{b.bal.toLocaleString("en-IN")}</div>
              </div>
              {s.phase !== "idle" && (
                <div className="flex -space-x-3 mt-1">
                  {b.cards.map((c, j) => <PlayingCard key={j} card={c} faceDown={!reveal || b.packed} size="xs" />)}
                </div>
              )}
              {b.action && <div className={`mt-1 text-[9px] pill px-1.5 py-0.5 ${b.packed ? "bg-rose-500/30 text-rose-200" : "bg-white/15"}`}>{b.action}</div>}
              {!poker && s.phase === "playing" && !b.packed && !b.action && <div className="mt-1 text-[9px] text-white/60">{b.seen ? "Seen" : "Blind"}</div>}
            </div>
          ))}

          <div className="absolute inset-0 flex flex-col items-center justify-center">
            {s.phase === "idle" ? (
              <div className="text-center">
                <div className="text-xs text-white/70">Waiting to deal</div>
                <button onClick={start} className="btn-green pill px-6 py-2.5 mt-2 text-sm">Deal • Boot ₹{buyIn}</button>
              </div>
            ) : (
              <>
                {poker && (
                  <div className="flex gap-1 mb-2">
                    {s.community.map((c, i) => {
                      const shown = s.stage >= 4 || (s.stage >= 1 && i < 3) || (s.stage >= 2 && i === 3) || (s.stage >= 3 && i === 4);
                      return <PlayingCard key={i} card={c} faceDown={!shown} size="sm" className={shown ? "flip" : "opacity-60"} />;
                    })}
                  </div>
                )}
                <div className="text-sm font-semibold">{poker ? stageName : `Round ${s.round}`}</div>
                <div className="text-[11px] text-gold-300 font-semibold">Pot ₹{s.pot.toLocaleString("en-IN")}</div>
                <div className="text-lg font-bold mt-0.5">
                  {s.phase === "playing" ? (s.turn === "me" && !s.busy ? `${secs}s` : typeof s.turn === "number" ? <span className="text-xs font-normal text-white/70">{s.bots[s.turn].name} is thinking…</span> : "") : ""}
                </div>
              </>
            )}
          </div>

          {/* You */}
          <div className="absolute left-1/2 -translate-x-1/2 -bottom-7 flex flex-col items-center z-10">
            <div className={`rounded-full ${myTurn ? "pulse-ring" : ""} ${s.me.packed ? "opacity-40" : ""}`}><Avatar size={50} /></div>
            <div className="mt-1 px-2 py-0.5 rounded-lg bg-black/55 text-center">
              <div className="text-[10px] font-medium leading-tight">You {!poker && s.phase === "playing" && <span className="text-white/60">• {s.me.seen ? "Seen" : "Blind"}</span>}</div>
              <div className="text-[10px] text-gold-300 leading-tight">₹{total.toLocaleString("en-IN")}</div>
            </div>
          </div>
        </div>

        {/* My hand */}
        <div className="mt-14 flex flex-col items-center min-h-[120px]">
          {s.me.cards.length > 0 && (
            <>
              <div className="flex -space-x-3">
                {s.me.cards.map((c, i) => (
                  <PlayingCard key={i} card={c} faceDown={!s.me.seen} size="lg" className={s.me.seen ? "flip" : ""} style={{ transform: `rotate(${(i - (s.me.cards.length - 1) / 2) * 8}deg) translateY(${Math.abs(i - (s.me.cards.length - 1) / 2) * 5}px)` }} />
                ))}
              </div>
              <div className="mt-2 text-xs text-white/70">{s.me.seen ? <>Your hand: <b className="text-gold-300">{handName(s.me.cards)}</b></> : "Playing blind — tap See to look"}</div>
            </>
          )}
        </div>

        {/* Actions */}
        {s.phase !== "idle" && (
          <div className="mt-auto pt-3">
            {poker ? (
              <div className="grid grid-cols-3 gap-2.5">
                <button disabled={!myTurn} onClick={() => act("pack")} className="rounded-full py-3 text-sm font-semibold bg-[#1b2350] border border-white/10 disabled:opacity-40">Fold</button>
                <button disabled={!myTurn} onClick={() => act("chaal")} className="rounded-full py-3 text-sm font-semibold bg-sky-500 disabled:opacity-40">{s.stake ? `Call ₹${chaalAmt}` : "Check"}</button>
                <button disabled={!myTurn} onClick={() => act("raise")} className="btn-green rounded-full py-3 text-sm">Raise</button>
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-2">
                <button disabled={!myTurn} onClick={() => act("pack")} className="rounded-full py-3 text-sm font-semibold bg-[#1b2350] border border-white/10 disabled:opacity-40">Fold</button>
                {s.me.seen ? (
                  <button disabled={!myTurn} onClick={() => act("chaal")} className="rounded-full py-3 text-[13px] font-semibold bg-sky-500 disabled:opacity-40 leading-tight">Chaal<br /><span className="text-[10px] font-normal">₹{chaalAmt}</span></button>
                ) : (
                  <button disabled={!myTurn} onClick={() => act("see")} className="rounded-full py-3 text-sm font-semibold bg-sky-500 disabled:opacity-40">See</button>
                )}
                <button disabled={!myTurn} onClick={() => act("raise")} className="btn-green rounded-full py-3 text-sm">Raise</button>
                <button disabled={!myTurn || (activeBots > 1 && s.round < 3)} onClick={() => act("show")} className="rounded-full py-3 text-sm font-semibold bg-gold-500 text-slate-900 disabled:opacity-40">Show</button>
              </div>
            )}
            {!poker && !s.me.seen && myTurn && (
              <button onClick={() => act("chaal")} className="w-full mt-2 text-xs text-white/60 py-1.5">Play Blind ₹{chaalAmt}</button>
            )}
            <div className="text-center text-[10px] text-white/35 mt-2">If you disconnect, you have 60s to rejoin — otherwise the server auto-packs your hand.</div>
          </div>
        )}
      </div>

      <Sheet open={s.phase === "done" && !!s.result} onClose={() => { g.current.phase = "idle"; g.current.result = null; bump(); }}>
        {s.result && (
          <div className="text-center">
            <div className="pop inline-grid place-items-center w-20 h-20 rounded-full" style={{ background: s.result.me ? "radial-gradient(circle,#fde68a,#f59e0b)" : "rgba(255,255,255,.08)" }}>
              {s.result.me ? <Trophy size={40} className="text-amber-900" /> : <span className="text-4xl">😔</span>}
            </div>
            <div className="text-2xl font-semibold mt-3">{s.result.me ? `You won ${inr(s.result.amount)}!` : `${s.result.who} wins`}</div>
            <div className="text-sm text-[var(--ink-soft)] mt-1">{s.result.hand}</div>
            <div className="flex justify-center gap-6 mt-4">
              {[{ n: "You", c: s.me.cards }, ...s.bots.filter((b) => !b.packed).map((b) => ({ n: b.name, c: b.cards }))].map((p) => (
                <div key={p.n} className="flex flex-col items-center gap-1">
                  <div className="flex -space-x-2">{p.c.map((c, i) => <PlayingCard key={i} card={c} size="sm" />)}</div>
                  <div className="text-[10px] text-white/60">{p.n}</div>
                </div>
              ))}
            </div>
            <div className="text-[10px] text-white/40 mt-3">Pot {inr(s.pot)} • Platform fee {RAKE * 100}%</div>
            <div className="grid grid-cols-2 gap-3 mt-6">
              <button onClick={nav.back} className="btn-ghost py-3 rounded-2xl">Leave Table</button>
              <button onClick={start} className="btn-green py-3 rounded-2xl">Play Again</button>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
}
