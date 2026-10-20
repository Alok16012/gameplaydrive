"use client";

import { useEffect, useState } from "react";
import { prettyNumber, useSupport, whatsappLink } from "../../lib/support";
import { setPref, useSoundPrefs } from "../../lib/sound";
import { BadgeCheck, ChevronRight, CircleHelp, Clock3, FileCheck2, Globe, HeartHandshake, History, LogOut, Mail, MessageCircle, Settings as SettingsIcon, ShieldCheck, Wallet as WalletIcon, ChevronDown, Phone, Landmark, IdCard, KeyRound } from "lucide-react";
import { FAQS, GAMES, inr, type Txn } from "../../lib/data";
import { useStore } from "../../lib/store";
import { GameThumb } from "../GameArt";
import { Avatar, Header, Toggle } from "../ui";
import type { Nav } from "../nav";
import { ChangePasswordModal } from "../ChangePasswordModal";
import { supabase } from "../../lib/supabase";
import { cardText, rouletteText, sideLabel, type CardJ } from "../../lib/roundText";

export function More({ nav }: { nav: Nav }) {
  const { player, txns, total } = useStore();
  const [changePwOpen, setChangePwOpen] = useState(false);
  const items: { icon: React.ReactNode; label: string; right?: React.ReactNode; go: () => void; danger?: boolean }[] = [
    { icon: <WalletIcon size={19} />, label: "Wallet", go: () => nav.reset({ name: "wallet" }) },
    { icon: <History size={19} />, label: "Game History", go: () => nav.push({ name: "history" }) },
    { icon: <KeyRound size={19} className="text-amber-400" />, label: "Change Password", go: () => setChangePwOpen(true) },
    { icon: <CircleHelp size={19} />, label: "Help & Support", go: () => nav.push({ name: "help" }) },
    { icon: <SettingsIcon size={19} />, label: "Settings", go: () => nav.push({ name: "settings" }) },
    { icon: <HeartHandshake size={19} />, label: "Responsible Gaming", right: <ChevronRight size={18} className="text-white/40" />, go: () => nav.push({ name: "rg" }) },
    { icon: <LogOut size={19} className="text-rose-400" />, label: "Logout", go: nav.logout },
  ];
  return (
    <div className="pb-28 fadein">
      <div className="px-4 pt-7 flex items-center gap-3.5">
        <Avatar size={58} />
        <div className="flex-1">
          <div className="text-lg font-semibold">{player?.name}</div>
          <div className="text-[11px] text-[var(--ink-soft)]">ID: {player?.code}</div>
          {player?.agent && <span className="inline-flex items-center gap-1 mt-1 pill px-2 py-0.5 text-[10px] bg-neon-400/15 text-neon-400"><BadgeCheck size={12} /> Agent: {player.agent}</span>}
        </div>
        <button onClick={() => nav.push({ name: "settings" })} aria-label="Settings"><SettingsIcon size={22} /></button>
      </div>

      <div className="px-4 mt-5 grid grid-cols-3 gap-2.5">
        {[
          [String(txns.filter((t) => t.type === "bet").length), "Bets placed"],
          [inr(txns.filter((t) => t.type === "winning").reduce((a, t) => a + t.amount, 0)), "Coins won"],
          [inr(total), "Balance"],
        ].map(([v, l]) => (
          <div key={l} className="card py-3 text-center"><div className="font-semibold">{v}</div><div className="text-[10px] text-[var(--ink-soft)]">{l}</div></div>
        ))}
      </div>

      <div className="px-4 mt-4">
        <div className="card divide-y divide-white/5">
          {items.map((it) => (
            <button key={it.label} onClick={it.go} className="w-full flex items-center gap-3.5 px-4 py-4 text-left text-sm">
              <span className="text-white/80">{it.icon}</span>
              <span className="flex-1">{it.label}</span>
              {it.right}
            </button>
          ))}
        </div>
        <div className="text-center text-[10px] text-white/30 mt-6">Khelobaazi v1.0.0 • 18+ only • Play responsibly</div>
      </div>
      {changePwOpen && <ChangePasswordModal onClose={() => setChangePwOpen(false)} />}
    </div>
  );
}

/** Rounds from the coin ledger, oldest first: each bet and payout joins its game's current round. A new round starts at
 *  an Entry / Boot / Buy-in, at a different hand number, or at a bet after the round already paid out. */
