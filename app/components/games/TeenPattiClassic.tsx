"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, ChevronLeft, LogOut } from "lucide-react";
import { inr, type Card as UiCard } from "../../lib/data";
import { useStore } from "../../lib/store";
import { supabase } from "../../lib/supabase";
import { clearActive } from "../../lib/rejoin";
import { dealSound, sfx, useSoundOnRise } from "../../lib/sound";
import { HomeButton, Money, PlayingCard, Sheet } from "../ui";
import { LandscapeStage } from "./LandscapeStage";
import { BotTag, ResultSheet, TimerAvatar } from "./bots";
import type { Nav } from "../nav";
import type { TableResponse } from "../../lib/server/teenpatti";
import type { ActionType } from "../../lib/teenpatti/engine";
import type { Card } from "../../lib/teenpatti/evaluator";

// Classic Teen Patti table (rules: app/lib/teenpatti/RULES.md). The server deals, keeps the clocks, plays the bots
// and settles; this screen polls /api/teenpatti/state every second and sends actions with an id so a retry can
// never act twice. Back keeps your seat for a minute; Leave gives it up (packing you if a hand is on).

const SUIT: Record<Card["s"], UiCard["s"]> = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RANK: Record<number, UiCard["r"]> = { 14: "A", 13: "K", 12: "Q", 11: "J" };
const ui = (c: Card): UiCard => ({ r: RANK[c.r] ?? (String(c.r) as UiCard["r"]), s: SUIT[c.s] });

// Other seats around the oval; you sit at the bottom centre. Play moves anti-clockwise on screen: the player who
// acts after you is on your right, then the top seats from right to left, and the one before you on your left.
const SEAT_BOX: { style: React.CSSProperties; reverse?: boolean }[] = [
  { style: { left: "1%", top: "52%", transform: "translateY(-50%)" } },
  { style: { left: "13%", top: "2%" } },
  { style: { left: "50%", top: "2%", transform: "translateX(-50%)" } },
  { style: { right: "13%", top: "2%" }, reverse: true },
  { style: { right: "1%", top: "52%", transform: "translateY(-50%)" }, reverse: true },
];

const SEQUENCES = ["A K Q", "A 2 3", "K Q J", "Q J 10", "J 10 9", "10 9 8", "9 8 7", "8 7 6", "7 6 5", "6 5 4", "5 4 3", "4 3 2"];

let cachedAuthToken: string | null = null;
let tokenExpiresAt = 0;

async function getAuthToken(): Promise<string> {
  const now = Date.now();
  if (cachedAuthToken && now < tokenExpiresAt) return cachedAuthToken;
  const { data } = await supabase().auth.getSession();
  cachedAuthToken = data.session?.access_token ?? "";
  tokenExpiresAt = now + 45000;
  return cachedAuthToken;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAuthToken();
  const r = await fetch(path, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 409) throw new Error(j.error ?? "Something went wrong");
  return j as T;
}

interface FlyingCoin {
  id: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  amount: number;
  delay?: number;
  go: boolean;
}


/** An action button. Defined at module level on purpose: a component created inside the render would be a new type
 *  every render, and the 250 ms clock re-render would then replace the button's DOM node mid-tap and lose the tap. */
function Btn({ opt, label, amount, className, onClick, busy, pending, onBlocked }: {
  opt: { ok: boolean; reason: string | null }; label: string; amount?: number; className: string; onClick: () => void;
  busy: boolean; pending: boolean; onBlocked: (reason: string) => void;
}) {
  return (
    <button
      disabled={busy}
      title={opt.reason ?? undefined}
      onClick={() => {
        sfx.click();
        if (opt.ok) onClick();
        else if (opt.reason) onBlocked(opt.reason);
      }}
      className={`rounded-lg px-3.5 py-1.5 text-[12px] font-bold border leading-tight transition-transform active:scale-95 duration-75 select-none ${className} ${opt.ok ? "cursor-pointer" : "opacity-40 cursor-not-allowed"} ${pending ? "ring-2 ring-white/80 animate-pulse" : ""}`}
    >
      {pending ? "…" : label}{amount !== undefined && !pending && <><br /><span className="text-[13px]">{inr(amount)}</span></>}
    </button>
  );
}

