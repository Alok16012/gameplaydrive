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
  }
}

export function GameTile({ game, onClick }: { game: Game; onClick: () => void }) {
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
