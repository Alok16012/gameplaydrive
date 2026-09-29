"use client";

import { useEffect, useRef, useState } from "react";
import { History, RotateCcw, Repeat, Undo2, Users } from "lucide-react";
import { deck, gameById, inr, rankValue, randomCard, type Card, type GameId } from "../../lib/data";
import { useStore } from "../../lib/store";
import { Chip, Header, Money, PlayingCard } from "../ui";
import type { Nav } from "../nav";

// Timer-sync casino games (PRD §6.2). In production the round clock, deal and result all come from the
// server; here a local loop simulates it: 15 s betting → deal → result → payout → next round.

const BET_SECS = 15;
const CHIPS: { v: number; c: string }[] = [
  { v: 10, c: "#2563eb" },
  { v: 50, c: "#16a34a" },
  { v: 100, c: "#e11d48" },
  { v: 500, c: "#7c3aed" },
  { v: 1000, c: "#d97706" },
];

interface Side {
  id: string;
  label: string;
  odds: string;
  pay: number; // total return multiple on win (stake included)
  color: string;
}

const SIDES: Record<string, Side[]> = {
  "dragon-tiger": [
    { id: "dragon", label: "Dragon", odds: "1:1", pay: 2, color: "#dc2626" },
    { id: "tie", label: "Tie", odds: "8:1", pay: 9, color: "#16a34a" },
    { id: "tiger", label: "Tiger", odds: "1:1", pay: 2, color: "#d97706" },
  ],
  "andar-bahar": [
    { id: "andar", label: "Andar", odds: "1:1", pay: 2, color: "#2563eb" },
    { id: "bahar", label: "Bahar", odds: "1:1", pay: 2, color: "#dc2626" },
  ],
  "lucky-7": [
    { id: "below", label: "Below 7", odds: "1:1", pay: 2, color: "#2563eb" },
    { id: "seven", label: "Exactly 7", odds: "11:1", pay: 12, color: "#d97706" },
    { id: "above", label: "Above 7", odds: "1:1", pay: 2, color: "#dc2626" },
  ],
};

type Phase = "betting" | "dealing" | "result";

interface Round {
  cards: Record<string, Card | Card[]>;
  winner: string;
}

function playRound(game: GameId): Round {
  if (game === "dragon-tiger") {
    const d = randomCard(), t = randomCard();
    const w = rankValue(d.r) === rankValue(t.r) ? "tie" : rankValue(d.r) > rankValue(t.r) ? "dragon" : "tiger";
    return { cards: { dragon: d, tiger: t }, winner: w };
  }
  if (game === "lucky-7") {
    const c = randomCard();
    const v = rankValue(c.r);
    return { cards: { card: c }, winner: v < 7 ? "below" : v === 7 ? "seven" : "above" };
  }
  // Andar Bahar: centre joker, deal alternately (Andar first) until a card matches the joker's rank.
  const dk = deck();
  const joker = dk.pop()!;
  const andar: Card[] = [], bahar: Card[] = [];
  let side: "andar" | "bahar" = "andar";
  for (;;) {
    const c = dk.pop()!;
    (side === "andar" ? andar : bahar).push(c);
    if (c.r === joker.r) break;
    side = side === "andar" ? "bahar" : "andar";
  }
  return { cards: { joker, andar, bahar }, winner: side };
}

const SHORT: Record<string, string> = { dragon: "D", tiger: "T", tie: "=", andar: "A", bahar: "B", below: "↓", seven: "7", above: "↑" };