export function TeenPattiClassic({ nav, buyIn, code }: { nav: Nav; buyIn: number; code?: string }) {
  const { total, showToast, applyBalance } = useStore();
  const [resp, setResp] = useState<TableResponse | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [rules, setRules] = useState(false);
  const [peek, setPeek] = useState(false); // result sheet closed to look at the table
  const [sheetHand, setSheetHand] = useState(0);
  const [flyingCoins, setFlyingCoins] = useState<FlyingCoin[]>([]);
  /** The action just tapped, shown at once while the server confirms it (and the coins it puts in the pot). */
  const [pending, setPending] = useState<{ type: ActionType; amount: number } | null>(null);
  const inflight = useRef(false); // an action is on its way: polls wait, so an older reply can't overwrite its result
  const newest = useRef({ hand: 0, version: 0 }); // the latest state seen, so a slow poll reply is never applied over a newer one
  const skipMyCoins = useRef(false); // coins for my own bet already flew when I tapped
  const tableId = useRef<string | null>(null);
  const offset = useRef(0); // server clock − local clock
  const polling = useRef(false);
  const lastEvent = useRef<{ handId: string; seq: number } | null>(null); // last animated event; seq restarts every hand
  const coinIdGen = useRef(0);

  const take = useCallback((r: TableResponse) => {
    offset.current = r.table.serverNow - Date.now();
    const hand = r.table.handNo, version = r.view?.version ?? 0;
    const n = newest.current;
    if (hand < n.hand || (hand === n.hand && version < n.version)) return; // a reply that was overtaken (e.g. a poll started before an action)
    newest.current = { hand, version };
    setResp(r);
    applyBalance(r.balance);
  }, [applyBalance]);

  // Sit down, then follow the table.
  useEffect(() => {
    let alive = true;
    api<TableResponse>("/api/teenpatti/join", { method: "POST", body: JSON.stringify(code ? { code } : { boot: buyIn }) })
      .then((r) => { if (!alive) return; tableId.current = r.table.id; take(r); })
      .catch((e) => alive && setErr(e.message));
    const poll = async () => {
      if (!tableId.current || polling.current || inflight.current) return;
      polling.current = true;
      try { take(await api<TableResponse>(`/api/teenpatti/state?table=${tableId.current}`)); } catch (e) { if (alive) setErr((e as Error).message); }
      polling.current = false;
    };
    const t = setInterval(poll, 1000);
    const clock = setInterval(() => setNow(Date.now()), 250);
    return () => { alive = false; clearInterval(t); clearInterval(clock); };
  }, [buyIn, code, take]);

  const v = resp?.view ?? null;
  const tbl = resp?.table ?? null;
  useSoundOnRise(tbl?.handNo ?? 0, () => dealSound(9, 110));
  useSoundOnRise(v?.pot ?? 0, sfx.chip);
  useEffect(() => { if (v?.phase === "COMPLETED" && tbl && sheetHand !== tbl.handNo) { setSheetHand(tbl.handNo); setPeek(false); } }, [v?.phase, tbl, sheetHand]);

  const serverNow = now + offset.current;
  const secsTo = (ms: number | null) => (ms ? Math.max(0, (ms - serverNow) / 1000) : 0);

  const act = async (type: ActionType, requestId?: string) => {
    if (!tableId.current || !v || busy) return;
    setBusy(true);
    inflight.current = true;
    // Show the action at once: the tapped button pulses, and for a bet the coins fly and the pot grows before the
    // server has answered (its reply then replaces this).
    const me = v.me;
    const amount = type === "BET_MIN" ? me?.min.amount ?? 0 : type === "BET_DOUBLE" ? me?.double.amount ?? 0 : type === "SHOW" ? me?.show.amount ?? 0 : type === "SIDESHOW_REQUEST" ? me?.sideshow.amount ?? 0 : 0;
    setPending({ type, amount });
    if (amount > 0 && me) { skipMyCoins.current = true; spawnFlyingCoins(me.playerId, amount); }
    try {
      const r = await api<{ ok: boolean; message?: string; state: TableResponse }>("/api/teenpatti/act", {
        method: "POST",
        body: JSON.stringify({ table: tableId.current, actionId: crypto.randomUUID(), handId: v.handId, expectedVersion: v.version, type, requestId }),
      });
      if (r.state) take(r.state);
      if (!r.ok && r.message) showToast(r.message);
      if (!r.ok) skipMyCoins.current = false;
    } catch (e) {
      skipMyCoins.current = false;
      showToast((e as Error).message);
    } finally {
      inflight.current = false;
      setPending(null);
      setBusy(false);
    }
  };

  const leave = async () => {
    if (tableId.current) await api("/api/teenpatti/leave", { method: "POST", body: JSON.stringify({ table: tableId.current }) }).catch(() => {});
    clearActive();
    nav.back();
  };
  const away = () => { showToast("Your seat is kept for a minute — tap Rejoin to come back"); nav.back(); };

  if (err && !resp) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-4 px-6 text-center fadein">
        <div className="text-sm text-white/80">{err}</div>
        {/coins|limit/i.test(err) && <button onClick={() => nav.push({ name: "addcash" })} className="btn-green pill px-6 py-2.5 text-sm">Get Coins</button>}
        <button onClick={nav.back} className="btn-ghost pill px-6 py-2.5 text-sm">Back to lobby</button>
      </div>
    );
  }

  const me = v?.me ?? null;
  const myId = me?.playerId;
  const seats = tbl?.seats ?? [];
  const mySeatNo = seats.find((s) => s.playerId === myId)?.seat ?? -1;
  // Clockwise from the seat after yours (play moves that way).
  // Everyone else: seated players, plus anyone still in the hand whose seat was given up (a bumped bot).
  const unseated = (v?.players ?? []).filter((p) => !seats.some((s) => s.playerId === p.playerId)).map((p) => ({ seat: p.seat, playerId: p.playerId, name: p.name, emoji: "🤖", bot: p.bot, bal: null, away: false }));
  const others = [...seats, ...unseated].filter((s) => s.playerId !== myId).sort((a, b) => ((a.seat - mySeatNo + 6) % 6) - ((b.seat - mySeatNo + 6) % 6)).slice(0, 5);
  const inHand = (id: string) => v?.players.find((p) => p.playerId === id) ?? null;
  const liveHand = v?.phase === "PLAYING" || v?.phase === "SIDESHOW_PENDING";
  const turnSecs = (tbl?.rules.turnTimeoutMs ?? 15000) / 1000;
  const lastAction = (id: string) => {
    const e = [...(v?.events ?? [])].reverse().find((x) => x.playerId === id && ["BET", "PACK", "TIMEOUT", "LEFT", "SHOW", "SIDESHOW_REQUEST", "SIDESHOW_RESULT", "SEE"].includes(x.type));
    if (!e) return null;
    switch (e.type) {
      case "BET": return `${e.note ?? "Bet"} ${inr(e.amount ?? 0)}`;
      case "PACK": return "Packed";
      case "TIMEOUT": return "Timed out";
      case "LEFT": return "Left";
      case "SHOW": return "Show";
      case "SIDESHOW_REQUEST": return "Side show?";
      case "SIDESHOW_RESULT": return "Lost side show";
      case "SEE": return "Seen";
    }
    return null;
  };
  const settled = v?.settlement ?? null;
  const iWon = !!settled && settled.winners.some((w) => w.playerId === myId);
  const myWin = settled?.winners.find((w) => w.playerId === myId)?.amount ?? 0;
  const winnerNames = settled ? settled.winners.map((w) => (w.playerId === myId ? "You" : seats.find((s) => s.playerId === w.playerId)?.name ?? "Player")) : [];
  const meInHand = myId ? inHand(myId) : null;
  const myCards = me?.cards ?? null;

  const getSeatCoords = useCallback((playerId: string) => {
    if (playerId === myId) {
      return { x: 50, y: 88 };
    }
    const k = others.findIndex((o) => o.playerId === playerId);
    if (k !== -1) {
      const boxIdx = 4 - k;
      const coords = [
        { x: 12, y: 52 }, // 0: left
        { x: 22, y: 14 }, // 1: top-left
        { x: 50, y: 14 }, // 2: top-center
        { x: 78, y: 14 }, // 3: top-right
        { x: 88, y: 52 }, // 4: right
      ];
      return coords[boxIdx] ?? { x: 50, y: 14 };
    }
    return { x: 50, y: 14 };
  }, [myId, others]);

  const spawnFlyingCoins = useCallback((playerId: string, amount: number) => {
    const from = getSeatCoords(playerId);
    const target = { x: 50, y: 36 };
    const numCoins = Math.min(5, Math.max(2, Math.floor(Math.log10(Math.max(1, amount)) * 2)));
    const newCoins: FlyingCoin[] = [];

    for (let i = 0; i < numCoins; i++) {
      coinIdGen.current += 1;
      newCoins.push({
        id: coinIdGen.current,
        startX: from.x + (Math.random() - 0.5) * 4,
        startY: from.y + (Math.random() - 0.5) * 4,
        endX: target.x + (Math.random() - 0.5) * 5,
        endY: target.y + (Math.random() - 0.5) * 5,
        amount,
        delay: i * 65,
        go: false,
      });
    }

    setFlyingCoins((prev) => [...prev, ...newCoins]);

    requestAnimationFrame(() => {
      setFlyingCoins((prev) =>
        prev.map((c) => (newCoins.some((nc) => nc.id === c.id) ? { ...c, go: true } : c))
      );
    });

    setTimeout(() => {
      sfx.chip();
      setFlyingCoins((prev) => prev.filter((c) => !newCoins.some((nc) => nc.id === c.id)));
    }, 850 + numCoins * 65);
  }, [getSeatCoords]);

  useEffect(() => {
    if (!v?.events || v.events.length === 0) return;
    const top = Math.max(...v.events.map((e) => e.seq));
    const last = lastEvent.current;
    if (last === null) {
      // First look at the table: don't replay the history as animations.
      lastEvent.current = { handId: v.handId, seq: top };
      return;
    }
    // Event numbers start again at 1 with every hand, so a new hand animates from its first boot.
    const since = last.handId === v.handId ? last.seq : 0;
    const newEvents = v.events.filter((e) => e.seq > since);
    lastEvent.current = { handId: v.handId, seq: top };
    if (newEvents.length === 0) return;

    for (const ev of newEvents) {
      if ((ev.type === "BET" || ev.type === "BOOT" || ev.type === "SHOW" || ev.type === "SIDESHOW_REQUEST") && ev.playerId && (ev.amount ?? 0) > 0) {
        if (ev.playerId === v.me?.playerId && ev.type !== "BOOT" && skipMyCoins.current) { skipMyCoins.current = false; continue; }
        spawnFlyingCoins(ev.playerId, ev.amount!);
      }
    }
  }, [v?.events, v?.handId, v?.me?.playerId, spawnFlyingCoins]);

  return (
    <LandscapeStage>
      <div className="relative w-full h-full flex flex-col select-none">
        {/* Top bar */}
        <div className="h-11 shrink-0 flex items-center gap-2 px-3 bg-black/30">
          <button onClick={away} aria-label="Back to lobby (seat kept)" className="w-8 h-8 grid place-items-center rounded-full bg-white/10 active:scale-95 transition-transform"><ChevronLeft size={18} /></button>
          <HomeButton className="w-8 h-8 grid place-items-center rounded-full bg-white/10 active:scale-95 transition-transform" />
          <div className="leading-tight">
            <div className="text-sm font-semibold">Teen Patti</div>
            <div className="text-[11px] text-white/60">Boot {inr(tbl?.boot ?? buyIn)}{tbl?.handNo ? ` • Hand #${tbl.handNo}` : ""}</div>
          </div>
          {tbl?.code && (
            <button onClick={() => { navigator.clipboard?.writeText(tbl.code!); showToast("Code copied"); }} className="ml-3 pill bg-white/10 px-3 py-1 text-[12px] active:scale-95 transition-transform">
              Private • <b className="tracking-widest text-gold-300">{tbl.code}</b> • Copy
            </button>
          )}
          <div className="ml-auto flex items-center gap-3">
            <button onClick={() => setRules(true)} className="text-[12px] text-white/60 flex items-center gap-1 active:scale-95 transition-transform"><BookOpen size={13} /> Rules</button>
            <Money n={total} className="text-sm font-semibold text-neon-400" />
            <button onClick={leave} className="text-[12px] text-white/60 flex items-center gap-1 active:scale-95 transition-transform"><LogOut size={13} /> Leave</button>
          </div>
        </div>

        {/* Table */}
        <div className="relative flex-1 min-h-0 overflow-hidden">
          {/* Flying coins animation for each chaal / bet */}
          {flyingCoins.map((coin) => (
            <div
              key={coin.id}
              className="pointer-events-none absolute z-30 transition-all duration-700 ease-out"
              style={{
                left: `${coin.go ? coin.endX : coin.startX}%`,
                top: `${coin.go ? coin.endY : coin.startY}%`,
                transform: "translate(-50%, -50%)",
                opacity: coin.go ? 0.95 : 1,
                transitionDelay: `${coin.delay || 0}ms`,
              }}
            >
              <div className="w-5 h-5 rounded-full bg-gradient-to-tr from-amber-600 via-yellow-400 to-amber-200 border border-yellow-200 shadow-[0_0_10px_rgba(251,191,36,0.9)] flex items-center justify-center font-bold text-[10px] text-amber-950">
                🪙
              </div>
            </div>
          ))}

          <div className="absolute left-[10%] right-[10%] top-[13%] bottom-[17%] felt-oval">
            <div className="absolute inset-x-0 top-[44%] text-center text-[20px] font-black tracking-[0.35em] text-white/10">TEEN PATTI</div>
          </div>

          {/* Pot and status */}
          <div className="absolute left-1/2 top-[36%] -translate-x-1/2 -translate-y-1/2 flex flex-col items-center text-center z-10 w-[44%]">
            {!resp ? (
              <div className="text-[13px] text-white/80">Finding a table…</div>
            ) : !liveHand ? (
              <div className="fadein">
                {settled && settled.reason !== "VOID" && (
                  <>
                    <div className="text-base font-semibold">{iWon ? "You win!" : `${winnerNames.join(" & ")} ${winnerNames.length > 1 ? "split the pot" : "wins"}`}</div>
                    <div className="text-[13px] text-gold-300 font-semibold">{inr(iWon ? myWin : settled.winners[0]?.amount ?? 0)} • {settled.reason === "SHOW" ? "Show" : settled.reason === "FORCED_SHOWDOWN" ? "Showdown" : "Everyone else packed"}</div>
                  </>
                )}
                {settled?.reason === "VOID" && <div className="text-[13px] text-white/80">Hand voided — everyone refunded</div>}
                <div className="text-[12px] text-white/60 mt-0.5">
                  {tbl!.waiting ? (tbl!.code ? "Waiting for friends — share the code" : "Waiting for players…") : tbl!.nextHandAt ? `Dealing in ${Math.ceil(secsTo(tbl!.nextHandAt))}s` : "Dealing…"}
                </div>
              </div>
            ) : (
              <>
                <div className="pill bg-black/55 px-4 py-1 text-[15px] text-gold-300 font-bold">Pot {inr(v!.pot + (pending?.amount ?? 0))}</div>
                <div className="text-[11px] text-white/60 mt-1">Stake {inr(v!.baseStake)}{v!.rules.potCap ? ` • Pot limit ${inr(v!.rules.potCap)}` : ""}</div>
                {v!.pending ? (
                  <div className="text-[12px] text-fuchsia-300 mt-1">
                    {v!.pending.requesterId === myId ? "You" : seats.find((s) => s.playerId === v!.pending!.requesterId)?.name} asked {v!.pending.targetId === myId ? "you" : seats.find((s) => s.playerId === v!.pending!.targetId)?.name} for a side show • {Math.ceil(secsTo(v!.pending.deadline))}s
                  </div>
                ) : v!.turnId && (
                  <div className={`text-[13px] mt-1 ${v!.turnId === myId ? "text-neon-400 font-bold" : "text-white/75"}`}>
                    {pending ? "Sending…" : <>{v!.turnId === myId ? "Your turn" : `${seats.find((s) => s.playerId === v!.turnId)?.name ?? "…"}'s turn`} • {Math.ceil(secsTo(v!.turnDeadline))}s</>}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Other players */}
          {others.map((s, k) => {
            const p = inHand(s.playerId);
            const box = SEAT_BOX[4 - k] ?? SEAT_BOX[4]; // k = 0 is the next to act → right-hand seat
            const turn = liveHand && v!.turnId === s.playerId;
            const won = !!settled && settled.winners.some((w) => w.playerId === s.playerId);
            const tagText = p ? lastAction(s.playerId) : null;
            return (
              <div key={s.playerId} className={`absolute flex items-center gap-1.5 z-10 ${box.reverse ? "flex-row-reverse" : ""} ${won ? "drop-shadow-[0_0_14px_rgba(253,224,71,.8)]" : ""}`} style={box.style}>
                <div className="flex flex-col items-center">
                  <TimerAvatar emoji={s.emoji} size={42} active={turn} left={turn ? secsTo(v!.turnDeadline) : 0} dim={!p || p.status === "PACKED" || s.away} total={turnSecs} dealer={p?.isDealer} />
                  <div className="mt-0.5 px-2 py-0.5 rounded-md bg-black/60 text-center max-w-[96px]">
                    <div className="text-[11px] font-medium leading-tight truncate">{s.name}{s.bot && <BotTag />}</div>
                    <div className="text-[11px] text-gold-300 leading-tight">{s.bot ? inr(s.bal ?? 0) : p ? `In pot ${inr(p.contributed)}` : s.away ? "Away" : "Waiting"}</div>
                  </div>
                </div>
                <div className="flex flex-col items-center">
                  {p && (
                    <div className="flex -space-x-4">
                      {(p.cards ?? [0, 1, 2]).map((c, j) => <PlayingCard key={j} card={typeof c === "number" ? undefined : ui(c)} faceDown={!p.cards} size="sm" className={p.status === "PACKED" ? "opacity-40" : ""} />)}
                    </div>
                  )}
                  {p?.handName ? (
                    <div className="mt-1 text-[10px] pill px-1.5 py-0.5 bg-gold-300/20 text-gold-200 whitespace-nowrap">{p.handName}</div>
                  ) : tagText ? (
                    <div className={`mt-1 text-[10px] pill px-1.5 py-0.5 whitespace-nowrap ${p?.status === "PACKED" ? "bg-rose-500/30 text-rose-200" : "bg-black/50"}`}>{tagText}</div>
                  ) : p && liveHand ? (
                    <div className="mt-1 text-[10px] text-white/70">{p.seen ? "Seen" : `Blind ${p.blinds}/${v!.blindLimit}`}</div>
                  ) : null}
                </div>
              </div>
            );
          })}

          {/* You */}
          <div className="absolute left-1/2 bottom-1 -translate-x-1/2 flex items-end gap-3 z-20">
            <div className="flex flex-col items-center mb-1">
              <TimerAvatar emoji={seats.find((s) => s.playerId === myId)?.emoji} size={50} active={!!liveHand && v!.turnId === myId} left={liveHand && v!.turnId === myId ? secsTo(v!.turnDeadline) : 0} dim={meInHand?.status === "PACKED"} total={turnSecs} dealer={meInHand?.isDealer} />
              <div className="mt-0.5 px-2 py-0.5 rounded-md bg-black/65 text-center">
                <div className="text-[11px] font-medium leading-tight">
                  You{meInHand && liveHand && (meInHand.status === "PACKED" ? <span className="text-rose-300"> • Packed</span> : <span className="text-white/60"> • {meInHand.seen ? "Seen" : `Blind ${meInHand.blinds}/${v!.blindLimit}`}</span>)}
                </div>
                <div className="text-[11px] text-gold-300 leading-tight">{inr(total)}</div>
              </div>
            </div>
            {resp && !me?.inHand && tbl!.handNo > 0 && liveHand ? (
              <div className="mb-6 text-[13px] text-white/75 bg-black/50 rounded-lg px-3 py-2">You&apos;ll be dealt in from the next hand</div>
            ) : resp && !liveHand && resp.balance < tbl!.boot ? (
              <div className="mb-3 text-center bg-black/50 rounded-lg px-3 py-2">
                <div className="text-[12px] text-white/75">You need {inr(tbl!.boot)} for the boot</div>
                <button onClick={() => nav.push({ name: "addcash" })} className="btn-green pill px-5 py-1.5 mt-1.5 text-[12px]">Get Coins</button>
              </div>
            ) : meInHand ? (
              <div className="flex flex-col items-center">
                <div
                  className={`flex -space-x-3 select-none ${me?.canSee?.ok ? "cursor-pointer active:scale-95 transition-transform" : ""}`}
                  onClick={() => {
                    if (me?.canSee?.ok) {
                      sfx.click();
                      act("SEE_CARDS");
                    }
                  }}
                  title={me?.canSee?.ok ? "Tap cards to see" : undefined}
                >
                  {(myCards ?? [undefined, undefined, undefined]).map((c, i) => (
                    <PlayingCard key={i} card={c ? ui(c) : undefined} faceDown={!c} size="lg" className={`${c ? "flip" : ""} ${meInHand.status === "PACKED" ? "opacity-50" : ""}`} style={{ transform: `rotate(${(i - 1) * 7}deg) translateY(${Math.abs(i - 1) * 5}px)` }} />
                  ))}
                </div>
                <div className="mt-1 text-[12px] text-white/85 bg-black/45 rounded px-2">
                  {me?.handName ? <>Your hand: <b className="text-gold-300">{me.handName}</b></> : meInHand.status === "PACKED" ? "Packed without looking" : meInHand.blinds < v!.minBlind ? `Play ${v!.minBlind} blind chaal, then tap See` : `Blind ${meInHand.blinds}/${v!.blindLimit} — tap See anytime`}
                </div>
              </div>
            ) : null}
          </div>

          {/* Side show: answer it, or what came of yours */}
          {me?.answer && (
            <div className="absolute right-3 bottom-3 z-30 w-64 rounded-2xl bg-[#2a1450]/95 border border-fuchsia-400/40 p-3 text-center shadow-xl">
              <div className="text-[13px]"><b>{seats.find((s) => s.playerId === me.answer!.requesterId)?.name}</b> wants a side show — the lower hand packs. Equal hands: they pack.</div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <button disabled={busy} onClick={() => act("SIDESHOW_REJECT", me.answer!.requestId)} className="btn-ghost rounded-full py-2 text-[13px]">Reject</button>
                <button disabled={busy} onClick={() => act("SIDESHOW_ACCEPT", me.answer!.requestId)} className="rounded-full py-2 text-[13px] font-semibold bg-fuchsia-600">Accept • {Math.ceil(secsTo(me.answer.deadline))}s</button>
              </div>
            </div>
          )}
          {liveHand && v!.mySideshows.length > 0 && (
            <div className="absolute left-3 bottom-3 z-30 rounded-xl bg-black/60 px-3 py-2 text-[12px] max-w-[40%]">
              {v!.mySideshows.map((x, i) => (
                <div key={i}>Side show vs <b>{seats.find((s) => s.playerId === x.opponentId)?.name}</b> — you {x.youLost ? <span className="text-rose-300">lost</span> : <span className="text-neon-400">won</span>}</div>
              ))}
            </div>
          )}
        </div>

        {/* Action bar */}
        <div className="h-14 shrink-0 flex items-center gap-2 px-3 bg-black/45 border-t border-white/10">
          {me?.inHand && meInHand?.status === "ACTIVE" && liveHand ? (
            <>
              <Btn opt={me.pack} label="Pack" className="bg-[#8b1d2c] border-white/15 px-5 py-2.5 text-sm" onClick={() => act("PACK")} busy={busy} pending={pending?.type === "PACK"} onBlocked={showToast} />
              <Btn opt={me.sideshow} label={`Side Show${me.sideshow.ok ? ` • ${inr(me.sideshow.amount)}` : ""}`} className="bg-fuchsia-700 border-fuchsia-300/30" onClick={() => act("SIDESHOW_REQUEST")} busy={busy} pending={pending?.type === "SIDESHOW_REQUEST"} onBlocked={showToast} />
              <Btn opt={me.show} label={`Show${me.show.ok ? ` • ${inr(me.show.amount)}` : ""}`} className="bg-[#8b1d2c] border-white/15 px-5 py-2.5 text-sm" onClick={() => act("SHOW")} busy={busy} pending={pending?.type === "SHOW"} onBlocked={showToast} />
              <div className="flex-1 flex justify-center">
                <button
                  disabled={busy}
                  title={me.canSee.reason ?? undefined}
                  onClick={() => {
                    sfx.click();
                    if (me.canSee.ok) act("SEE_CARDS");
                    else if (me.canSee.reason) showToast(me.canSee.reason);
                  }}
                  className={`rounded-full px-6 py-2 text-sm font-bold bg-sky-500 shadow-lg transition-transform active:scale-95 duration-75 select-none ${me.canSee.ok ? "hover:bg-sky-400 cursor-pointer ring-2 ring-sky-300 animate-pulse" : "opacity-40 cursor-not-allowed"}`}
                >
                  {pending?.type === "SEE_CARDS" ? "…" : me.seen ? "Seen ✓" : "See"}
                </button>
              </div>
              <Btn opt={me.double} label={`${me.seen ? "Chaal" : "Blind"} 2x`} amount={me.double.amount} className="bg-[#3d7a1f] border-lime-300/30" onClick={() => act("BET_DOUBLE")} busy={busy} pending={pending?.type === "BET_DOUBLE"} onBlocked={showToast} />
              <Btn opt={me.min} label={me.seen ? "Chaal" : "Blind"} amount={me.min.amount} className="bg-[#b8231f] border-white/20 px-5" onClick={() => act("BET_MIN")} busy={busy} pending={pending?.type === "BET_MIN"} onBlocked={showToast} />
            </>
          ) : (
            <div className="flex-1 text-center text-[13px] text-white/60">
              {liveHand && meInHand?.status === "PACKED" ? "You packed — waiting for this hand to finish" : `Cards are dealt by the server • ${turnSecs}s per turn`}
            </div>
          )}
        </div>
      </div>

      {settled && v && tbl && settled.reason !== "VOID" && (
        <ResultSheet
          open={sheetHand === tbl.handNo && !peek}
          won={iWon}
          title={iWon ? `You won ${inr(myWin)}!` : `${winnerNames.join(" & ")} ${winnerNames.length > 1 ? "split the pot" : "wins"}`}
          sub={settled.reason === "SHOW" ? "Show" : settled.reason === "FORCED_SHOWDOWN" ? "Showdown — pot limit" : "Everyone else packed"}
          left={Math.ceil(secsTo(tbl.nextHandAt))}
          nextLabel="Next hand starts in"
          onLeave={leave}
          onClose={() => setPeek(true)}
        >
          {settled.reveal.length > 0 && (
            <div className="flex justify-center gap-6 mt-4 flex-wrap">
              {settled.reveal.map((r) => (
                <div key={r.playerId} className="flex flex-col items-center gap-1">
                  <div className="flex -space-x-2">{r.cards.map((c, i) => <PlayingCard key={i} card={ui(c)} size="sm" />)}</div>
                  <div className="text-[12px] text-white/60">{r.playerId === myId ? "You" : seats.find((s) => s.playerId === r.playerId)?.name} • {r.handName}</div>
                </div>
              ))}
            </div>
          )}
          <div className="text-[12px] text-white/40 mt-3">Pot {inr(v.pot)} • {settled.rake > 0 ? `Platform fee ${v.rules.rakePct ?? 0}% (${inr(settled.rake)})` : "No platform fee"}</div>
        </ResultSheet>
      )}

      <Sheet open={rules} onClose={() => setRules(false)} title="Teen Patti rules">
        <div className="text-sm text-[var(--ink-soft)] space-y-3">
          <div>
            <div className="font-semibold text-white mb-1">Hands, strongest first</div>
            <ol className="list-decimal pl-5 space-y-0.5">
              <li><b className="text-white">Trail</b> — three of a kind (AAA best)</li>
              <li><b className="text-white">Pure sequence</b> — three in a row, same suit</li>
              <li><b className="text-white">Sequence</b> — three in a row, mixed suits</li>
              <li><b className="text-white">Color</b> — same suit, not in a row</li>
              <li><b className="text-white">Pair</b> — then the third card decides</li>
              <li><b className="text-white">High card</b></li>
            </ol>
          </div>
          <div>
            <div className="font-semibold text-white mb-1">Sequence order</div>
            <div className="font-mono text-[12px] leading-relaxed">{SEQUENCES.join(" > ")}</div>
            <div className="text-[12px] mt-1">Ace is high only in A-K-Q and low only in A-2-3. K-A-2 is not a sequence.</div>
          </div>
          <div>
            <div className="font-semibold text-white mb-1">Betting</div>
            <div className="text-[12px]">Everyone plays at least 1 blind chaal before seeing; after 3 blind chaals you are seen automatically. Blind: min = stake, double = 2×; after it the stake becomes what you paid. Seen: min = 2× stake, double = 4×; after it the stake becomes half of what you paid. Show with two left (a seen player can&apos;t ask a blind one); equal hands — whoever asked loses. Side show with three or more left: ask the last bettor (both seen), 2× stake; equal hands — whoever asked packs.</div>
          </div>
        </div>
      </Sheet>
    </LandscapeStage>
  );
}
