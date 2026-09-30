"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { MoreVertical } from "lucide-react";
import { deck, gameById, inr, type Card, type GameId } from "../../lib/data";
import { pickBots, type Bot } from "../../lib/botpool";
import { POKER_NAMES, TP_NAMES, compare, pokerScore, teenPattiScore } from "../../lib/hands";
import { useStore } from "../../lib/store";
import { Header, Money, PlayingCard } from "../ui";
import { NEXT_GAME_SECS, ResultSheet, TURN_SECS, TimerAvatar, humanDelay, sleep, useAutoNext } from "./bots";
import type { Nav } from "../nav";

// Teen Patti (PRD §6.1) and Texas Hold'em demo table. Game logic runs locally against three bots;
// in production the table is a server-side FSM and the client only renders state + sends actions.

const RAKE = 0.05;
const BOTS = 5; // 6 players at the table: you + 5

interface Seat {
  name: string;
  emoji: string;
  bal: number;
  cards: Card[];
  packed: boolean;
  seen: boolean;
  shown?: boolean; // cards revealed to you via a side show
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
  sheet: boolean; // result is out (after the cards have been revealed on the table); next-game countdown runs
  peek: boolean; // result sheet dismissed to look at the table
  hand: number; // games played at this table
}

const seat = (b: Bot): Seat => ({ ...b, cards: [], packed: false, seen: false });

function fresh(bots: Seat[]): G {
  return {
    phase: "idle",
    me: { cards: [], packed: false, seen: false, paid: 0 },
    bots,
    pot: 0,
    stake: 0,
    round: 1,
    stage: 0,
    community: [],
    turn: null,
    timerEnd: 0,
    busy: false,
    result: null,
    sheet: false,
    peek: false,
    hand: 0,
  };
}

