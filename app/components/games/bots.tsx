"use client";

import { useEffect, useRef, useState } from "react";
import { LogOut, Trophy } from "lucide-react";
import { Avatar, Sheet } from "../ui";

// Shared "human-like" opponent helpers for the card tables. Each seat gets a 15 s turn; bots take a
// varied amount of it (some act at once, some think, a few run the clock out) so the table feels live.

export const TURN_SECS = 15;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seconds a bot spends on its turn. `limit` (the turn length) means it timed out and the server auto-played. */
export function humanDelay(limit = TURN_SECS): number {
  const r = Math.random();
  const between = (a: number, b: number) => a + Math.random() * (b - a);
  if (r < 0.3) return between(0.8, 2.5); // snap decision
  if (r < 0.72) return between(3, 7); // normal
  if (r < 0.94) return between(7.5, 12.5); // thinking hard
  return limit; // ran out of time
}

/** Avatar with a countdown ring that drains over the turn. */
export function TimerAvatar({ emoji, size = 44, active, left, dim, total = TURN_SECS }: { emoji?: string; size?: number; active: boolean; left: number; dim?: boolean; total?: number }) {
  const frac = Math.max(0, Math.min(1, left / total));
  const r = size / 2 + 3;
  const c = 2 * Math.PI * r;
  const color = frac > 0.5 ? "#4ade80" : frac > 0.25 ? "#fbbf24" : "#f43f5e";
  return (
    <div className={`relative ${dim ? "opacity-40 grayscale" : ""}`} style={{ width: size, height: size }}>
      <Avatar emoji={emoji} size={size} ring={!active} />
      {active && (
        <svg className="absolute pointer-events-none" style={{ left: -4, top: -4, transform: "rotate(-90deg)" }} width={size + 8} height={size + 8}>
          <circle cx={size / 2 + 4} cy={size / 2 + 4} r={r} fill="none" stroke="rgba(255,255,255,.15)" strokeWidth={3} />
          <circle cx={size / 2 + 4} cy={size / 2 + 4} r={r} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} style={{ transition: "stroke-dashoffset .25s linear" }} />
        </svg>
      )}
    </div>
  );
}

export const NEXT_GAME_SECS = 6;

/** Counts down while `active`, then calls `onFire` once — the table deals the next game by itself, like a live lobby. */
export function useAutoNext(active: boolean, secs: number, onFire: () => void) {
  const fire = useRef(onFire);
  useEffect(() => { fire.current = onFire; });
  const [left, setLeft] = useState(secs);
  useEffect(() => {
    if (!active) return;
    const end = Date.now() + secs * 1000;
    setLeft(secs);
    const t = setInterval(() => {
      const l = Math.ceil((end - Date.now()) / 1000);
      if (l <= 0) {
        clearInterval(t);
        fire.current();
      } else setLeft(l);
    }, 200);
    return () => clearInterval(t);
  }, [active, secs]);
  return left;
}

/** Draining bar with "Next game starts in Ns". */
export function NextGameBar({ left, total = NEXT_GAME_SECS, label = "Next game starts in" }: { left: number; total?: number; label?: string }) {
  return (
    <div className="w-full">
      <div className="text-xs text-white/70 text-center">{label} <b className="text-white tabular-nums">{left}s</b></div>
      <div className="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div className="h-full rounded-full bg-neon-400" style={{ width: `${(left / total) * 100}%`, transition: "width 1s linear" }} />
      </div>
    </div>
  );
}

/** End-of-game sheet shared by every table. No "Play Again" — the next game deals automatically after the countdown. */
export function ResultSheet({ open, won, title, sub, left, nextLabel, onLeave, onClose, children }: {
  open: boolean; won: boolean; title: string; sub?: string; left: number; nextLabel?: string; onLeave: () => void; onClose: () => void; children?: React.ReactNode;
}) {
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="text-center">
        <div className="pop inline-grid place-items-center w-20 h-20 rounded-full" style={{ background: won ? "radial-gradient(circle,#fde68a,#f59e0b)" : "rgba(255,255,255,.08)" }}>
          {won ? <Trophy size={40} className="text-amber-900" /> : <span className="text-4xl">😔</span>}
        </div>
        <div className="text-2xl font-semibold mt-3">{title}</div>
        {sub && <div className="text-sm text-[var(--ink-soft)] mt-1">{sub}</div>}
        {children}
        <div className="mt-6"><NextGameBar left={left} label={nextLabel} /></div>
        <button onClick={onLeave} className="btn-ghost w-full py-3 rounded-2xl mt-5 flex items-center justify-center gap-2"><LogOut size={16} />Leave Table</button>
      </div>
    </Sheet>
  );
}

/** Opponent label. Hidden on the tables — coins are virtual, so computer seats play like any other seat. */
export function BotTag() {
  return null;
}