function groupRounds(txns: Txn[]) {
  type Round = { id: string; game: string; desc: string; when: string; hand?: string; staked: number; paid: number; paidOut: boolean; lastAt: number; settled: boolean };
  const rounds: Round[] = [];
  const open: Record<string, Round> = {};
  for (const t of [...txns].reverse()) {
    const parts = t.sub.split(" • ");
    const game = parts[0];
    const when = parts[parts.length - 1];
    const desc = parts.slice(1, -1).join(" • ");
    const hand = desc.match(/(?:Hand|Round|Spin) #\d+/)?.[0];
    let r = open[game];
    const start = /\b(entry|boot|buy-in)\b/i.test(desc);
    if (!r || (t.amount < 0 && (start || r.paidOut)) || (hand && r.hand && hand !== r.hand)) {
      // A new round of the same game means the previous one is over, paid or not.
      if (r) r.settled = true;
      r = { id: t.id, game, desc: desc.replace(/(^| • )(Buy-in \(max loss\)|Entry|Buy-in returned)$/i, ""), when, hand, staked: 0, paid: 0, paidOut: false, lastAt: 0, settled: false };
      open[game] = r;
      rounds.push(r);
    }
    if (!r.hand && hand) r.hand = hand;
    if (t.amount < 0) r.staked -= t.amount;
    else { r.paid += t.amount; r.paidOut = true; }
    r.when = when;
    r.lastAt = t.at ? new Date(t.at).getTime() : 0;
  }
  // A round with no payout is lost once a newer round of that game exists, or it has been quiet for a while
  // (a Rummy deal or Pool match pays nothing back to a player who loses everything they put in).
  const quiet = Date.now() - 20 * 60 * 1000;
  for (const r of rounds) if (!r.settled && r.lastAt && r.lastAt < quiet) r.settled = true;
  return rounds.reverse();
}

// What was bet and how it came out, per round, from /api/my-history (keys as in detailKey).
type Detail = Record<string, unknown>;
const SLUG: Record<string, string> = {
  Aviator: "aviator", "Stock Market": "stockmarket", Roulette: "roulette", Blackjack: "blackjack",
  "Dragon Tiger": "dragon-tiger", "Andar Bahar": "andar-bahar", "Lucky 7": "lucky-7",
};
const detailKey = (game: string, hand?: string) => {
  if (game.startsWith("CRICKET: ")) return `cricket:${game.slice(9)}`;
  const id = hand?.match(/\d+/)?.[0];
  return SLUG[game] && id ? `${SLUG[game]}:${id}` : null;
};
const n = (v: unknown) => Math.round(Number(v)).toLocaleString("en-IN");
const cards = (cs: unknown) => ((cs as CardJ[]) ?? []).map(cardText).join(" ");

/** One line saying what you bet and what happened, plus the full breakdown when the row is opened. */
function roundLines(key: string, d: Detail): { summary: string; more: string[] } {
  const game = key.split(":")[0];
  if (game === "aviator") {
    const bets = d.bets as { slot: number; amount: number; auto: number | null; cash: number | null }[];
    const crash = d.crash === null ? "Round still running" : `Plane crashed at ${Number(d.crash).toFixed(2)}x`;
    const mine = bets.map((b) => `Bet ${b.slot}: ${n(b.amount)} → ${b.cash ? `cashed out at ${b.cash.toFixed(2)}x` : "not cashed out"}`);
    return { summary: `${mine.join(" • ")} • ${crash}`, more: [...bets.map((b) => (b.auto ? `Bet ${b.slot} auto cash-out was ${b.auto.toFixed(2)}x` : "")).filter(Boolean)] };
  }
  if (game === "stockmarket") {
    const bets = d.bets as { side: string; amount: number; cashTick: number | null }[];
    const close = d.close === null ? "Round still running" : `Market closed ${Number(d.close) > 1 ? "Up" : Number(d.close) < 1 ? "Down" : "flat"} (${((Number(d.close) - 1) * 100).toFixed(2)}%)`;
    return { summary: `${bets.map((b) => `${sideLabel(b.side)} ${n(b.amount)}${b.cashTick !== null && b.cashTick < 80 ? " (closed early)" : ""}`).join(" • ")} • ${close}`, more: [] };
  }
  if (game === "roulette") return { summary: `Ball landed on ${rouletteText(Number(d.num))}`, more: [] };
  if (game === "blackjack") {
    const hands = (d.hands as { cards: CardJ[]; result?: string; bet?: number }[]) ?? [];
    return {
      summary: `${hands.map((h, i) => `${hands.length > 1 ? `Hand ${i + 1}: ` : "You: "}${cards(h.cards)}${h.result ? ` (${h.result})` : ""}`).join(" • ")} • Dealer: ${cards(d.dealer)}`,
      more: [],
    };
  }
  if (game === "cricket") {
    const bets = d.bets as { market: string; runner: string; type: string; rate: number | null; stake: number; status: string; result: string | null }[];
    const line = (b: (typeof bets)[number]) => `${b.market} • ${b.runner} ${b.type} @ ${b.rate ?? "—"} • ${n(b.stake)} → ${b.status === "OPEN" ? "waiting for result" : b.status === "VOID" ? "void (returned)" : b.status === "WON" ? "won" : "lost"}${b.result ? ` (result: ${b.result})` : ""}`;
    return { summary: bets.length === 1 ? line(bets[0]) : `${bets.length} bets on this match — tap to see them`, more: bets.length > 1 ? bets.map(line) : [] };
  }
  // Andar Bahar / Dragon Tiger / Lucky 7
  const bets = (d.bets as { side: string; v: number }[]) ?? [];
  const c = (d.cards as Record<string, unknown>) ?? {};
  const you = `Your bet: ${bets.map((b) => `${sideLabel(b.side)} ${n(b.v)}`).join(", ") || "—"}`;
  const won = d.winner ? `${sideLabel(String(d.winner))} won` : "";
  if (game === "andar-bahar") {
    const a = (c.andar as CardJ[]) ?? [], b = (c.bahar as CardJ[]) ?? [];
    return { summary: `${you} • ${won} • Joker ${cardText(c.joker as CardJ)}`, more: [`Andar: ${cards(a)}`, `Bahar: ${cards(b)}`, `${a.length + b.length} cards dealt`] };
  }
  if (game === "dragon-tiger") return { summary: `${you} • ${won}`, more: [`Dragon ${cardText(c.dragon as CardJ)} vs Tiger ${cardText(c.tiger as CardJ)}`] };
  return { summary: `${you} • ${won}`, more: [`Card: ${cardText(c.card as CardJ)}`] };
}

function useRoundDetail() {
  const [detail, setDetail] = useState<Record<string, Detail>>({});
  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase().auth.getSession();
      const r = await fetch("/api/my-history", { headers: { Authorization: `Bearer ${data.session?.access_token ?? ""}` } }).catch(() => null);
      const j = await r?.json().catch(() => null);
      if (active && r?.ok && j?.detail) setDetail(j.detail);
    })();
    return () => { active = false; };
  }, []);
  return detail;
}

