"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownUp, Layers } from "lucide-react";
import { RANKS, SUITS, inr, rankValue, type Card } from "../../lib/data";
import { pickBots } from "../../lib/botpool";
import { useStore } from "../../lib/store";
import { Header, Money, PlayingCard } from "../ui";
import { NEXT_GAME_SECS, ResultSheet, TimerAvatar, humanDelay, sleep, useAutoNext } from "./bots";
import type { Nav, RummyMode } from "../nav";

// 13 Card Rummy demo (PRD §6.1). Two decks; valid declare = 1 pure sequence + 1 more sequence,
// all remaining cards in valid sets/sequences. The server validates declares in production.

interface HC {
  id: number;
  c: Card;
}

type GroupKind = "pure" | "impure" | "set" | "invalid";
const KIND_LABEL: Record<GroupKind, string> = { pure: "Pure Sequence", impure: "Sequence", set: "Set", invalid: "Invalid" };

const BOTS = 5; // 6 players at the table: you + 5
const TURN = 30; // seconds per move, for every player
const FEE = 0.1; // platform fee on the prize pool / winnings

export const MODE_LABEL: Record<RummyMode, string> = { points: "Points Rummy", pool101: "Pool 101", pool201: "Pool 201", deals: "Deals Rummy" };
const POOL_LIMIT: Partial<Record<RummyMode, number>> = { pool101: 101, pool201: 201 };
/** First drop / middle drop penalties. Pool 201 uses 25/50, everything else 20/40. Full count is 80. */
const dropPts = (mode: RummyMode, middle: boolean) => (mode === "pool201" ? (middle ? 50 : 25) : middle ? 40 : 20);

interface RBot { name: string; emoji: string; dropped: boolean; middle: boolean; out: boolean; action: string }
interface DealRow { name: string; pts: number; total: number; note: string; out: boolean; winner: boolean }
let uid = 0;

