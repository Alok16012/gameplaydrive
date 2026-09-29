"use client";

import { ChevronLeft, Gamepad2, Home, Menu, Wallet as WalletIcon } from "lucide-react";
import type { Card } from "../lib/data";
import { useStore } from "../lib/store";

export function PlayingCard({
  card,
  size = "md",
  faceDown = false,
  selected = false,
  onClick,
  className = "",
  style,
}: {
  card?: Card;
  size?: "xs" | "sm" | "md" | "lg";
  faceDown?: boolean;
  selected?: boolean;
  onClick?: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const dims = {
    xs: "w-6 h-8 text-[9px] rounded-[4px]",
    sm: "w-9 h-12 text-[11px] rounded-md",
    md: "w-12 h-[68px] text-sm rounded-lg",
    lg: "w-16 h-[90px] text-lg rounded-lg",
  }[size];
  if (faceDown || !card) {
    return (
      <div
        onClick={onClick}
        style={style}
        className={`${dims} ${className} shrink-0 border-2 border-white/90 shadow-lg`}
      >
        <div
          className="w-full h-full rounded-[inherit]"
          style={{
            background:
              "repeating-linear-gradient(45deg, #b91c1c 0 4px, #991b1b 4px 8px)",
          }}
        />
      </div>
    );
  }
  const red = card.s === "♥" || card.s === "♦";
  return (
    <div
      onClick={onClick}
      style={style}
      className={`${dims} ${className} shrink-0 bg-white shadow-lg ${className.includes("absolute") ? "" : "relative"} select-none transition-transform ${
        selected ? "-translate-y-3 ring-2 ring-neon-400" : ""
      } ${onClick ? "cursor-pointer" : ""}`}
    >
      <div className={`absolute left-1 top-0.5 leading-none font-bold ${red ? "text-red-600" : "text-slate-900"}`}>
        <div>{card.r}</div>
        <div>{card.s}</div>
      </div>
      <div
        className={`absolute right-1 bottom-0.5 font-bold ${red ? "text-red-600" : "text-slate-900"}`}
        style={{ fontSize: "1.6em", lineHeight: 1 }}
      >
        {card.s}
      </div>
    </div>
  );
}

export function Chip({ value, color = "#e11d48", size = 36, active = false, onClick }: { value?: number | string; color?: string; size?: number; active?: boolean; onClick?: () => void }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className={`relative rounded-full grid place-items-center font-bold text-white shrink-0 transition-transform ${active ? "-translate-y-1.5 ring-2 ring-gold-300" : ""}`}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.3,
        background: `radial-gradient(circle, ${color} 52%, transparent 53%), repeating-conic-gradient(#fff 0 12deg, ${color} 12deg 30deg)`,
        boxShadow: "0 4px 10px rgba(0,0,0,.45)",
      }}
    >
      <span className="rounded-full grid place-items-center" style={{ width: size * 0.62, height: size * 0.62, border: "1.5px dashed rgba(255,255,255,.7)" }}>
        {value}
      </span>
    </Tag>
  );
}

export function Header({ title, sub, onBack, right, icon }: { title: string; sub?: string; onBack?: () => void; right?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-20 flex items-center gap-3 px-4 pt-5 pb-3 bg-[#0b1030]/85 backdrop-blur-md">
      {onBack && (
        <button onClick={onBack} className="w-9 h-9 -ml-1 grid place-items-center rounded-full hover:bg-white/5" aria-label="Back">
          <ChevronLeft size={24} />
        </button>
      )}
      {icon}
      <div className="flex-1 min-w-0">
        <div className="text-lg font-semibold leading-tight truncate">{title}</div>
        {sub && <div className="text-[11px] text-[var(--ink-soft)]">{sub}</div>}
      </div>
      {right}
    </div>
  );
}

export type Tab = "home" | "games" | "wallet" | "more";

export function BottomNav({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const items: { id: Tab; label: string; Icon: typeof Home }[] = [
    { id: "home", label: "Home", Icon: Home },
    { id: "games", label: "Games", Icon: Gamepad2 },
    { id: "wallet", label: "Wallet", Icon: WalletIcon },
    { id: "more", label: "More", Icon: Menu },
  ];
  return (
    <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] z-30 bg-[#0a0f2c]/95 backdrop-blur-md border-t border-white/5 pb-[env(safe-area-inset-bottom)]">
      <div className="grid grid-cols-4">
        {items.map(({ id, label, Icon }) => {
          const on = tab === id;
          return (
            <button key={id} onClick={() => onTab(id)} className={`flex flex-col items-center gap-1 py-2.5 text-[11px] ${on ? "text-neon-400 font-semibold" : "text-[var(--ink-mute)]"}`}>
              <Icon size={22} strokeWidth={on ? 2.4 : 1.8} fill={on && id === "home" ? "currentColor" : "none"} />
              {label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-center">
      <div className="absolute inset-0 bg-black/60 fadein" onClick={onClose} />
      <div className="absolute bottom-0 w-full max-w-[430px] slideup rounded-t-3xl bg-[#111838] border-t border-white/10 p-5 pb-8 max-h-[85dvh] overflow-y-auto">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/20" />
        {title && <div className="text-lg font-semibold mb-4">{title}</div>}
        {children}
      </div>
    </div>
  );
}

export function Toast() {
  const { toast } = useStore();
  if (!toast) return null;
  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[60] pop">
      <div className="px-4 py-2.5 rounded-full bg-white text-slate-900 text-sm font-semibold shadow-2xl whitespace-nowrap">{toast}</div>
    </div>
  );
}

export function Avatar({ emoji = "👨🏽", size = 40, ring = true }: { emoji?: string; size?: number; ring?: boolean }) {
  return (
    <div
      className={`rounded-full grid place-items-center shrink-0 ${ring ? "ring-2 ring-white/80" : ""}`}
      style={{ width: size, height: size, fontSize: size * 0.58, background: "linear-gradient(135deg,#fde68a,#f59e0b)" }}
    >
      {emoji}
    </div>
  );
}

export function Money({ n, className = "" }: { n: number; className?: string }) {
  const { hidden } = useStore();
  return <span className={className}>{hidden ? "₹ ••••" : `₹ ${n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`}</span>;
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} className={`w-11 h-6 rounded-full p-0.5 transition-colors ${on ? "bg-neon-500" : "bg-white/15"}`}>
      <div className={`w-5 h-5 rounded-full bg-white transition-transform ${on ? "translate-x-5" : ""}`} />
    </button>
  );
}