export function GameHistory({ nav }: { nav: Nav }) {
  const { txns } = useStore();
  const detail = useRoundDetail();
  const [openId, setOpenId] = useState<string | null>(null);
  // One row per round: total staked, what it paid back and the net result.
  const rows = groupRounds(txns.filter((t) => t.type === "bet" || t.type === "winning" || t.type === "bonus")).map((r) => ({ r, g: GAMES.find((g) => r.game.startsWith(g.name)) }));
  return (
    <div className="pb-10 fadein">
      <Header title="Game History" onBack={nav.back} />
      <div className="px-4 space-y-2.5">
        {rows.map(({ r, g }) => {
          const net = r.paid - r.staked;
          const done = r.paidOut || r.settled;
          const tag = !done ? "Playing" : net > 0 ? "Won" : net === 0 ? "Returned" : "Lost";
          const good = done && net >= 0;
          const key = detailKey(r.game, r.hand);
          const d = key ? detail[key] : undefined;
          const lines = key && d ? roundLines(key, d) : null;
          const open = openId === r.id;
          return (
            <button key={r.id} onClick={() => lines && setOpenId(open ? null : r.id)} className="card p-2.5 w-full text-left block">
              <div className="flex items-center gap-3">
                {g ? <GameThumb game={g} className="w-14 h-14 shrink-0 [&>*]:scale-[.55]" /> : <div className="w-14 h-14 rounded-xl bg-white/5 shrink-0" />}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{g?.name ?? r.game.replace(/^CRICKET: /, "Cricket • ")}</div>
                  <div className="text-[11px] text-[var(--ink-soft)] truncate">{[r.hand ?? r.desc, r.when].filter(Boolean).join(" • ")}</div>
                  <div className="text-[11px] text-white/45 truncate">Bet {inr(r.staked)}{r.paidOut ? ` • Got ${inr(r.paid)}` : ""}</div>
                </div>
                <div className="text-right pr-1">
                  <div className={`text-[10px] pill px-2 py-0.5 inline-block ${!done ? "bg-white/10 text-white/70" : good ? "bg-neon-400/15 text-neon-400" : "bg-rose-500/15 text-rose-400"}`}>{tag}</div>
                  <div className={`text-sm font-semibold mt-1 ${!done ? "text-white/70" : good ? "text-neon-400" : "text-rose-400"}`}>{done ? (net > 0 ? "+" : net < 0 ? "-" : "") : "-"}{inr(Math.abs(done ? net : r.staked))}</div>
                </div>
              </div>
              {lines && (
                <div className="mt-2 rounded-lg bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-white/75">
                  <div className={open ? "" : "truncate"}>{lines.summary}</div>
                  {open && lines.more.map((m, i) => <div key={i} className="mt-0.5 text-white/60">{m}</div>)}
                  {!open && (lines.more.length > 0 || lines.summary.length > 60) && <div className="text-[10px] text-neon-400 mt-0.5">Tap for details</div>}
                </div>
              )}
            </button>
          );
        })}
        {rows.length === 0 && <div className="card py-10 text-center text-sm text-white/40">No games played yet</div>}
      </div>
    </div>
  );
}