export function Casino({ nav, gameId }: { nav: Nav; gameId: GameId }) {
  const game = gameById(gameId);
  const sides = SIDES[gameId];
  const { total, debit, credit, showToast } = useStore();
  const [phase, setPhase] = useState<Phase>("betting");
  const [endsAt, setEndsAt] = useState(() => Date.now() + BET_SECS * 1000);
  const [now, setNow] = useState(() => Date.now());
  const [chip, setChip] = useState(100);
  const [bets, setBets] = useState<{ side: string; v: number }[]>([]);
  const [lastBets, setLastBets] = useState<{ side: string; v: number }[]>([]);
  const [round, setRound] = useState<Round | null>(null);
  const [roundNo, setRoundNo] = useState(() => 88200 + Math.floor(Math.random() * 90));
  const [won, setWon] = useState<number | null>(null);
  const [crowd, setCrowd] = useState<Record<string, number>>({});
  const [hist, setHist] = useState<string[]>(() => Array.from({ length: 20 }, () => playRound(gameId).winner));
  const betsRef = useRef(bets);
  betsRef.current = bets;

  const pending = bets.reduce((a, b) => a + b.v, 0);
  const mine = (id: string) => bets.filter((b) => b.side === id).reduce((a, b) => a + b.v, 0);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);

  // Other players' bets trickle in during betting.
  useEffect(() => {
    if (phase !== "betting") return;
    const t = setInterval(() => {
      setCrowd((c) => {
        const s = sides[Math.floor(Math.random() * sides.length)].id;
        return { ...c, [s]: (c[s] ?? 0) + CHIPS[Math.floor(Math.random() * 4)].v };
      });
    }, 450);
    return () => clearInterval(t);
  }, [phase, sides]);

  // Round state machine
  useEffect(() => {
    if (now < endsAt) return;
    if (phase === "betting") {
      const placed = betsRef.current;
      const stake = placed.reduce((a, b) => a + b.v, 0);
      if (stake > 0 && !debit(stake, `${game.name} • Round #${roundNo}`)) {
        showToast("Insufficient balance — bets cancelled");
        setBets([]);
      }
      if (stake > 0) setLastBets(placed);
      setRound(playRound(gameId));
      setPhase("dealing");
      setEndsAt(Date.now() + (gameId === "andar-bahar" ? 3500 : 2500));
    } else if (phase === "dealing" && round) {
      const placed = betsRef.current;
      let ret = 0;
      for (const b of placed) {
        const s = sides.find((x) => x.id === b.side)!;
        if (b.side === round.winner) ret += b.v * s.pay;
        else if (gameId === "dragon-tiger" && round.winner === "tie" && b.side !== "tie") ret += b.v / 2; // 50% refund on tie
      }
      if (ret > 0) credit(ret, `${game.name} • Round #${roundNo}`, round.winner === "tie" && !placed.some((b) => b.side === "tie") ? "Tie Refund" : "Game Winnings");
      setWon(placed.length ? ret : null);
      setHist((h) => [round.winner, ...h].slice(0, 20));
      setPhase("result");
      setEndsAt(Date.now() + 3500);
    } else if (phase === "result") {
      setBets([]);
      setCrowd({});
      setWon(null);
      setRound(null);
      setRoundNo((n) => n + 1);
      setPhase("betting");
      setEndsAt(Date.now() + BET_SECS * 1000);
    }
  }, [now, endsAt, phase, round, gameId, game.name, roundNo, sides, debit, credit, showToast]);

  const place = (side: string, v = chip) => {
    if (phase !== "betting") return;
    if (pending + v > total) return showToast("Not enough balance — add cash");
    setBets((b) => [...b, { side, v }]);
  };

  const secs = Math.max(0, Math.ceil((endsAt - now) / 1000));
  const progress = phase === "betting" ? Math.max(0, (endsAt - now) / (BET_SECS * 1000)) : 0;

  return (
    <div className="pb-6 fadein min-h-dvh flex flex-col">
      <Header
        title={game.name}
        sub={`Round #${roundNo} • Min ₹10 • Max ₹10,000`}
        onBack={nav.back}
        right={
          <div className="text-right">
            <div className="text-[10px] text-white/50">Balance</div>
            <Money n={total - (phase === "betting" ? pending : 0)} className="text-sm font-semibold text-neon-400" />
          </div>
        }
      />

      <div className="px-4">
        {/* History (last 20 rounds) */}
        <div className="flex items-center gap-2">
          <History size={14} className="text-white/40 shrink-0" />
          <div className="flex gap-1 overflow-x-auto no-scrollbar">
            {hist.map((w, i) => {
              const s = sides.find((x) => x.id === w)!;
              return (
                <span key={i} className={`w-5 h-5 rounded-full grid place-items-center text-[9px] font-bold shrink-0 ${i === 0 ? "ring-2 ring-white/70" : ""}`} style={{ background: s.color }}>
                  {SHORT[w]}
                </span>
              );
            })}
          </div>
        </div>

        {/* Table */}
        <div className="mt-6 mx-3 rounded-3xl felt p-4 relative overflow-hidden" style={{ minHeight: 200 }}>
          <div className="absolute top-3 left-1/2 -translate-x-1/2 text-[10px] tracking-[0.3em] text-white/40 uppercase">{game.name}</div>
          <div className="flex items-center justify-center pt-6 gap-6" style={{ minHeight: 150 }}>
            {gameId === "dragon-tiger" && (
              <>
                <Slot label="🐉 Dragon" card={round?.cards.dragon as Card | undefined} win={phase === "result" && round?.winner === "dragon"} />
                <div className="text-2xl font-extrabold text-white/60">VS</div>
                <Slot label="🐯 Tiger" card={round?.cards.tiger as Card | undefined} win={phase === "result" && round?.winner === "tiger"} delay />
              </>
            )}
            {gameId === "lucky-7" && <Slot label="Lucky Card" card={round?.cards.card as Card | undefined} win={phase === "result"} />}
            {gameId === "andar-bahar" && <AndarBaharTable round={round} phase={phase} />}
          </div>
          {phase === "result" && round && (
            <div className="absolute inset-x-0 bottom-3 flex justify-center pop">
              <div className="pill px-4 py-1.5 text-sm font-semibold" style={{ background: sides.find((s) => s.id === round.winner)!.color }}>
                {sides.find((s) => s.id === round.winner)!.label} wins!
              </div>
            </div>
          )}
        </div>

        {/* Timer */}
        <div className="mt-6 flex items-center gap-3">
          <div className={`w-12 h-12 rounded-full grid place-items-center font-bold text-lg shrink-0 ${phase === "betting" ? (secs <= 5 ? "bg-rose-500/20 text-rose-400" : "bg-neon-400/15 text-neon-400 pulse-ring") : "bg-white/10 text-white/60"}`}>
            {phase === "betting" ? secs : "—"}
          </div>
          <div className="flex-1">
            <div className="text-sm font-medium">{phase === "betting" ? "Place your bets" : phase === "dealing" ? "Bets locked • Dealing…" : "Round complete"}</div>
            <div className="h-1.5 rounded-full bg-white/10 mt-1.5 overflow-hidden">
              <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${progress * 100}%`, background: secs <= 5 ? "#f43f5e" : "#4ade80" }} />
            </div>
          </div>
          <div className="text-[11px] text-white/50 flex items-center gap-1"><Users size={13} />{Math.floor(game.online / 40)}</div>
        </div>

        {/* Bet areas */}
        <div className={`grid gap-2.5 mt-4 ${sides.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
          {sides.map((s) => {
            const my = mine(s.id);
            const winner = phase === "result" && round?.winner === s.id;
            return (
              <button
                key={s.id}
                onClick={() => place(s.id)}
                disabled={phase !== "betting"}
                className={`relative rounded-2xl p-3 text-center border-2 transition-all active:scale-95 ${winner ? "scale-105" : ""}`}
                style={{
                  background: `linear-gradient(180deg, ${s.color}55, ${s.color}22)`,
                  borderColor: winner ? "#fde68a" : `${s.color}88`,
                  boxShadow: winner ? `0 0 24px ${s.color}` : undefined,
                }}
              >
                <div className="font-semibold">{s.label}</div>
                <div className="text-[11px] text-white/70">{s.odds}</div>
                <div className="text-[10px] text-white/45 mt-1">Pool {inr(crowd[s.id] ?? 0)}</div>
                {my > 0 && (
                  <div className="absolute -top-2.5 -right-2 pop">
                    <span className="pill px-2 py-0.5 text-[11px] font-bold bg-gold-400 text-slate-900 shadow">{inr(my)}</span>
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Chips */}
        <div className="flex justify-between items-center mt-5 px-1">
          {CHIPS.map((c) => (
            <Chip key={c.v} value={c.v >= 1000 ? "1K" : c.v} color={c.c} size={50} active={chip === c.v} onClick={() => setChip(c.v)} />
          ))}
        </div>

        <div className="grid grid-cols-3 gap-2 mt-4">
          <button disabled={phase !== "betting" || !bets.length} onClick={() => setBets((b) => b.slice(0, -1))} className="btn-ghost rounded-xl py-2.5 text-xs flex items-center justify-center gap-1.5 disabled:opacity-40"><Undo2 size={15} /> Undo</button>
          <button
            disabled={phase !== "betting" || !lastBets.length || bets.length > 0}
            onClick={() => {
              const sum = lastBets.reduce((a, b) => a + b.v, 0);
              if (sum > total) return showToast("Not enough balance to rebet");
              setBets(lastBets);
            }}
            className="btn-ghost rounded-xl py-2.5 text-xs flex items-center justify-center gap-1.5 disabled:opacity-40"
          >
            <Repeat size={15} /> Rebet
          </button>
          <button
            disabled={phase !== "betting" || !bets.length}
            onClick={() => {
              if (pending * 2 > total) return showToast("Not enough balance to double");
              setBets((b) => [...b, ...b]);
            }}
            className="btn-ghost rounded-xl py-2.5 text-xs flex items-center justify-center gap-1.5 disabled:opacity-40"
          >
            <RotateCcw size={15} /> Double
          </button>
        </div>

        <div className="mt-3 text-center text-sm h-6">
          {phase === "betting" && pending > 0 && <span className="text-white/70">Your bet: <b className="text-white">{inr(pending)}</b></span>}
          {phase === "result" && won !== null && (
            <span className={`pop inline-block font-semibold ${won > 0 ? "text-neon-400" : "text-rose-400"}`}>{won > 0 ? `🎉 You won ${inr(won)}!` : "Better luck next round"}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function Slot({ label, card, win, delay }: { label: string; card?: Card; win: boolean; delay?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="text-xs font-semibold text-white/80">{label}</div>
      <div className={`rounded-lg ${win ? "ring-4 ring-gold-300 shadow-[0_0_30px_rgba(253,224,71,.6)]" : ""}`}>
        {card ? (
          <PlayingCard card={card} size="lg" className="flip" style={delay ? { animationDelay: ".4s" } : undefined} />
        ) : (
          <div className="w-16 h-[90px] rounded-lg border-2 border-dashed border-white/25 grid place-items-center text-white/30 text-xs">?</div>
        )}
      </div>
    </div>
  );
}

function AndarBaharTable({ round, phase }: { round: Round | null; phase: Phase }) {
  const joker = round?.cards.joker as Card | undefined;
  const andar = (round?.cards.andar as Card[] | undefined) ?? [];
  const bahar = (round?.cards.bahar as Card[] | undefined) ?? [];
  const row = (label: string, cards: Card[], win: boolean) => (
    <div className="flex items-center gap-2">
      <div className={`w-14 text-xs font-semibold ${win ? "text-gold-300" : "text-white/70"}`}>{label}</div>
      <div className="flex-1 flex -space-x-5 overflow-hidden">
        {cards.slice(-6).map((c, i) => <PlayingCard key={i} card={c} size="sm" className="flip" style={{ animationDelay: `${i * 0.08}s` }} />)}
        {cards.length === 0 && <div className="h-12 text-[10px] text-white/30 grid place-items-center">—</div>}
      </div>
      <div className="text-[10px] text-white/50 w-6 text-right">{cards.length}</div>
    </div>
  );
  return (
    <div className="w-full flex items-center gap-3">
      <div className="flex flex-col items-center gap-1.5">
        <div className="text-[10px] text-white/70 font-semibold">JOKER</div>
        {joker ? <PlayingCard card={joker} size="md" className="flip ring-2 ring-gold-300" /> : <PlayingCard faceDown size="md" />}
      </div>
      <div className="flex-1 space-y-2">
        {row("Andar", andar, phase === "result" && round?.winner === "andar")}
        {row("Bahar", bahar, phase === "result" && round?.winner === "bahar")}
      </div>
    </div>
  );
}
