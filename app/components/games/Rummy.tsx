"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownUp, Layers, Trophy } from "lucide-react";
import { AVATARS, BOT_NAMES, RANKS, SUITS, inr, rankValue, type Card } from "../../lib/data";
import { useStore } from "../../lib/store";
import { Avatar, Header, Money, PlayingCard, Sheet } from "../ui";
import type { Nav } from "../nav";

// 13 Card Rummy demo (PRD §6.1). Two decks; valid declare = 1 pure sequence + 1 more sequence,
// all remaining cards in valid sets/sequences. The server validates declares in production.

interface HC {
  id: number;
  c: Card;
}

type GroupKind = "pure" | "impure" | "set" | "invalid";
const KIND_LABEL: Record<GroupKind, string> = { pure: "Pure Sequence", impure: "Sequence", set: "Set", invalid: "Invalid" };

const TURN_SECS = 30;
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
  const [phase, setPhase] = useState<"idle" | "play" | "done">("idle");
  const [stock, setStockState] = useState<HC[]>([]);
  const stockRef = useRef<HC[]>([]);
  const setStock = (next: HC[]) => {
    stockRef.current = next;
    setStockState(next);
  };
  const [open, setOpen] = useState<HC[]>([]);
  const [wild, setWild] = useState<Card>({ r: "5", s: "♣" });
  const [groups, setGroups] = useState<HC[][]>([]);
  const [sel, setSel] = useState<number[]>([]);
  const [drawn, setDrawn] = useState(false);
  const [myTurn, setMyTurn] = useState(true);
  const [botMsg, setBotMsg] = useState("");
  const [timerEnd, setTimerEnd] = useState(0);
  const [now, setNow] = useState(0);
  const [result, setResult] = useState<{ won: boolean; title: string; sub: string } | null>(null);
  const label = `Rummy • Table #${table}`;

  const hand = groups.flat();
  const kinds = useMemo(() => groups.map((g) => classify(g, wild.r)), [groups, wild]);
  const invalidPts = groups.reduce((a, g, i) => a + (kinds[i] === "invalid" ? g.reduce((x, h) => x + (h.c.r === wild.r ? 0 : points(h.c)), 0) : 0), 0);

  const deal = () => {
    if (!debit(buyIn, `${label} • Entry`)) return showToast("Not enough balance — add cash");
    const d = twoDecks();
    const mine = d.splice(0, 13);
    const w = d.pop()!;
    setWild(w.c);
    setOpen([d.pop()!]);
    setStock(d);
    setGroups([mine]);
    setSel([]);
    setDrawn(false);
    setMyTurn(true);
    setTimerEnd(Date.now() + TURN_SECS * 1000);
    setPhase("play");
    setResult(null);
  };

  useEffect(() => {
    if (phase !== "play" || !myTurn) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [phase, myTurn]);

  const secs = Math.max(0, Math.ceil((timerEnd - now) / 1000));

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
    if (!myTurn || drawn || phase !== "play") return;
    if (from === "stock") {
      const [top, ...rest] = stockRef.current;
      setStock(rest);
      setGroups((g) => [...g.slice(0, -1), [...g[g.length - 1], top]]);
    } else {
      if (open[0].c.r === wild.r) return showToast("Can't pick a joker from the open deck");
      const [top, ...rest] = open;
      setOpen(rest);
      setGroups((g) => [...g.slice(0, -1), [...g[g.length - 1], top]]);
    }
    setDrawn(true);
  };

  const discard = () => {
    if (!drawn) return showToast("Draw a card first");
    if (sel.length !== 1) return showToast("Select one card to discard");
    const card = hand.find((h) => h.id === sel[0])!;
    setGroups((gs) => gs.map((g) => g.filter((h) => h.id !== card.id)).filter((g) => g.length));
    setOpen((o) => [card, ...o]);
    setSel([]);
    setDrawn(false);
    setMyTurn(false);
    botsPlay();
  };

  const botsPlay = () => {
    let i = 0;
    const step = () => {
      if (i >= 3) {
        setBotMsg("");
        setMyTurn(true);
        setTimerEnd(Date.now() + TURN_SECS * 1000);
        return;
      }
      const name = BOT_NAMES[i];
      const [top, ...rest] = stockRef.current;
      setStock(rest);
      setOpen((o) => [top, ...o]);
      setBotMsg(`${name} drew and discarded ${top.c.r}${top.c.s}`);
      i++;
      setTimeout(step, 900);
    };
    setTimeout(step, 400);
  };

  // Auto-play on timeout (PRD §6.1): draw from stock and discard it.
  useEffect(() => {
    if (phase === "play" && myTurn && timerEnd && now > timerEnd) {
      showToast("Time's up — auto-play");
      if (drawn) {
        const last = groups[groups.length - 1];
        const card = last[last.length - 1];
        setGroups((gs) => gs.map((g) => g.filter((h) => h.id !== card.id)).filter((g) => g.length));
        setOpen((o) => [card, ...o]);
      }
      setTimerEnd(Date.now() + TURN_SECS * 1000);
      setMyTurn(false);
      setDrawn(false);
      setSel([]);
      botsPlay();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);

  const declare = () => {
    if (hand.length !== 13) return showToast("Discard a card before declaring");
    const pure = kinds.filter((k) => k === "pure").length;
    const seqs = kinds.filter((k) => k === "pure" || k === "impure").length;
    const valid = pure >= 1 && seqs >= 2 && kinds.every((k) => k !== "invalid");
    if (valid) {
      const prize = Math.floor(buyIn * 4 * 0.9);
      credit(prize, label);
      setResult({ won: true, title: `You won ${inr(prize)}!`, sub: "Valid declaration • 0 points" });
    } else {
      setResult({ won: false, title: "Wrong declaration", sub: `Needs 1 pure sequence + 1 more sequence, rest in sets/sequences. Penalty: 80 points.` });
    }
    setPhase("done");
  };

  const drop = () => {
    setResult({ won: false, title: "You dropped", sub: drawn ? "Middle drop • 40 points" : "First drop • 20 points" });
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

  return (
    <div className="min-h-dvh flex flex-col pb-5 fadein">
      <Header title="Rummy" sub={`13 Card • Table #${table} • Entry ₹${buyIn}`} onBack={nav.back} right={<Money n={total} className="text-sm font-semibold text-neon-400" />} />

      <div className="px-3">
        <div className="flex justify-around">
          {BOT_NAMES.slice(0, 3).map((n, i) => (
            <div key={n} className="flex flex-col items-center">
              <div className={`rounded-full ${!myTurn && botMsg.startsWith(n) ? "pulse-ring" : ""}`}><Avatar emoji={AVATARS[i + 1]} size={40} /></div>
              <div className="text-[10px] mt-1">{n}</div>
              <div className="flex -space-x-4 mt-0.5 scale-75">{Array.from({ length: 4 }, (_, j) => <PlayingCard key={j} faceDown size="xs" />)}</div>
            </div>
          ))}
        </div>

        <div className="felt rounded-[36px] mt-6 mx-2 p-4 flex items-center justify-center gap-5" style={{ minHeight: 150 }}>
          {phase === "idle" ? (
            <button onClick={deal} className="btn-green pill px-6 py-2.5 text-sm">Deal Cards • Entry ₹{buyIn}</button>
          ) : (
            <>
              <button onClick={() => draw("stock")} className="flex flex-col items-center gap-1">
                <div className="relative"><PlayingCard faceDown size="md" /><PlayingCard faceDown size="md" className="absolute -top-1 -left-1" /></div>
                <span className="text-[10px] text-white/70">Closed ({stock.length})</span>
              </button>
              <button onClick={() => draw("open")} className="flex flex-col items-center gap-1">
                {open[0] ? <PlayingCard card={open[0].c} size="md" /> : <div className="w-12 h-[68px] rounded-lg border-2 border-dashed border-white/30" />}
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
              <span className={secs <= 10 ? "text-rose-400" : "text-neon-400"}>Your turn • {drawn ? "select a card and discard" : "draw from Closed or Open"} • {secs}s</span>
            ) : (
              <span className="text-white/60">{botMsg || "Opponents playing…"}</span>
            )}
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
          <div className="text-center text-[11px] text-white/50 mb-2">Points in hand: <b className="text-white">{invalidPts}</b> • {hand.length} cards</div>
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
