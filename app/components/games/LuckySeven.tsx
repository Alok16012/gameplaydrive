"use client";

import { useEffect, useRef, useState } from "react";
import { Lock, Repeat, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { gameById, inr, randomCard, type Card } from "../../lib/data";
import { useStore } from "../../lib/store";
import { errText, supabase } from "../../lib/supabase";
import { Chip, Header, Money, PlayingCard } from "../ui";
import type { Nav } from "../nav";

// Lucky 7 — exchange-style board. One card is dealt each round:
//   Low (A–6) / High (8–K) ×2 (a 7 loses both) • Even ×2.1 • Odd ×1.79 • Black / Red ×1.95
//   A23 / 456 / 8910 / JQK ×4 • exact card ×12
// Odds are the total return per coin (stake included). The server (casino_round + l7_pay, migration 006)
// deals and settles every round that has bets on it; rounds without bets are display-only.

const BET_SECS = 15;
const DEAL_MS = 2500;
const RESULT_MS = 4000;
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
const CHIPS = [
  { v: 10, c: "#2563eb" },
  { v: 50, c: "#16a34a" },
  { v: 100, c: "#e11d48" },
  { v: 500, c: "#7c3aed" },
  { v: 1000, c: "#d97706" },
];
const GROUPS = [
  { id: "g_a23", ranks: ["A", "2", "3"] },
  { id: "g_456", ranks: ["4", "5", "6"] },
  { id: "g_8910", ranks: ["8", "9", "10"] },
  { id: "g_jqk", ranks: ["J", "Q", "K"] },
];
const ODDS: Record<string, number> = { low: 2, high: 2, even: 2.1, odd: 1.79, black: 1.95, red: 1.95, g_a23: 4, g_456: 4, g_8910: 4, g_jqk: 4 };
const oddsOf = (id: string) => ODDS[id] ?? 12;

type Phase = "betting" | "dealing" | "result";
type Bet = { side: string; v: number };

const value = (r: string) => RANKS.indexOf(r as (typeof RANKS)[number]) + 1;
/** L / H / T (7) for the results strip. */
const outcome = (c: Card) => (value(c.r) < 7 ? "L" : value(c.r) > 7 ? "H" : "T");

/** Did this market win for the dealt card? (Display only — the server settles.) */
function wins(id: string, c: Card | null): boolean {
  if (!c) return false;
  const v = value(c.r);
  switch (id) {
    case "low": return v <= 6;
    case "high": return v >= 8;
    case "even": return v % 2 === 0;
    case "odd": return v % 2 === 1;
    case "black": return c.s === "♠" || c.s === "♣";
    case "red": return c.s === "♥" || c.s === "♦";
    case "g_a23": return v <= 3;
    case "g_456": return v >= 4 && v <= 6;
    case "g_8910": return v >= 8 && v <= 10;
    case "g_jqk": return v >= 11;
    default: return id === `c_${c.r}`;
  }
}

export function LuckySeven({ nav }: { nav: Nav }) {
  const game = gameById("lucky-7");
  const { total, showToast, applyBalance } = useStore();
  const [phase, setPhase] = useState<Phase>("betting");
  const [endsAt, setEndsAt] = useState(() => Date.now() + BET_SECS * 1000);
  const [now, setNow] = useState(() => Date.now());
  const [chip, setChip] = useState(100);
  const [bets, setBets] = useState<Bet[]>([]);
  const [lastBets, setLastBets] = useState<Bet[]>([]);
  const [card, setCard] = useState<Card | null>(null);
  const [roundNo, setRoundNo] = useState(() => 50200 + Math.floor(Math.random() * 90));
  const [won, setWon] = useState<number | null>(null);
  const [hist, setHist] = useState<string[]>(() => Array.from({ length: 10 }, () => outcome(randomCard())));
  const payout = useRef(0);
  const betsRef = useRef(bets);
  useEffect(() => { betsRef.current = bets; }, [bets]);

  const pending = bets.reduce((a, b) => a + b.v, 0);
  const mine = (id: string) => bets.filter((b) => b.side === id).reduce((a, b) => a + b.v, 0);
  const open = phase === "betting";

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);

  // Round clock: 15 s betting → deal (server, if you bet) → result → next round.
  useEffect(() => {
    if (now < endsAt) return;
    if (phase === "betting") {
      const placed = betsRef.current;
      payout.current = 0;
      setPhase("dealing");
      if (placed.length) {
        setLastBets(placed);
        setEndsAt(Number.MAX_SAFE_INTEGER);
        supabase()
          .rpc("casino_round", { p_game: "lucky-7", p_bets: placed, p_round: String(roundNo) })
          .then(({ data, error }) => {
            if (error) {
              showToast(errText(error));
              setBets([]);
              setCard(randomCard());
            } else {
              const r = data as { cards: { card: Card }; payout: number; balance: number };
              payout.current = Number(r.payout);
              applyBalance(r.balance);
              setCard(r.cards.card);
            }
            setEndsAt(Date.now() + DEAL_MS);
          });
      } else {
        setCard(randomCard());
        setEndsAt(Date.now() + DEAL_MS);
      }
    } else if (phase === "dealing" && card) {
      setWon(betsRef.current.length ? payout.current : null);
      setHist((h) => [outcome(card), ...h].slice(0, 10));
      setPhase("result");
      setEndsAt(Date.now() + RESULT_MS);
    } else if (phase === "result") {
      setBets([]);
      setWon(null);
      setCard(null);
      setRoundNo((n) => n + 1);
      setPhase("betting");
      setEndsAt(Date.now() + BET_SECS * 1000);
    }
  }, [now, endsAt, phase, card, roundNo, showToast, applyBalance]);

  const place = (side: string) => {
    if (!open) return;
    if (pending + chip > total) return showToast("Not enough coins — ask your agent");
    setBets((b) => [...b, { side, v: chip }]);
  };

  const secs = Math.max(0, Math.ceil((endsAt - now) / 1000));
  const result = phase === "result" ? card : null;
  const box = (id: string) => ({ id, my: mine(id), win: wins(id, result), locked: !open });

  return (
    <div className="pb-6 fadein min-h-dvh flex flex-col bg-[#24282c]">
      <Header
        title={game.name}
        sub={`Round #${roundNo} • Min 🪙 10`}
        onBack={nav.back}
        right={
          <div className="text-right">
            <div className="text-[10px] text-white/50">Balance</div>
            <Money n={total - (open ? pending : 0)} className="text-sm font-semibold text-neon-400" />
          </div>
        }
      />

      {/* Table */}
      <div className="relative h-56 overflow-hidden" style={{ background: "radial-gradient(120% 90% at 50% 0%, #7a1b1b 0%, #3b0c0c 60%, #1d0606 100%)" }}>
        <div className="absolute left-1/2 -translate-x-1/2 bottom-[-70px] w-[125%] h-56 rounded-[50%] border-[10px] border-[#c69a3c]"
          style={{ background: "radial-gradient(60% 60% at 50% 35%, #e0334b, #b3172d 70%)", boxShadow: "inset 0 10px 30px rgba(0,0,0,.35), 0 -6px 24px rgba(0,0,0,.4)" }}>
          <div className="absolute left-1/2 -translate-x-1/2 top-9 flex items-center gap-1.5 text-white/85 font-semibold tracking-wide">
            <span className="w-5 h-5 border-2 border-white/70 rounded-[3px]" />
            <span className="text-lg">&lt;</span>
            <span className="w-6 h-6 border-2 border-white/80 rounded-[3px] grid place-items-center text-sm">7</span>
            <span className="text-lg">&gt;</span>
            <span className="w-5 h-5 border-2 border-white/70 rounded-[3px]" />
          </div>
          <div className="absolute left-1/2 -translate-x-1/2 top-[68px] flex gap-10 text-[11px] text-white/75 font-medium tracking-wider">
            <span>A to 6</span><span>8 to K</span>
          </div>
        </div>
        {/* Round sign */}
        <div className="absolute left-4 top-16 bg-[#111] border border-white/20 rounded px-2 py-1 text-center shadow-lg -rotate-3">
          <div className="text-[9px] font-bold text-white/80">LUCKY 7</div>
          <div className="text-[8px] text-amber-300">#{roundNo}</div>
        </div>
        {/* Timer */}
        <div className="absolute right-4 top-4 flex flex-col items-center">
          <div className={`w-12 h-12 rounded-full grid place-items-center font-bold text-lg border-2 ${open ? (secs <= 5 ? "border-rose-400 text-rose-300 bg-black/50" : "border-neon-400 text-neon-400 bg-black/50") : "border-white/20 text-white/50 bg-black/40"}`}>
            {open ? secs : <Lock size={18} />}
          </div>
          <div className="text-[10px] text-white/70 mt-1">{open ? "Place bets" : phase === "dealing" ? "Dealing…" : "Result"}</div>
        </div>
        {/* Dealt card */}
        <div className="absolute left-1/2 -translate-x-1/2 top-6">
          {card && phase !== "betting" ? (
            <PlayingCard key={roundNo} card={card} size="lg" className={`flip ${phase === "result" ? "ring-4 ring-gold-300 shadow-[0_0_30px_rgba(253,224,71,.6)]" : ""}`} />
          ) : (
            <PlayingCard faceDown size="lg" className="opacity-80" />
          )}
        </div>
        {phase === "result" && card && (
          <div className="absolute inset-x-0 bottom-3 flex justify-center pop">
            <span className={`pill px-4 py-1 text-sm font-bold ${outcome(card) === "T" ? "bg-white text-slate-900" : outcome(card) === "L" ? "bg-rose-500" : "bg-emerald-500"}`}>
              {card.r}{card.s} • {outcome(card) === "T" ? "Seven" : outcome(card) === "L" ? "Low card" : "High card"}
            </span>
          </div>
        )}
      </div>

      {/* Board */}
      <div className="relative px-1.5 pt-1.5 space-y-1.5">
        {/* Low • 7 • High */}
        <div className="grid grid-cols-[1fr_auto_1fr] bg-[#3a3f44]">
          <Market {...box("low")} onClick={() => place("low")} className="border-[3px] border-red-500 m-1">
            <Odds v={2} /><Label>LOW CARD</Label>
          </Market>
          <div className="grid place-items-center px-3 bg-[#555b61]"><RankCard r="7" /></div>
          <Market {...box("high")} onClick={() => place("high")} className="border-[3px] border-emerald-500 m-1">
            <Odds v={2} /><Label>HIGH CARD</Label>
          </Market>
        </div>

        {/* Even / Odd / Black / Red */}
        <div className="grid grid-cols-4 gap-1.5">
          <Market {...box("even")} onClick={() => place("even")}><Odds v={2.1} /><Label>EVEN</Label></Market>
          <Market {...box("odd")} onClick={() => place("odd")}><Odds v={1.79} /><Label>ODD</Label></Market>
          <Market {...box("black")} onClick={() => place("black")}><Odds v={1.95} /><span className="text-xl leading-none text-white">♠ ♣</span></Market>
          <Market {...box("red")} onClick={() => place("red")}><Odds v={1.95} /><span className="text-xl leading-none text-red-500">♥ ♦</span></Market>
        </div>

        {/* Groups */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 px-5 py-2">
          {GROUPS.map((g) => (
            <div key={g.id} className="flex flex-col items-center">
              <Odds v={4} />
              <Market {...box(g.id)} onClick={() => place(g.id)} className="border-4 border-[#555b61] !bg-transparent px-1.5 py-1.5 w-full">
                <div className="flex justify-center gap-1">{g.ranks.map((r) => <RankCard key={r} r={r} />)}</div>
              </Market>
            </div>
          ))}
        </div>

        {/* Exact card */}
        <div className="pb-2">
          <div className="flex justify-center"><Odds v={12} /></div>
          <div className="grid grid-cols-5 gap-y-2 px-2">
            {RANKS.map((r, i) => (
              <div key={r} className={`flex justify-center ${i === 10 ? "col-start-2" : ""}`}>
                <Market {...box(`c_${r}`)} onClick={() => place(`c_${r}`)} className="!bg-transparent !p-0">
                  <RankCard r={r} big />
                </Market>
              </div>
            ))}
          </div>
        </div>

        {/* Results */}
        <div className="flex justify-center gap-1 py-2">
          {hist.map((h, i) => (
            <span key={i} className={`w-7 h-7 grid place-items-center bg-black text-sm font-bold ${h === "T" ? "text-white" : h === "L" ? "text-red-500" : "text-emerald-500"} ${i === 0 ? "ring-1 ring-white/60" : ""}`}>{h}</span>
          ))}
          <span className="w-7 h-7 grid place-items-center bg-black text-white/70 text-xs">…</span>
        </div>
      </div>

      {/* Chips and bet controls */}
      <div className="px-4 mt-2">
        <div className="flex justify-between items-center px-1">
          {CHIPS.map((c) => (
            <Chip key={c.v} value={c.v >= 1000 ? "1K" : c.v} color={c.c} size={48} active={chip === c.v} onClick={() => setChip(c.v)} />
          ))}
        </div>
        <div className="grid grid-cols-4 gap-2 mt-4">
          <button disabled={!open || !bets.length} onClick={() => setBets((b) => b.slice(0, -1))} className="btn-ghost rounded-xl py-2.5 text-xs flex items-center justify-center gap-1 disabled:opacity-40"><Undo2 size={14} /> Undo</button>
          <button disabled={!open || !bets.length} onClick={() => setBets([])} className="btn-ghost rounded-xl py-2.5 text-xs flex items-center justify-center gap-1 disabled:opacity-40"><Trash2 size={14} /> Clear</button>
          <button
            disabled={!open || !lastBets.length || bets.length > 0}
            onClick={() => (lastBets.reduce((a, b) => a + b.v, 0) > total ? showToast("Not enough coins to rebet") : setBets(lastBets))}
            className="btn-ghost rounded-xl py-2.5 text-xs flex items-center justify-center gap-1 disabled:opacity-40"
          >
            <Repeat size={14} /> Rebet
          </button>
          <button
            disabled={!open || !bets.length}
            onClick={() => (pending * 2 > total ? showToast("Not enough coins to double") : setBets((b) => [...b, ...b]))}
            className="btn-ghost rounded-xl py-2.5 text-xs flex items-center justify-center gap-1 disabled:opacity-40"
          >
            <RotateCcw size={14} /> Double
          </button>
        </div>
        <div className="mt-3 text-center text-sm h-6">
          {open && pending > 0 && <span className="text-white/70">Your bet: <b className="text-white">{inr(pending)}</b></span>}
          {phase === "result" && won !== null && (
            <span className={`pop inline-block font-semibold ${won > 0 ? "text-neon-400" : "text-rose-400"}`}>{won > 0 ? `🎉 You won ${inr(won)}!` : "Better luck next round"}</span>
          )}
        </div>
        <div className="text-center text-[10px] text-white/35">Odds include your stake. A 7 loses Low and High. Coins are virtual.</div>
      </div>
    </div>
  );
}

/** A bettable box: shows your stake, glows when it wins, locks while the round is being dealt. */
function Market({ id, my, win, locked, onClick, className = "", children }: { id: string; my: number; win: boolean; locked: boolean; onClick: () => void; className?: string; children: React.ReactNode }) {
  return (
    <button
      data-market={id}
      onClick={onClick}
      disabled={locked}
      className={`relative bg-[#3a3f44] py-3 px-2 flex flex-col items-center justify-center gap-1 transition-all active:scale-95 ${win ? "outline outline-2 outline-gold-300 shadow-[0_0_18px_rgba(253,224,71,.5)] z-10" : locked ? "opacity-55" : ""} ${className}`}
    >
      {children}
      {my > 0 && (
        <span className="absolute -top-2 -right-1.5 pop pill px-1.5 py-0.5 text-[10px] font-bold bg-gold-400 text-slate-900 shadow z-10">
          {my >= 1000 ? `${Math.round(my / 100) / 10}K` : my}
        </span>
      )}
    </button>
  );
}

function Odds({ v }: { v: number }) {
  return <div className="text-[13px] font-semibold text-white/75 leading-none">{v}</div>;
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[13px] font-semibold text-white/60 tracking-wide">{children}</div>;
}

/** The yellow-edged rank card used on the board: rank plus the four suit marks. */
function RankCard({ r, big }: { r: string; big?: boolean }) {
  return (
    <div className={`${big ? "w-11 h-14" : "w-9 h-12"} bg-white border-2 border-yellow-300 rounded-[3px] flex flex-col items-center justify-between py-0.5 select-none`}>
      <div className={`${big ? "text-xl" : "text-lg"} font-bold text-slate-900 leading-none`}>{r}</div>
      <div className="grid grid-cols-2 text-[9px] leading-[9px]">
        <span className="text-slate-900">♠</span><span className="text-red-600">♦</span>
        <span className="text-slate-900">♣</span><span className="text-red-600">♥</span>
      </div>
    </div>
  );
}
