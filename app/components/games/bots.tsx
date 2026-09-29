"use client";

import { Avatar } from "../ui";

// Shared "human-like" opponent helpers for the card tables. Each seat gets a 15 s turn; bots take a
// varied amount of it (some act at once, some think, a few run the clock out) so the table feels live.

export const TURN_SECS = 15;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Seconds a bot spends on its turn. TURN_SECS means it timed out and the server auto-played. */
export function humanDelay(): number {
  const r = Math.random();
  const between = (a: number, b: number) => a + Math.random() * (b - a);
  if (r < 0.3) return between(0.8, 2.5); // snap decision
  if (r < 0.72) return between(3, 7); // normal
  if (r < 0.94) return between(7.5, 12.5); // thinking hard
  return TURN_SECS; // ran out of time
}

/** Avatar with a countdown ring that drains over the turn. */
export function TimerAvatar({ emoji, size = 44, active, left, dim }: { emoji?: string; size?: number; active: boolean; left: number; dim?: boolean }) {
  const frac = Math.max(0, Math.min(1, left / TURN_SECS));
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