function twoDecks(): HC[] {
  const d: HC[] = [];
  for (let k = 0; k < 2; k++) for (const s of SUITS) for (const r of RANKS) d.push({ id: uid++, c: { r, s } });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

const points = (c: Card) => (["J", "Q", "K", "A", "10"].includes(c.r) ? 10 : rankValue(c.r));

function classify(group: HC[], wild: Card["r"]): GroupKind {
  if (group.length < 3) return "invalid";
  const cards = group.map((g) => g.c);
  const isJoker = (c: Card) => c.r === wild;
  const pureSeq = (cs: Card[]) => {
    if (!cs.every((c) => c.s === cs[0].s)) return false;
    const tryVals = (vals: number[]) => {
      const v = [...vals].sort((a, b) => a - b);
      return v.every((x, i) => i === 0 || x - v[i - 1] === 1);
    };
    const low = cs.map((c) => rankValue(c.r));
    const high = low.map((v) => (v === 1 ? 14 : v));
    return tryVals(low) || tryVals(high);
  };
  if (pureSeq(cards)) return "pure";
  const naturals = cards.filter((c) => !isJoker(c));
  const jokers = cards.length - naturals.length;
  // Set: same rank, different suits, 3-4 cards (jokers fill gaps)
  if (cards.length <= 4 && naturals.length > 0 && naturals.every((c) => c.r === naturals[0].r) && new Set(naturals.map((c) => c.s)).size === naturals.length) return "set";
  // Impure sequence: same suit naturals, gaps filled by jokers
  if (naturals.length > 0 && naturals.every((c) => c.s === naturals[0].s)) {
    for (const aceHigh of [false, true]) {
      const v = naturals.map((c) => (aceHigh && c.r === "A" ? 14 : rankValue(c.r))).sort((a, b) => a - b);
      if (new Set(v).size !== v.length) continue;
      const gaps = v[v.length - 1] - v[0] + 1 - v.length;
      if (gaps <= jokers) return "impure";
    }
  }
  return "invalid";
}

export function Rummy({ nav, table, buyIn, mode, deals }: { nav: Nav; table: string; buyIn: number; mode: RummyMode; deals: number }) {
  const { total, debit, credit, showToast } = useStore();
  const [phase, setPhase] = useState<"idle" | "seating" | "play" | "done">("idle");
  const [seated, setSeated] = useState(0);
  const [stockN, setStockN] = useState(0);
  const stockRef = useRef<HC[]>([]);
  const [open, setOpenState] = useState<HC[]>([]);
  const openRef = useRef<HC[]>([]);
  const setOpen = (next: HC[]) => {
    openRef.current = next;
    setOpenState(next);
  };
  const [wild, setWild] = useState<Card>({ r: "5", s: "♣" });
  const [groups, setGroups] = useState<HC[][]>([]);
  const [sel, setSel] = useState<number[]>([]);
  const [drawn, setDrawn] = useState(false);
  const [turn, setTurn] = useState<"me" | number>("me");
  const [turnEnd, setTurnEnd] = useState(0);
  const [now, setNow] = useState(0);
  const newBots = (): RBot[] => pickBots(BOTS).map((b) => ({ name: b.name, emoji: b.emoji, dropped: false, middle: false, out: false, action: "" }));
  const [bots, setBotsState] = useState<RBot[]>(newBots);
  const botsRef = useRef(bots);
  const setBots = (next: RBot[]) => {
    botsRef.current = next;
    setBotsState(next);
  };
  const setBot = (i: number, patch: Partial<RBot>) => setBots(botsRef.current.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const botHands = useRef<HC[][]>([]);
  const round = useRef(1);
  const run = useRef(0); // bumps on every deal / leave so stale bot loops stop
  const me = useRef({ dropped: false, middle: false });

  // Match state across deals (Pool / Deals). Index 0 = you, 1..5 = the bots.
  const [dealNo, setDealNo] = useState(0);
  const totals = useRef<number[]>(Array(BOTS + 1).fill(0));
  const [matchOver, setMatchOver] = useState(false);
  const [lowBal, setLowBal] = useState(false);
  const [result, setResult] = useState<{ won: boolean; title: string; sub: string; rows: DealRow[] } | null>(null);
  const [sheet, setSheet] = useState(false);
  const [peek, setPeek] = useState(false);
  const matches = useRef(0);

  const pool = POOL_LIMIT[mode];
  const pv = buyIn; // points mode: rupees per point
  const hold = mode === "points" ? 80 * pv : buyIn; // points: max loss held as buy-in; others: entry fee
  const prize = Math.floor(buyIn * (BOTS + 1) * (1 - FEE));
  const label = `${MODE_LABEL[mode]} • Table #${table}`;
  const myTurn = phase === "play" && turn === "me" && !me.current.dropped;

  const hand = groups.flat();
  const kinds = useMemo(() => groups.map((g) => classify(g, wild.r)), [groups, wild]);
  const invalidPts = groups.reduce((a, g, i) => a + (kinds[i] === "invalid" ? g.reduce((x, h) => x + (h.c.r === wild.r ? 0 : points(h.c)), 0) : 0), 0);
  const myPts = useRef(0);
  useEffect(() => { myPts.current = Math.min(invalidPts, 80); });

  useEffect(() => () => { run.current++; }, []);

  useEffect(() => {
    if (phase !== "play") return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [phase]);

  // Draw from the closed deck; when it runs out, the open pile (minus its top card) is reshuffled in.
  const takeStock = (): HC => {
    if (stockRef.current.length === 0) {
      const [top, ...rest] = openRef.current;
      stockRef.current = rest.sort(() => Math.random() - 0.5);
      setOpen([top]);
      showToast("Closed deck reshuffled");
    }
    const [c, ...rest] = stockRef.current;
    stockRef.current = rest;
    setStockN(rest.length);
    return c;
  };

  // New match: pay the entry / buy-in, some seats change hands, players sit down one by one.
  const startMatch = async () => {
    if (!debit(hold, `${label} • ${mode === "points" ? "Buy-in" : "Entry"}`)) {
      setLowBal(true);
      setPhase("idle");
      setSheet(false);
      return showToast("Not enough balance — add cash");
    }
    setLowBal(false);
    const id = ++run.current;
    if (matches.current++ > 0) {
      const keep = botsRef.current.filter(() => Math.random() < 0.6);
      const joined = pickBots(BOTS - keep.length, keep.map((b) => b.name)).map((b) => ({ name: b.name, emoji: b.emoji, dropped: false, middle: false, out: false, action: "" }));
      setBots([...keep, ...joined].map((b) => ({ ...b, out: false, dropped: false, middle: false, action: "" })));
    }
    totals.current = Array(BOTS + 1).fill(0);
    setMatchOver(false);
    setDealNo(0);
    setResult(null);
    setSheet(false);
    setPhase("seating");
    setSeated(0);
    for (let i = 1; i <= BOTS; i++) {
      await sleep(250 + Math.random() * 350);
      if (run.current !== id) return;
      setSeated(i);
    }
    await sleep(400);
    if (run.current !== id) return;
    dealCards();
  };

  const dealCards = () => {
    run.current++;
    const d = twoDecks();
    const mine = d.splice(0, 13);
    botHands.current = Array.from({ length: BOTS }, () => d.splice(0, 13));
    setWild(d.pop()!.c);
    setOpen([d.pop()!]);
    stockRef.current = d;
    setStockN(d.length);
    setGroups([mine]);
    setSel([]);
    setDrawn(false);
    me.current = { dropped: false, middle: false };
    setBots(botsRef.current.map((b) => ({ ...b, dropped: b.out, middle: false, action: "" })));
    setDealNo((n) => n + 1);
    setResult(null);
    setSheet(false);
    setPeek(false);
    round.current = 1;
    setTurn("me");
    setTurnEnd(Date.now() + TURN * 1000);
    setPhase("play");
  };

  const sortHand = () => {
    const bySuit = SUITS.map((s) => hand.filter((h) => h.c.s === s).sort((a, b) => rankValue(a.c.r) - rankValue(b.c.r))).filter((g) => g.length);
    setGroups(bySuit);
    setSel([]);
  };

  const toggle = (id: number) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const makeGroup = () => {
    if (sel.length < 2) return showToast("Select 2 or more cards to group");
    const picked = hand.filter((h) => sel.includes(h.id));
    const rest = groups.map((g) => g.filter((h) => !sel.includes(h.id))).filter((g) => g.length);
    setGroups([...rest, picked]);
    setSel([]);
  };

  const draw = (from: "stock" | "open") => {
    if (!myTurn || drawn) return;
    let top: HC;
    if (from === "stock") top = takeStock();
    else {
      if (!openRef.current[0]) return;
      if (openRef.current[0].c.r === wild.r) return showToast("Can't pick a joker from the open deck");
      [top] = openRef.current;
      setOpen(openRef.current.slice(1));
    }
    setGroups((g) => [...g.slice(0, -1), [...g[g.length - 1], top]]);
    setDrawn(true);
  };

  const endMyTurn = () => {
    setSel([]);
    setDrawn(false);
    botsPlay(run.current);
  };

  const discard = () => {
    if (!drawn) return showToast("Draw a card first");
    if (sel.length !== 1) return showToast("Select one card to discard");
    const card = hand.find((h) => h.id === sel[0])!;
    setGroups((gs) => gs.map((g) => g.filter((h) => h.id !== card.id)).filter((g) => g.length));
    setOpen([card, ...openRef.current]);
    endMyTurn();
  };

  // Deal is over: score it, update the match, and decide whether the match continues.
  const endDeal = (winner: number, how: string, myWrong = false) => {
    run.current++;
    const bs = botsRef.current;
    const inDeal = [!isOut(0), ...bs.map((b) => !b.out)];
    const pts = inDeal.map((inPlay, p) => {
      if (!inPlay || p === winner) return 0;
      if (p === 0) return myWrong ? 80 : me.current.dropped ? dropPts(mode, me.current.middle) : myPts.current;
      const b = bs[p - 1];
      return b.dropped ? dropPts(mode, b.middle) : 10 + Math.floor(Math.random() * Math.random() * 71);
    });
    const note = (p: number) => {
      if (!inDeal[p]) return "Out";
      if (p === winner) return "Declared";
      if (p === 0) return myWrong ? "Wrong show" : me.current.dropped ? (me.current.middle ? "Middle drop" : "Drop") : "Lost";
      const b = bs[p - 1];
      return b.dropped ? (b.middle ? "Middle drop" : "Drop") : "Lost";
    };
    const t = totals.current;
    if (mode === "deals") {
      pts.forEach((x, p) => { t[p] -= x; });
      t[winner] += pts.reduce((a, b) => a + b, 0);
    } else pts.forEach((x, p) => { t[p] += x; });

    const names = ["You", ...bs.map((b) => b.name)];
    let over = true;
    let won = false;
    let title = "";
    let sub = "";
    if (mode === "points") {
      const pool = pts.reduce((a, b) => a + b, 0);
      if (winner === 0) {
        const win = Math.floor(pool * pv * (1 - FEE) * 100) / 100;
        credit(hold + win, label);
        won = true;
        title = `You won ${inr(win)}!`;
        sub = `${pool} points × ₹${pv}/point`;
      } else {
        const loss = Math.round(pts[0] * pv * 100) / 100;
        if (hold - loss > 0) credit(hold - loss, `${label} • Buy-in refund`, "Buy-in Refund");
        title = `${names[winner]} ${how}`;
        sub = `You lose ${pts[0]} points × ₹${pv} = ${inr(loss)}`;
      }
    } else if (pool) {
      const newlyOut = bs.map((b, i) => (!b.out && t[i + 1] >= pool ? i : -1)).filter((i) => i >= 0);
      if (newlyOut.length) setBots(botsRef.current.map((b, i) => (newlyOut.includes(i) ? { ...b, out: true } : b)));
      const botsLeft = bs.filter((b, i) => !b.out && !newlyOut.includes(i)).length;
      if (t[0] >= pool) {
        title = `You're out at ${t[0]} points`;
        sub = `${MODE_LABEL[mode]}: crossing ${pool} eliminates you`;
      } else if (botsLeft === 0) {
        credit(prize, label);
        won = true;
        title = `You won ${inr(prize)}!`;
        sub = `Last player standing in ${MODE_LABEL[mode]}`;
      } else {
        over = false;
        won = winner === 0;
        title = winner === 0 ? "You won this deal!" : `${names[winner]} ${how}`;
        sub = `Deal ${dealNo} • ${botsLeft + 1} players left under ${pool}`;
      }
    } else {
      if (dealNo < deals) {
        over = false;
        won = winner === 0;
        title = winner === 0 ? "You won this deal!" : `${names[winner]} ${how}`;
        sub = `Deal ${dealNo} of ${deals} • chips carry over`;
      } else {
        const best = t.indexOf(Math.max(...t));
        won = best === 0;
        if (won) credit(prize, label);
        title = won ? `You won ${inr(prize)}!` : `${names[best]} wins the match`;
        sub = `After ${deals} deals • most chips wins`;
      }
    }
    const rows: DealRow[] = names.map((name, p) => ({ name, pts: pts[p], total: t[p], note: note(p), out: pool ? t[p] >= pool : false, winner: p === winner }));
    setResult({ won, title, sub, rows });
    setMatchOver(over);
    setTurn("me");
    setPhase("done");
    window.setTimeout(() => setSheet(true), 1500);
  };

  function isOut(p: number) {
    return !!pool && totals.current[p] >= pool;
  }

  // Opponents take their turns one by one, each with a 30 s clock and a human-ish pace.
  // If you dropped, the rest keep playing until someone declares.
  const botsPlay = async (id: number) => {
    const alive = () => run.current === id;
    for (let i = 0; i < BOTS; i++) {
      const b = botsRef.current[i];
      if (b.dropped || b.out) continue;
      const delay = humanDelay(TURN);
      setTurn(i);
      setTurnEnd(Date.now() + TURN * 1000);
      setBot(i, { action: "Thinking…" });

      // Drops happen early: first drop in round 1, middle drop in rounds 2-4.
      const stillIn = botsRef.current.filter((x) => !x.dropped && !x.out).length + (me.current.dropped ? 0 : 1);
      const dropChance = round.current === 1 ? 0.1 : round.current <= 4 ? 0.05 : 0;
      if (stillIn > 2 && Math.random() < dropChance) {
        await sleep(Math.min(delay, 5) * 1000);
        if (!alive()) return;
        const middle = round.current > 1;
        setBot(i, { dropped: true, middle, action: middle ? "Middle drop" : "Dropped" });
        showToast(`${b.name} ${middle ? "middle-dropped" : "dropped"}`);
        await sleep(600);
        if (!alive()) return;
        continue;
      }

      await sleep(delay * 450);
      if (!alive()) return;
      const hand = botHands.current[i];
      const top = openRef.current[0];
      const fromOpen = !!top && top.c.r !== wild.r && Math.random() < 0.3;
      let picked: HC;
      if (fromOpen) {
        picked = top;
        setOpen(openRef.current.slice(1));
      } else picked = takeStock();
      hand.push(picked);
      setBot(i, { action: fromOpen ? "Picked from Open" : "Picked from Closed" });

      await sleep(delay * 550);
      if (!alive()) return;

      // Later in the deal a bot may go out.
      const declareChance = round.current >= 5 ? 0.05 + (me.current.dropped ? 0.08 : 0) + (round.current - 5) * 0.01 : 0;
      if (Math.random() < declareChance) {
        setBot(i, { action: "Declared!" });
        showToast(`${b.name} declared`);
        await sleep(1200);
        if (!alive()) return;
        return endDeal(i + 1, "declared & won");
      }

      const out = !fromOpen && Math.random() < 0.55 ? hand.length - 1 : Math.floor(Math.random() * (hand.length - 1));
      const [thrown] = hand.splice(out, 1);
      setOpen([thrown, ...openRef.current]);
      setBot(i, { action: delay >= TURN ? "Timed out • auto" : `Discarded ${thrown.c.r}${thrown.c.s}` });
      await sleep(350);
      if (!alive()) return;
    }
    const left = botsRef.current.map((b, i) => (b.dropped || b.out ? -1 : i)).filter((i) => i >= 0);
    if (!me.current.dropped && !left.length) return endDeal(0, "won", false);
    if (me.current.dropped && left.length === 1) return endDeal(left[0] + 1, "wins — everyone else dropped");
    round.current += 1;
    if (me.current.dropped) return botsPlay(id);
    setTurn("me");
    setTurnEnd(Date.now() + TURN * 1000);
  };

  // Your turn times out → auto-play (PRD §6.1): draw from closed and throw it back.
  useEffect(() => {
    if (!myTurn || !turnEnd || now <= turnEnd) return;
    showToast("Time's up — auto-play");
    if (drawn) {
      const last = groups[groups.length - 1];
      const card = last[last.length - 1];
      setGroups((gs) => gs.map((g) => g.filter((h) => h.id !== card.id)).filter((g) => g.length));
      setOpen([card, ...openRef.current]);
    } else {
      setOpen([takeStock(), ...openRef.current]);
    }
    setTurnEnd(0);
    endMyTurn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);

  const declare = () => {
    if (hand.length !== 13) return showToast("Discard a card before declaring");
    const pure = kinds.filter((k) => k === "pure").length;
    const seqs = kinds.filter((k) => k === "pure" || k === "impure").length;
    const valid = pure >= 1 && seqs >= 2 && kinds.every((k) => k !== "invalid");
    if (valid) {
      myPts.current = 0;
      return endDeal(0, "declared");
    }
    // Wrong show: 80 points, and the deal goes to the best remaining player.
    showToast("Wrong declaration — 80 points");
    const alive = botsRef.current.map((b, i) => (b.dropped || b.out ? -1 : i)).filter((i) => i >= 0);
    endDeal((alive[Math.floor(Math.random() * alive.length)] ?? 0) + 1, "wins after your wrong show", true);
  };

  const drop = () => {
    const middle = drawn || round.current > 1;
    me.current = { dropped: true, middle };
    setSel([]);
    setDrawn(false);
    showToast(`You ${middle ? "middle-dropped" : "dropped"} • ${dropPts(mode, middle)} points`);
    botsPlay(run.current);
  };

  // Demo helper: arrange a guaranteed-valid hand so the client can see a successful declare.
  const demoWin = () => {
    const mk = (r: Card["r"], s: Card["s"]): HC => ({ id: uid++, c: { r, s } });
    setWild({ r: "Q", s: "♦" });
    setGroups([
      [mk("4", "♥"), mk("5", "♥"), mk("6", "♥")],
      [mk("9", "♠"), mk("10", "♠"), mk("J", "♠"), mk("Q", "♠")],
      [mk("2", "♣"), mk("Q", "♥"), mk("4", "♣")],
      [mk("K", "♠"), mk("K", "♥"), mk("K", "♦")],
    ]);
    setSel([]);
    setDrawn(false);
  };

  // No "Play Again": the table seats you and deals automatically, and keeps dealing after every result.
  const firstIn = useAutoNext(phase === "idle" && !lowBal, 3, startMatch);
  const nextIn = useAutoNext(phase === "done" && sheet, NEXT_GAME_SECS, () => (matchOver ? startMatch() : dealCards()));

  const left = Math.min(TURN, Math.max(0, (turnEnd - now) / 1000));
  const secs = Math.ceil(left);
  const botTurn = phase === "play" && typeof turn === "number" ? bots[turn] : null;
  const stakeText = mode === "points" ? `₹${pv}/point` : `Entry ₹${buyIn}`;
  const sub = `${MODE_LABEL[mode]}${mode === "deals" ? ` ×${deals}` : ""}${dealNo && mode !== "points" ? ` • Deal ${dealNo}` : ""} • Table #${table} • ${stakeText}`;
  const scoreOf = (p: number) => (mode === "points" ? null : mode === "deals" ? `${totals.current[p] >= 0 ? "+" : ""}${totals.current[p]}` : `${totals.current[p]}/${pool}`);

  return (
    <div className="min-h-dvh flex flex-col pb-5 fadein">
      <Header title="Rummy" sub={sub} onBack={nav.back} right={<Money n={total} className="text-sm font-semibold text-neon-400" />} />

      <div className="px-2">
        <div className="grid grid-cols-5 gap-1">
          {bots.map((b, i) => {
            const here = phase === "play" || phase === "done" || (phase === "seating" && i < seated);
            const active = phase === "play" && turn === i;
            return (
              <div key={b.name} className={`flex flex-col items-center transition-opacity ${here ? "opacity-100" : "opacity-25"}`}>
                <TimerAvatar emoji={b.emoji} size={38} active={active} left={active ? left : 0} dim={b.dropped || b.out} total={TURN} />
                <div className={`text-[10px] mt-1.5 font-medium truncate max-w-full ${active ? "text-neon-400" : ""}`}>{b.name}</div>
                {here && scoreOf(i + 1) && <div className="text-[8.5px] text-gold-300 leading-tight">{scoreOf(i + 1)}</div>}
                {b.out ? (
                  <div className="text-[8px] pill px-1.5 py-0.5 mt-0.5 bg-white/10 text-white/60 font-semibold">OUT</div>
                ) : b.dropped ? (
                  <div className="text-[8px] pill px-1.5 py-0.5 mt-0.5 bg-rose-500/25 text-rose-200 font-semibold">{b.action.toUpperCase()}</div>
                ) : (
                  <>
                    <div className="flex -space-x-4 mt-0.5 scale-[.6] origin-top h-5">{here && Array.from({ length: 4 }, (_, j) => <PlayingCard key={j} faceDown size="xs" />)}</div>
                    <div className={`text-[8.5px] leading-tight text-center h-5 ${active ? "text-white" : "text-white/45"}`}>{phase === "play" ? b.action : here && phase === "seating" ? "Joined" : ""}</div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="felt rounded-[36px] mt-4 mx-2 p-4 flex items-center justify-center gap-5" style={{ minHeight: 150 }}>
          {phase === "idle" ? (
            lowBal ? (
              <div className="text-center">
                <div className="text-xs text-white/70">Not enough balance for {mode === "points" ? `the ${inr(hold)} buy-in` : `the ${inr(hold)} entry`}</div>
                <button onClick={() => nav.push({ name: "addcash" })} className="btn-green pill px-6 py-2.5 mt-2 text-sm">Add Cash</button>
                <button onClick={startMatch} className="block mx-auto text-[11px] text-white/50 mt-2">Try again</button>
              </div>
            ) : (
              <div className="text-center">
                <div className="text-sm font-semibold">Joining table…</div>
                <div className="text-xs text-white/70 mt-1">Seating in {firstIn}s</div>
              </div>
            )
          ) : phase === "seating" ? (
            <div className="text-center">
              <div className="text-sm font-semibold">Waiting for players…</div>
              <div className="text-xs text-white/70 mt-1">{seated + 1}/6 seated</div>
            </div>
          ) : phase === "done" && result ? (
            <div className="text-center fadein">
              <div className="text-sm font-semibold">{result.title}</div>
              <div className="text-[11px] text-white/70 mt-1">{sheet ? `${matchOver ? "Next game" : "Next deal"} in ${nextIn}s` : "Validating cards…"}</div>
            </div>
          ) : (
            <>
              <button onClick={() => draw("stock")} className="flex flex-col items-center gap-1">
                <div className="relative"><PlayingCard faceDown size="md" /><PlayingCard faceDown size="md" className="absolute -top-1 -left-1" /></div>
                <span className="text-[10px] text-white/70">Closed ({stockN})</span>
              </button>
              <button onClick={() => draw("open")} className="flex flex-col items-center gap-1">
                {open[0] ? <PlayingCard key={open[0].id} card={open[0].c} size="md" className="flip" /> : <div className="w-12 h-[68px] rounded-lg border-2 border-dashed border-white/30" />}
                <span className="text-[10px] text-white/70">Open</span>
              </button>
              <div className="flex flex-col items-center gap-1">
                <PlayingCard card={wild} size="sm" className="ring-2 ring-gold-300" />
                <span className="text-[10px] text-gold-300">Wild Joker</span>
              </div>
            </>
          )}
        </div>

        {phase === "play" && (
          <div className="mt-2 text-center text-xs h-5">
            {me.current.dropped ? (
              <span className="text-white/60">You dropped — {botTurn ? `${botTurn.name}'s turn • ${secs}s` : "waiting for this deal to finish"}</span>
            ) : myTurn ? (
              <span className={secs <= 5 ? "text-rose-400 font-semibold" : "text-neon-400"}>Your turn • {drawn ? "select a card and discard" : "draw from Closed or Open"} • {secs}s</span>
            ) : botTurn ? (
              <span className="text-white/70">{botTurn.name}&apos;s turn • {secs}s</span>
            ) : null}
          </div>
        )}
      </div>

      {/* Hand, grouped */}
      <div className={`px-2 mt-3 flex flex-wrap gap-x-3 gap-y-5 justify-center min-h-[130px] ${me.current.dropped && phase === "play" ? "opacity-40" : ""}`}>
        {groups.map((g, gi) => (
          <div key={gi} className="flex flex-col items-center">
            <div className={`text-[9px] pill px-2 py-0.5 mb-2 ${kinds[gi] === "invalid" ? "bg-rose-500/20 text-rose-300" : "bg-neon-400/15 text-neon-400"}`}>
              {KIND_LABEL[kinds[gi]]}{kinds[gi] !== "invalid" ? " ✓" : ""}
            </div>
            <div className="flex pl-6">
              {g.map((h) => (
                <PlayingCard key={h.id} card={h.c} size="md" selected={sel.includes(h.id)} onClick={() => toggle(h.id)} className={`-ml-6 ${h.c.r === wild.r ? "outline-2 outline-gold-300" : ""}`} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {phase === "play" && !me.current.dropped && (
        <div className="px-3 mt-auto pt-4">
          <div className="text-center text-[11px] text-white/50 mb-2">
            Points in hand: <b className="text-white">{invalidPts}</b> • {hand.length} cards
            {mode === "points" ? <> • ₹{pv}/pt</> : pool ? <> • Your score <b className="text-white">{totals.current[0]}/{pool}</b></> : <> • Chips <b className="text-white">{scoreOf(0)}</b></>}
          </div>
          <div className="grid grid-cols-5 gap-1.5 text-[11px]">
            <button onClick={sortHand} className="btn-ghost rounded-xl py-2.5 flex flex-col items-center gap-0.5"><ArrowDownUp size={15} />Sort</button>
            <button onClick={makeGroup} className="btn-ghost rounded-xl py-2.5 flex flex-col items-center gap-0.5"><Layers size={15} />Group</button>
            <button disabled={!myTurn} onClick={discard} className="rounded-xl py-2.5 bg-sky-500 font-semibold disabled:opacity-40">Discard</button>
            <button disabled={!myTurn} onClick={drop} className="rounded-xl py-2.5 bg-[#1b2350] border border-white/10 disabled:opacity-40">Drop</button>
            <button disabled={!myTurn} onClick={declare} className="btn-green rounded-xl py-2.5">Declare</button>
          </div>
          <button onClick={demoWin} className="w-full text-center text-[11px] text-white/40 mt-3 border border-dashed border-white/15 rounded-xl py-2">Demo: arrange a winning hand</button>
        </div>
      )}

      {result && (
        <ResultSheet open={phase === "done" && sheet && !peek} won={result.won} title={result.title} sub={result.sub} left={nextIn} nextLabel={matchOver ? undefined : `Deal ${dealNo + 1} starts in`} onLeave={nav.back} onClose={() => setPeek(true)}>
          <div className="mt-4 rounded-xl bg-white/5 overflow-hidden text-left">
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-3 py-2 text-[10px] text-white/50 border-b border-white/5">
              <span>Player</span><span className="text-right">{mode === "deals" ? "Deal" : "Points"}</span><span className="text-right w-14">{mode === "points" ? "Result" : mode === "deals" ? "Chips" : "Total"}</span>
            </div>
            {result.rows.map((r) => (
              <div key={r.name} className={`grid grid-cols-[1fr_auto_auto] gap-x-4 px-3 py-1.5 text-xs ${r.name === "You" ? "bg-neon-400/10" : ""}`}>
                <span className="truncate">{r.winner && "🏆 "}{r.name} <span className="text-[10px] text-white/40">{r.note}</span></span>
                <span className="text-right tabular-nums">{r.winner ? 0 : mode === "deals" ? `-${r.pts}` : r.pts}</span>
                <span className={`text-right tabular-nums w-14 ${r.out ? "text-rose-300" : ""}`}>
                  {mode === "points" ? (r.winner ? "Won" : `-${inr(r.pts * pv)}`) : mode === "deals" ? `${r.total >= 0 ? "+" : ""}${r.total}` : r.out ? `${r.total} out` : r.total}
                </span>
              </div>
            ))}
          </div>
          {!matchOver && <div className="text-[10px] text-white/40 mt-2">Match continues — same table, same players</div>}
          {mode !== "points" && matchOver && <div className="text-[10px] text-white/40 mt-2">Prize pool {inr(prize)} • Platform fee {FEE * 100}%</div>}
        </ResultSheet>
      )}
    </div>
  );
}
