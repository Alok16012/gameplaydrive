"use client";

import type { Card, Game, GameId } from "../lib/data";
import { Chip, PlayingCard } from "./ui";

// Illustrations for each game, drawn with CSS/emoji so the demo needs no image assets.

function Fan({ cards, size = "sm" }: { cards: Card[]; size?: "xs" | "sm" | "md" }) {
  const mid = (cards.length - 1) / 2;
  return (
    <div className="relative" style={{ width: size === "md" ? 90 : 70, height: size === "md" ? 76 : size === "sm" ? 54 : 36 }}>
      {cards.map((c, i) => (
        <PlayingCard
          key={i}
          card={c}
          size={size}
          className="absolute bottom-0 left-1/2"
          style={{ transform: `translateX(calc(-50% + ${(i - mid) * (size === "md" ? 18 : 13)}px)) rotate(${(i - mid) * 12}deg)`, transformOrigin: "bottom center" }}
        />
      ))}
    </div>
  );
}

export function GameIcon({ id, big = false }: { id: GameId; big?: boolean }) {
  const s = big ? 1.35 : 1;
  const size = "sm";
  const scale = (el: React.ReactNode) => (big ? <div style={{ transform: "scale(1.25)" }}>{el}</div> : el);
  switch (id) {
    case "rummy":
      return scale(<Fan size={size} cards={[{ r: "A", s: "♠" }, { r: "A", s: "♥" }, { r: "A", s: "♠" }]} />);
    case "rummy21":
      return scale(
        <div className="relative">
          <Fan size={size} cards={[{ r: "8", s: "♦" }, { r: "9", s: "♦" }, { r: "10", s: "♦" }]} />
          <span
            className="absolute -right-3 -bottom-1 pill px-1.5 text-[11px] font-extrabold leading-[18px] text-slate-900"
            style={{ background: "linear-gradient(180deg,#fef08a,#f59e0b)", boxShadow: "0 2px 6px rgba(0,0,0,.5)" }}
          >
            21
          </span>
        </div>,
      );
    case "teen-patti":
      return scale(<Fan size={size} cards={[{ r: "A", s: "♥" }, { r: "A", s: "♠" }, { r: "A", s: "♦" }]} />);
    case "poker":
      return scale(
        <div className="relative">
          <Fan size={size} cards={[{ r: "A", s: "♠" }, { r: "K", s: "♠" }]} />
          <div className="absolute right-0 -bottom-1">
            <Chip size={26} color="#1d4ed8" />
          </div>
        </div>,
      );
    case "andar-bahar":
      return (
        <div style={{ transform: `scale(${s})` }}>
          <Chip size={46} color="#b45309" value="AB" />
        </div>
      );
    case "dragon-tiger":
      return <span style={{ fontSize: 40 * s, filter: "drop-shadow(0 4px 8px rgba(0,0,0,.5))" }}>🐉</span>;
    case "lucky-7":
      return (
        <span
          className="font-extrabold italic"
          style={{
            fontSize: 48 * s,
            lineHeight: 1,
            background: "linear-gradient(180deg,#fef08a,#f59e0b 55%,#b45309)",
            WebkitBackgroundClip: "text",
            color: "transparent",
            filter: "drop-shadow(0 3px 0 #7c2d12) drop-shadow(0 6px 10px rgba(0,0,0,.5))",
          }}
        >
          7
        </span>
      );
    case "ludo":
      return <span style={{ fontSize: 40 * s, filter: "drop-shadow(0 4px 8px rgba(0,0,0,.5))" }}>🎲</span>;
    case "carrom":
      return (
        <div
          className="rounded-full grid place-items-center"
          style={{
            width: 44 * s,
            height: 44 * s,
            background: "radial-gradient(circle,#fff7ed 18%,#fb923c 20%,#fb923c 34%,#fff7ed 36%,#fff7ed 44%,#ea580c 46%)",
            boxShadow: "0 5px 12px rgba(0,0,0,.45)",
          }}
        />
      );
    case "chess":
      return <span style={{ fontSize: 44 * s, lineHeight: 1, color: "#f8fafc", filter: "drop-shadow(0 4px 6px rgba(0,0,0,.6))" }}>♞</span>;
    case "aviator":
      return <span style={{ fontSize: 40 * s, lineHeight: 1, display: "inline-block", transform: "rotate(-12deg)", filter: "drop-shadow(0 4px 8px rgba(0,0,0,.55))" }}>✈️</span>;
    case "roulette":
      return (
        <div
          className="rounded-full grid place-items-center"
          style={{
            width: 48 * s,
            height: 48 * s,
            background: "radial-gradient(circle,#fbbf24 0 14%,#78350f 15% 40%,transparent 41%), repeating-conic-gradient(#dc2626 0 10deg,#111827 10deg 20deg)",
            border: `${3 * s}px solid #a16207`,
            boxShadow: "0 5px 12px rgba(0,0,0,.5)",
          }}
        />
      );
    case "blackjack":
      return scale(<Fan size={size} cards={[{ r: "A", s: "♠" }, { r: "K", s: "♥" }]} />);
    case "plinko":
      return (
        <div className="relative" style={{ width: 52 * s, height: 46 * s }}>
          {[1, 2, 3, 4].map((row) =>
            Array.from({ length: row + 1 }, (_, i) => (
              <span
                key={`${row}-${i}`}
                className="absolute rounded-full bg-white/85"
                style={{ width: 4 * s, height: 4 * s, top: row * 9 * s, left: `calc(50% + ${(i - row / 2) * 10 * s}px - ${2 * s}px)` }}
              />
            )),
          )}
          <span className="absolute rounded-full" style={{ width: 9 * s, height: 9 * s, top: 0, left: `calc(50% - ${4.5 * s}px)`, background: "radial-gradient(circle at 35% 35%,#fff,#f472b6 60%,#9d174d)", boxShadow: "0 0 8px #f472b6" }} />
        </div>
      );
  }
}

export function GameTile({ game, onClick, closed }: { game: Game; onClick: () => void; closed?: boolean }) {
  return (
    <button
      onClick={onClick}
      className="relative rounded-2xl overflow-hidden text-center pt-3 pb-2.5 px-1 active:scale-95 transition-transform"
      style={{
        background: `radial-gradient(90% 70% at 50% 25%, ${game.glow}55, transparent 70%), linear-gradient(160deg, ${game.from}, ${game.to})`,
        border: `1px solid ${game.glow}55`,
        boxShadow: `inset 0 1px 0 rgba(255,255,255,.18), 0 8px 20px ${game.to}88`,
      }}
    >
      <div className="h-[58px] grid place-items-center">
        <GameIcon id={game.id} />
      </div>
      <div className="mt-1.5 text-[13px] font-semibold leading-tight">{game.name}</div>
      <div className="text-[10px] text-white/70">{game.tag}</div>
      {closed && <div className="absolute inset-0 grid place-items-center bg-black/55"><span className="pill px-2.5 py-0.5 text-[10px] font-semibold bg-black/70 text-white/80">Closed</span></div>}
    </button>
  );
}

export function GameThumb({ game, className = "" }: { game: Game; className?: string }) {
  return (
    <div
      className={`rounded-xl grid place-items-center overflow-hidden ${className}`}
      style={{
        background: `radial-gradient(80% 80% at 50% 40%, ${game.glow}66, transparent 70%), linear-gradient(160deg, ${game.from}, ${game.to})`,
      }}
    >
      <GameIcon id={game.id} big />
    </div>
  );
}