function LimitSlider({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: "coins" | "min"; onChange: (v: number) => void }) {
  return (
    <div className="p-4">
      <div className="flex justify-between text-sm"><span>{label}</span><span className="font-semibold text-neon-400">{unit === "coins" ? inr(value) : `${value} min`}</span></div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full mt-3 accent-green-400" />
    </div>
  );
}

export function ResponsibleGaming({ nav }: { nav: Nav }) {
  const { limits, setLimits, showToast } = useStore();
  const [l, setL] = useState(limits);
  const [brk, setBrk] = useState<string | null>(null);
  return (
    <div className="pb-10 fadein">
      <Header title="Responsible Gaming" onBack={nav.back} />
      <div className="px-4">
        <div className="text-sm text-[var(--ink-soft)]">Set limits that keep gaming fun. Lower limits apply instantly; higher limits take effect after 24 hours.</div>
        <div className="card mt-4 divide-y divide-white/5">
          <LimitSlider label="Daily coin limit" value={l.deposit} min={500} max={50000} step={500} unit="coins" onChange={(v) => setL({ ...l, deposit: v })} />
          <LimitSlider label="Daily loss limit" value={l.loss} min={500} max={25000} step={500} unit="coins" onChange={(v) => setL({ ...l, loss: v })} />
          <LimitSlider label="Session time limit" value={l.session} min={15} max={480} step={15} unit="min" onChange={(v) => setL({ ...l, session: v })} />
        </div>
        <button onClick={() => { setLimits(l); showToast("Limits saved"); }} className="btn-green w-full py-3 rounded-2xl mt-4">Save Limits</button>

        <div className="text-sm font-semibold mt-7 mb-2">Take a break</div>
        <div className="grid grid-cols-3 gap-2">
          {["24 hours", "7 days", "30 days"].map((d) => (
            <button key={d} onClick={() => setBrk(d)} className={`card py-3 text-sm ${brk === d ? "!border-neon-400 text-neon-400" : ""}`}>{d}</button>
          ))}
        </div>
        <button disabled={!brk} onClick={() => showToast(`Self-exclusion for ${brk} (demo)`)} className="btn-ghost w-full py-3 rounded-2xl mt-3 text-sm disabled:opacity-40">Self-exclude {brk ? `for ${brk}` : ""}</button>
        <div className="card mt-6 p-4 flex gap-3 text-xs text-[var(--ink-soft)]">
          <Clock3 size={18} className="shrink-0 text-gold-400" />
          Need to talk? Reach out to our support team anytime, or contact a professional counselling helpline.
        </div>
      </div>
    </div>
  );
}