export function CardTable({ nav, gameId, table, buyIn }: { nav: Nav; gameId: GameId; table: string; buyIn: number }) {
  const game = gameById(gameId);
  const poker = gameId === "poker";
  const { total, debit, credit, showToast } = useStore();
  const g = useRef<G>(null as unknown as G);
  if (!g.current) g.current = fresh(pickBots(BOTS).map(seat));
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [lowBal, setLowBal] = useState(false);
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

  // Between games some players leave (or go broke) and new ones sit down, like a real lobby table.
  const rotateSeats = (bots: Seat[]) => {
    const out = [...bots];
    const leaving = out.map((b, i) => (b.bal < buyIn * 4 || Math.random() < 0.12 ? i : -1)).filter((i) => i >= 0).slice(0, 2);
    if (!leaving.length) return out;
    const fresh = pickBots(leaving.length, out.map((b) => b.name));
    leaving.forEach((i, k) => {
      showToast(`${out[i].name} left • ${fresh[k].name} joined`);
      out[i] = seat({ ...fresh[k], bal: Math.max(fresh[k].bal, buyIn * 20) });
    });
    return out;
  };

  const start = () => {
    if (!debit(buyIn, `${label} • Boot`)) {
      setLowBal(true);
      g.current = { ...g.current, phase: "idle", sheet: false, result: null };
      bump();
      return showToast("Not enough balance — add cash");
    }
    setLowBal(false);
    const dk = deck();
    const n = poker ? 2 : 3;
    const prev = g.current;
    const next = fresh(prev.hand ? rotateSeats(prev.bots) : prev.bots);
    next.hand = prev.hand + 1;
    next.bots = next.bots.map((b) => ({ ...b, bal: b.bal - buyIn, cards: dk.splice(0, n), packed: false, seen: false, shown: false, action: undefined }));
    next.me = { cards: dk.splice(0, n), packed: false, seen: poker, paid: buyIn };
    next.community = poker ? dk.splice(0, 5) : [];
    next.pot = buyIn * (BOTS + 1);
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
    st.busy = false;
    bump();
    // Let the table show the revealed cards and winner for a moment before the result sheet slides up.
    window.setTimeout(() => { if (g.current === st) { st.sheet = true; bump(); } }, 2200);
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
      // Each bot gets its own 15 s clock and uses a human-like slice of it.
      const delay = humanDelay();
      st.turn = i;
      st.timerEnd = Date.now() + TURN_SECS * 1000;
      b.action = "Thinking…";
      bump();
      await sleep(delay * 1000);
      if (g.current !== st) return; // left / restarted
      const packChance = poker ? 0.14 : 0.08 + st.round * 0.04 + (b.seen ? 0.04 : 0);
      if (delay >= TURN_SECS) {
        b.packed = true;
        b.action = "Timed out";
      } else if (Math.random() < packChance) {
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
      await sleep(300);
      if (g.current !== st) return;
    }
    st.busy = false;
    const alive = st.bots.map((b, i) => (b.packed ? -1 : i)).filter((i) => i >= 0);
    if (!st.me.packed && !alive.length) return finish("me", poker ? "Everyone else folded" : "Everyone else packed");
    if (st.me.packed && alive.length === 1) return finish(alive[0], poker ? "Everyone else folded" : "Everyone else packed");
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
      // You're out: with two players left, one of them eventually asks for a show.
      if (st.me.packed && alive.length === 2 && st.round >= 3 && Math.random() < 0.5) {
        const caller = st.bots[alive[1]];
        caller.action = "Show";
        st.turn = alive[1];
        st.pot += st.stake * 2;
        caller.bal -= st.stake * 2;
        bump();
        await sleep(1500);
        if (g.current !== st) return;
        return showdown();
      }
    }
    // You packed or folded: the rest of the table keeps playing until someone wins.
    if (st.me.packed) return botsTurn();
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
      s.turn = null;
      bump();
      return botsTurn();
    }
    if (kind === "raise") s.stake = poker ? Math.max(s.stake * 2, buyIn * 2) : s.stake * 2;
    const amt = poker ? s.stake : s.me.seen ? s.stake * 2 : s.stake;
    if (!pay(amt)) return;
    if (kind === "show") return showdown();
    botsTurn();
  };

  // Side show: compare hands privately with the previous active player (who must also be Seen).
  // They may accept or reject; on accept the lower hand packs (ties go against the requester).
  const sideShowTarget = () => {
    for (let i = s.bots.length - 1; i >= 0; i--) if (!s.bots[i].packed) return i;
    return -1;
  };
  const canSideShow = () => !poker && s.me.seen && activeCount() >= 3 && sideShowTarget() >= 0 && s.bots[sideShowTarget()].seen;

  function activeCount() {
    return (s.me.packed ? 0 : 1) + s.bots.filter((b) => !b.packed).length;
  }

  const sideShow = async () => {
    if (s.phase !== "playing" || s.turn !== "me" || s.busy || !canSideShow()) return;
    const t = sideShowTarget();
    const bot = s.bots[t];
    if (!pay(s.stake * 2)) return;
    const st = s;
    st.busy = true;
    st.turn = t;
    bot.action = "Side show?";
    bump();
    await sleep(1200);
    if (g.current !== st) return;
    if (Math.random() < 0.3) {
      bot.action = "Rejected";
      showToast(`${bot.name} rejected the side show`);
      return botsTurn();
    }
    bot.shown = true;
    const mine = teenPattiScore(st.me.cards);
    const theirs = teenPattiScore(bot.cards);
    if (compare(mine, theirs) > 0) {
      bot.packed = true;
      bot.action = "Lost side show";
      showToast(`Side show won — your ${TP_NAMES[mine[0]]} beats ${TP_NAMES[theirs[0]]}`);
      bump();
      await sleep(900);
      if (g.current !== st) return;
      if (st.bots.every((b) => b.packed)) return finish("me", "Won side show");
      botsTurn();
    } else {
      st.me.packed = true;
      bot.action = "Won side show";
      showToast(`Side show lost — ${bot.name}'s ${TP_NAMES[theirs[0]]} is higher`);
      st.busy = false;
      bump();
      await sleep(900);
      if (g.current !== st) return;
      botsTurn();
    }
  };

  // Turn timer → auto-play (PRD AUTH-5): pack / fold on timeout.
  useEffect(() => {
    if (s.phase !== "playing") return;
    const t = setInterval(() => {
      if (Date.now() >= g.current.timerEnd && g.current.turn === "me" && !g.current.busy) {
        showToast("Time's up — auto-packed");
        act("pack");
      } else bump();
    }, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.phase, g.current]);

  // Leaving the table invalidates any running bot loop.
  useEffect(() => () => { g.current = { ...g.current, phase: "idle" }; }, []);

  // Deal automatically: shortly after you sit down, and again after every result.
  const firstIn = useAutoNext(s.phase === "idle" && !lowBal, 3, start);
  const nextIn = useAutoNext(s.phase === "done" && s.sheet, NEXT_GAME_SECS, start);

  const secs = Math.min(TURN_SECS, Math.max(0, Math.ceil((s.timerEnd - Date.now()) / 1000)));
  const myTurn = s.phase === "playing" && s.turn === "me" && !s.busy;
  const reveal = s.phase === "done";
  const winnerSeat = s.result && !s.result.me ? s.bots.findIndex((b) => b.name === s.result!.who) : -1;
  const chaalAmt = poker ? s.stake : s.me.seen ? s.stake * 2 : s.stake;
  const activeBots = s.bots.filter((b) => !b.packed).length;
  const stageName = ["Pre-Flop", "Flop", "Turn", "River", "Showdown"][s.stage];

  const seatPos = [
    "-left-2 top-[50%]",
    "left-1 top-[6%]",
    "left-1/2 -translate-x-1/2 -top-6",
    "right-1 top-[6%]",
    "-right-2 top-[50%]",
  ];

  return (
    <div className="min-h-dvh flex flex-col pb-5 fadein">
      <Header
        title={game.name}
        sub={`Table #${table} • 6 Players • Boot ₹${buyIn}`}
        onBack={nav.back}
        right={<div className="flex items-center gap-3"><Money n={total} className="text-sm font-semibold text-neon-400" /><MoreVertical size={20} className="text-white/60" /></div>}
      />

      <div className="px-3 flex-1 flex flex-col">
        <div className="relative mt-12 mx-4 felt" style={{ height: 350, borderRadius: "170px" }}>
          {s.bots.map((b, i) => (
            <div key={b.name} className={`absolute ${seatPos[i]} flex flex-col items-center z-10 w-[84px] ${reveal && winnerSeat === i ? "scale-110 transition-transform" : ""}`}>
              <TimerAvatar emoji={b.emoji} size={40} active={s.phase === "playing" && s.turn === i} left={s.turn === i ? Math.max(0, (s.timerEnd - Date.now()) / 1000) : 0} dim={b.packed} />
              <div className="mt-1 px-2 py-0.5 rounded-lg bg-black/55 text-center">
                <div className="text-[10px] font-medium leading-tight">{b.name}</div>
                <div className="text-[10px] text-gold-300 leading-tight">₹{b.bal.toLocaleString("en-IN")}</div>
              </div>
              {s.phase !== "idle" && (
                <div className="flex -space-x-3 mt-1">
                  {b.cards.map((c, j) => <PlayingCard key={j} card={c} faceDown={!((reveal && !b.packed) || b.shown)} size="xs" />)}
                </div>
              )}
              {b.action && <div className={`mt-1 text-[9px] pill px-1.5 py-0.5 ${b.packed ? "bg-rose-500/30 text-rose-200" : "bg-white/15"}`}>{b.action}</div>}
              {!poker && s.phase === "playing" && !b.packed && !b.action && <div className="mt-1 text-[9px] text-white/60">{b.seen ? "Seen" : "Blind"}</div>}
            </div>
          ))}

          <div className="absolute inset-0 flex flex-col items-center justify-center">
            {s.phase === "idle" ? (
              <div className="text-center">
                {lowBal ? (
                  <>
                    <div className="text-xs text-white/70">Not enough balance for the ₹{buyIn} boot</div>
                    <button onClick={() => nav.push({ name: "addcash" })} className="btn-green pill px-6 py-2.5 mt-2 text-sm">Add Cash</button>
                    <button onClick={start} className="block mx-auto text-[11px] text-white/50 mt-2">Try again</button>
                  </>
                ) : (
                  <>
                    <div className="text-xs text-white/70">Waiting for players…</div>
                    <div className="text-sm font-semibold mt-1">Dealing in {firstIn}s</div>
                  </>
                )}
              </div>
            ) : s.phase === "done" && s.result ? (
              <div className="text-center fadein">
                <div className="text-sm font-semibold">{s.result.me ? "You win!" : `${s.result.who} wins`}</div>
                <div className="text-[11px] text-gold-300 font-semibold">{inr(s.result.amount)} • {s.result.hand}</div>
                {s.sheet && <div className="text-[11px] text-white/60 mt-1">Next game in {nextIn}s</div>}
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
                  {s.phase === "playing" ? (s.turn === "me" && !s.busy ? `${secs}s` : typeof s.turn === "number" ? <span className="text-xs font-normal text-white/70">{s.bots[s.turn].name}&apos;s turn • {secs}s</span> : "") : ""}
                </div>
              </>
            )}
          </div>

          {/* You */}
          <div className="absolute left-1/2 -translate-x-1/2 -bottom-7 flex flex-col items-center z-10">
            <TimerAvatar size={48} active={myTurn} left={myTurn ? Math.max(0, (s.timerEnd - Date.now()) / 1000) : 0} dim={s.me.packed} />
            <div className="mt-1 px-2 py-0.5 rounded-lg bg-black/55 text-center">
              <div className="text-[10px] font-medium leading-tight">You {s.phase === "playing" && (s.me.packed ? <span className="text-rose-300">• {poker ? "Folded" : "Packed"}</span> : !poker && <span className="text-white/60">• {s.me.seen ? "Seen" : "Blind"}</span>)}</div>
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
                  <PlayingCard key={i} card={c} faceDown={!s.me.seen && !s.me.packed} size="lg" className={`${s.me.seen ? "flip" : ""} ${s.me.packed ? "opacity-50" : ""}`} style={{ transform: `rotate(${(i - (s.me.cards.length - 1) / 2) * 8}deg) translateY(${Math.abs(i - (s.me.cards.length - 1) / 2) * 5}px)` }} />
                ))}
              </div>
              <div className="mt-2 text-xs text-white/70">{s.me.seen || s.me.packed ? <>Your hand: <b className="text-gold-300">{handName(s.me.cards)}</b></> : "Playing blind — tap See to look"}</div>
            </>
          )}
        </div>

        {s.phase === "playing" && s.me.packed && (
          <div className="text-center text-xs text-white/60 -mt-4 mb-2">You {poker ? "folded" : "packed"} — waiting for this game to finish</div>
        )}

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
              <div className="space-y-2">
                <div className="grid grid-cols-3 gap-2">
                  <button disabled={!myTurn} onClick={() => act("pack")} className="rounded-full py-3 text-sm font-bold tracking-wide bg-[#1b2350] border border-white/10 disabled:opacity-40">PACK</button>
                  <button disabled={!myTurn || !canSideShow()} onClick={sideShow} className="rounded-full py-3 text-sm font-bold tracking-wide bg-fuchsia-600 disabled:opacity-40">SIDE SHOW</button>
                  <button disabled={!myTurn || (activeBots > 1 && s.round < 3)} onClick={() => act("show")} className="rounded-full py-3 text-sm font-bold tracking-wide bg-gold-500 text-slate-900 disabled:opacity-40">SHOW</button>
                </div>
                <div className="grid grid-cols-[1fr_2fr] gap-2">
                  <button disabled={!myTurn || s.me.seen} onClick={() => act("see")} className="rounded-full py-3 text-sm font-bold tracking-wide bg-sky-500 disabled:opacity-40">{s.me.seen ? "SEEN ✓" : "SEE"}</button>
                  <button disabled={!myTurn} onClick={() => act("chaal")} className="btn-green rounded-full py-3 text-sm font-bold tracking-wide">
                    CHAAL ₹{chaalAmt}
                  </button>
                </div>
                {myTurn && (
                  <button onClick={() => act("raise")} className="w-full text-xs text-white/60 py-1">Raise to ₹{chaalAmt * 2} (2×)</button>
                )}
                {myTurn && !canSideShow() && s.me.seen && activeBots >= 2 && (
                  <div className="text-center text-[10px] text-white/40">Side show needs the previous player to be Seen too</div>
                )}
              </div>
            )}
            <div className="text-center text-[10px] text-white/35 mt-2">If you disconnect, you have 60s to rejoin — otherwise the server auto-packs your hand.</div>
          </div>
        )}
      </div>

      {s.result && (
        <ResultSheet
          open={s.phase === "done" && s.sheet && !s.peek}
          won={s.result.me}
          title={s.result.me ? `You won ${inr(s.result.amount)}!` : `${s.result.who} wins`}
          sub={s.me.packed && !s.result.me ? `${s.result.hand} • you ${poker ? "folded" : "packed"}` : s.result.hand}
          left={nextIn}
          onLeave={nav.back}
          onClose={() => { g.current.peek = true; bump(); }}
        >
          <div className="flex justify-center gap-6 mt-4 flex-wrap">
            {[{ n: "You", c: s.me.cards }, ...s.bots.filter((b) => !b.packed).map((b) => ({ n: b.name, c: b.cards }))].map((p) => (
              <div key={p.n} className="flex flex-col items-center gap-1">
                <div className="flex -space-x-2">{p.c.map((c, i) => <PlayingCard key={i} card={c} size="sm" />)}</div>
                <div className="text-[10px] text-white/60">{p.n}</div>
              </div>
            ))}
          </div>
          <div className="text-[10px] text-white/40 mt-3">Pot {inr(s.pot)} • Platform fee {RAKE * 100}%</div>
        </ResultSheet>
      )}
    </div>
  );
}
