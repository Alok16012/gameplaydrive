"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownUp, Layers, Trophy } from "lucide-react";
import { AVATARS, BOT_NAMES, RANKS, SUITS, inr, rankValue, type Card } from "../../lib/data";
import { useStore } from "../../lib/store";
import { Header, Money, PlayingCard, Sheet } from "../ui";
import { TURN_SECS, TimerAvatar, humanDelay, sleep } from "./bots";
import type { Nav } from "../nav";

// 13 Card Rummy demo (PRD §6.1). Two decks; valid declare = 1 pure sequence + 1 more sequence,
// all remaining cards in valid sets/sequences. The server validates declares in production.

interface HC {
  id: number;
  c: Card;
}

type GroupKind = "pure" | "impure" | "set" | "invalid";
const KIND_LABEL: Record<GroupKind, string> = { pure: "Pure Sequence", impure: "Sequence", set: "Set", invalid: "Invalid" };

const BOTS = 5; // 6 players at the table: you + 5
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

export function Rummy({ nav, table, buyIn }: { nav: Nav; table: string; buyIn: number }) {
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
  const [bots, setBotsState] = useState(() => BOT_NAMES.slice(0, BOTS).map((name, i) => ({ name, emoji: AVATARS[(i + 1) % AVATARS.length], dropped: false, action: "" })));
  const botsRef = useRef(bots);
  const setBot = (i: number, patch: Partial<(typeof bots)[number]>) => {
    botsRef.current = botsRef.current.map((b, j) => (j === i ? { ...b, ...patch } : b));
    setBotsState(botsRef.current);
  };
  const botHands = useRef<HC[][]>([]);
  const round = useRef(1);
  const run = useRef(0); // bumps on every deal / leave so stale bot loops stop
  const [result, setResult] = useState<{ won: boolean; title: string; sub: string } | null>(null);
  const label = `Rummy • Table #${table}`;
  const myTurn = phase === "play" && turn === "me";

  const hand = groups.flat();
  const kinds = useMemo(() => groups.map((g) => classify(g, wild.r)), [groups, wild]);
  const invalidPts = groups.reduce((a, g, i) => a + (kinds[i] === "invalid" ? g.reduce((x, h) => x + (h.c.r === wild.r ? 0 : points(h.c)), 0) : 0), 0);
  const prize = Math.floor(buyIn * (BOTS + 1) * 0.9);

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

  const deal = async () => {
    if (!debit(buyIn, `${label} • Entry`)) return showToast("Not enough balance — add cash");
    const id = ++run.current;
    setResult(null);
    setPhase("seating");
    setSeated(0);
    botsRef.current = botsRef.current.map((b) => ({ ...b, dropped: false, action: "" }));
    setBotsState(botsRef.current);
    for (let i = 1; i <= BOTS; i++) {
      await sleep(250 + Math.random() * 350);
      if (run.current !== id) return;
      setSeated(i);
    }
    await sleep(400);
    if (run.current !== id) return;
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
    round.current = 1;
    setTurn("me");
    setTurnEnd(Date.now() + TURN_SECS * 1000);
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

  const loseTo = (name: string) => {
    setResult({ won: false, title: `${name} declared & won`, sub: `Valid declaration by ${name}. You lose with ${Math.min(invalidPts, 80)} points.` });
    setPhase("done");
  };

  // Opponents take their turns one by one, each with its own 15 s clock and a human-ish pace.
  const botsPlay = async (id: number) => {
    const alive = () => run.current === id;
    for (let i = 0; i < BOTS; i++) {
      const b = botsRef.current[i];
      if (b.dropped) continue;
      const delay = humanDelay();
      setTurn(i);
      setTurnEnd(Date.now() + TURN_SECS * 1000);
      setBot(i, { action: "Thinking…" });

      // Drops happen early: first drop in round 1, middle drop in rounds 2-4.
      const stillIn = botsRef.current.filter((x) => !x.dropped).length;
      const dropChance = round.current === 1 ? 0.1 : round.current <= 4 ? 0.05 : 0;
      if (stillIn > 1 && Math.random() < dropChance) {
        await sleep(Math.min(delay, 5) * 1000);
        if (!alive()) return;
        setBot(i, { dropped: true, action: round.current === 1 ? "Dropped" : "Middle drop" });
        showToast(`${b.name} ${round.current === 1 ? "dropped" : "middle-dropped"}`);
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

      // Late in the game a bot may go out.
      if (round.current >= 5 && Math.random() < 0.05) {
        setBot(i, { action: "Declared!" });
        await sleep(900);
        if (!alive()) return;
        return loseTo(b.name);
      }

      const out = !fromOpen && Math.random() < 0.55 ? hand.length - 1 : Math.floor(Math.random() * (hand.length - 1));
      const [thrown] = hand.splice(out, 1);
      setOpen([thrown, ...openRef.current]);
      setBot(i, { action: delay >= TURN_SECS ? "Timed out • auto" : `Discarded ${thrown.c.r}${thrown.c.s}` });
      await sleep(350);
      if (!alive()) return;
    }
    if (botsRef.current.every((b) => b.dropped)) {
      credit(prize, label);
      setResult({ won: true, title: `You won ${inr(prize)}!`, sub: "All other players dropped" });
      setPhase("done");
      return;
    }
    round.current += 1;
    setTurn("me");
    setTurnEnd(Date.now() + TURN_SECS * 1000);
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
    run.current++;
    if (valid) {
      credit(prize, label);
      setResult({ won: true, title: `You won ${inr(prize)}!`, sub: "Valid declaration • 0 points" });
    } else {
      setResult({ won: false, title: "Wrong declaration", sub: `Needs 1 pure sequence + 1 more sequence, rest in sets/sequences. Penalty: 80 points.` });
    }
    setPhase("done");
  };

  const drop = () => {
    run.current++;
    setResult({ won: false, title: "You dropped", sub: drawn || round.current > 1 ? "Middle drop • 40 points" : "First drop • 20 points" });
    setPhase("done");
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

  const left = Math.min(TURN_SECS, Math.max(0, (turnEnd - now) / 1000));
  const secs = Math.ceil(left);
  const botTurn = phase === "play" && typeof turn === "number" ? bots[turn] : null;

  return (
    <div className="min-h-dvh flex flex-col pb-5 fadein">
      <Header title="Rummy" sub={`13 Card • Table #${table} • 6 Players • Entry ₹${buyIn}`} onBack={nav.back} right={<Money n={total} className="text-sm font-semibold text-neon-400" />} />

      <div className="px-2">
        <div className="grid grid-cols-5 gap-1">
          {bots.map((b, i) => {
            const here = phase === "play" || phase === "done" || (phase === "seating" && i < seated);
            const active = phase === "play" && turn === i;
            return (
              <div key={b.name} className={`flex flex-col items-center transition-opacity ${here ? "opacity-100" : "opacity-25"}`}>
                <TimerAvatar emoji={b.emoji} size={38} active={active} left={active ? left : 0} dim={b.dropped} />
                <div className={`text-[10px] mt-1.5 font-medium ${active ? "text-neon-400" : ""}`}>{b.name}</div>
                {b.dropped ? (
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
            <button onClick={deal} className="btn-green pill px-6 py-2.5 text-sm">Deal Cards • Entry ₹{buyIn}</button>
          ) : phase === "seating" ? (
            <div className="text-center">
              <div className="text-sm font-semibold">Waiting for players…</div>
              <div className="text-xs text-white/70 mt-1">{seated + 1}/6 seated</div>
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
            {myTurn ? (
              <span className={secs <= 5 ? "text-rose-400 font-semibold" : "text-neon-400"}>Your turn • {drawn ? "select a card and discard" : "draw from Closed or Open"} • {secs}s</span>
            ) : botTurn ? (
              <span className="text-white/70">{botTurn.name}&apos;s turn • {secs}s</span>
            ) : null}
          </div>
        )}
      </div>

      {/* Hand, grouped */}
      <div className="px-2 mt-3 flex flex-wrap gap-x-3 gap-y-5 justify-center min-h-[130px]">
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

      {phase === "play" && (
        <div className="px-3 mt-auto pt-4">
          <div className="text-center text-[11px] text-white/50 mb-2">Points in hand: <b className="text-white">{invalidPts}</b> • {hand.length} cards • Prize {inr(prize)}</div>
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

      <Sheet open={phase === "done" && !!result} onClose={() => setPhase("idle")}>
        {result && (
          <div className="text-center">
            <div className="pop inline-grid place-items-center w-20 h-20 rounded-full" style={{ background: result.won ? "radial-gradient(circle,#fde68a,#f59e0b)" : "rgba(255,255,255,.08)" }}>
              {result.won ? <Trophy size={40} className="text-amber-900" /> : <span className="text-4xl">😔</span>}
            </div>
            <div className="text-2xl font-semibold mt-3">{result.title}</div>
            <div className="text-sm text-[var(--ink-soft)] mt-1 px-4">{result.sub}</div>
            <div className="grid grid-cols-2 gap-3 mt-6">
              <button onClick={nav.back} className="btn-ghost py-3 rounded-2xl">Leave Table</button>
              <button onClick={deal} className="btn-green py-3 rounded-2xl">Play Again</button>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
}