export function Help({ nav }: { nav: Nav }) {
  const [open, setOpen] = useState<number | null>(0);
  const { player } = useStore();
  const support = useSupport();
  return (
    <div className="pb-10 fadein">
      <Header title="Help & Support" onBack={nav.back} />
      <div className="px-4">
        {support?.whatsapp ? (
          <a
            href={whatsappLink(support.whatsapp, `Hi, I need help with Khelobaazi.${player ? ` My Player ID: ${player.code}` : ""}`)}
            target="_blank"
            rel="noopener noreferrer"
            className="card p-4 flex items-center gap-3 active:scale-[.99] transition-transform"
            style={{ background: "linear-gradient(135deg,#128c7e33,#25d36622)", borderColor: "#25d36655" }}
          >
            <span className="w-11 h-11 rounded-full grid place-items-center bg-[#25d366] shrink-0"><MessageCircle className="text-white" /></span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-semibold">Chat with us on WhatsApp</span>
              <span className="block text-[12px] text-[var(--ink-soft)]">{prettyNumber(support.whatsapp)}{support.note ? ` • ${support.note}` : ""}</span>
            </span>
            <ChevronRight size={18} className="text-white/40" />
          </a>
        ) : (
          <div className="card p-4 text-sm text-[var(--ink-soft)]">{support ? "For help, contact your agent." : "Loading…"}</div>
        )}
        <div className="text-sm font-semibold mt-6 mb-2">FAQs</div>
        <div className="card divide-y divide-white/5">
          {FAQS.map((f, i) => (
            <div key={i}>
              <button onClick={() => setOpen(open === i ? null : i)} className="w-full flex items-center gap-3 p-4 text-left text-sm">
                <span className="flex-1">{f.q}</span>
                <ChevronDown size={18} className={`transition-transform text-white/50 ${open === i ? "rotate-180" : ""}`} />
              </button>
              {open === i && <div className="px-4 pb-4 -mt-1 text-xs text-[var(--ink-soft)] leading-relaxed fadein">{f.a}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Settings({ nav }: { nav: Nav }) {
  const snd = useSoundPrefs();
  const [changePwOpen, setChangePwOpen] = useState(false);
  const [n, setN] = useState({ push: true, whatsapp: true });
  const s = { ...snd, ...n };
  const rows: [keyof typeof s, string][] = [["sound", "Sound effects"], ["push", "Push notifications"], ["whatsapp", "WhatsApp updates"]];
  const setS = (next: typeof s) => {
    if (next.sound !== snd.sound) setPref("sound", next.sound);
    setN({ push: next.push, whatsapp: next.whatsapp });
  };
  return (
    <div className="pb-10 fadein">
      <Header title="Settings" onBack={nav.back} />
      <div className="px-4">
        <div className="card divide-y divide-white/5">
          {rows.map(([k, label]) => (
            <div key={String(k)} className="flex items-center justify-between p-4 text-sm">{label}<Toggle on={s[k]} onChange={(v) => setS({ ...s, [k]: v })} /></div>
          ))}
        </div>

        <div className="card mt-4 divide-y divide-white/5 text-sm">
          <button
            onClick={() => setChangePwOpen(true)}
            className="w-full flex items-center gap-3 p-4 text-left hover:bg-white/5 transition"
          >
            <KeyRound size={18} className="text-amber-400" />
            <span className="flex-1 font-medium">Change Password</span>
            <ChevronRight size={18} className="text-white/40" />
          </button>
        </div>

        <div className="card mt-4 divide-y divide-white/5 text-sm">
          <div className="flex items-center gap-3 p-4"><Globe size={18} className="text-white/70" /><span className="flex-1">Language</span><span className="text-white/60">English</span></div>
          <div className="flex items-center gap-3 p-4"><FileCheck2 size={18} className="text-white/70" /><span className="flex-1">Terms & Conditions</span><ChevronRight size={18} className="text-white/40" /></div>
          <div className="flex items-center gap-3 p-4"><ShieldCheck size={18} className="text-white/70" /><span className="flex-1">Privacy Policy</span><ChevronRight size={18} className="text-white/40" /></div>
          <div className="flex items-center gap-3 p-4"><Globe size={18} className="text-white/70" /><span className="flex-1">Fair Play Policy</span><ChevronRight size={18} className="text-white/40" /></div>
        </div>
      </div>
      {changePwOpen && <ChangePasswordModal onClose={() => setChangePwOpen(false)} />}
    </div>
  );
}
