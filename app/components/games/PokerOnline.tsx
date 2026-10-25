"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, ChevronLeft, LogOut } from "lucide-react";
import { inr, type Card as UiCard } from "../../lib/data";
import { useStore } from "../../lib/store";
import { supabase } from "../../lib/supabase";
import { clearActive } from "../../lib/rejoin";
import { dealSound, sfx, useSoundOnRise } from "../../lib/sound";
import { HomeButton, Money, PlayingCard, Sheet } from "../ui";
import { BotTag, ResultSheet, TimerAvatar } from "./bots";
import type { Nav } from "../nav";
import type { PokerTableResponse } from "../../lib/server/poker";
import { STAGE_NAMES, type ActionType } from "../../lib/poker/engine";
import type { Card } from "../../lib/poker/evaluator";

// Online Texas Hold'em. The server deals, keeps the clocks, plays the bots (public tables) and settles; this screen
// polls /api/poker/state every second and sends actions with an id so a retry can never act twice. Private tables
// are friends-only: share the 6-character code from the top bar. Back keeps your seat for a minute; Leave gives
// it up (folding you if a hand is on).

const SUIT: Record<Card["s"], UiCard["s"]> = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RANK: Record<number, UiCard["r"]> = { 14: "A", 13: "K", 12: "Q", 11: "J" };
const ui = (c: Card): UiCard => ({ r: RANK[c.r] ?? (String(c.r) as UiCard["r"]), s: SUIT[c.s] });

// Other seats on the rim of the tall oval; you sit at the foot. Play moves anti-clockwise on screen: the player who
// acts after you is on your right, then the top seats from right to left, and the one before you on your left.
// `bet` places a player's chips on the felt side of their seat.
const SEATS: { style: React.CSSProperties; bet: string }[] = [
  { style: { left: "0%", top: "56%" }, bet: "left-full top-4 ml-0.5" },
  { style: { left: "0%", top: "21%" }, bet: "left-full top-4 ml-0.5" },
  { style: { left: "50%", top: "-1%", transform: "translateX(-50%)" }, bet: "top-full left-1/2 -translate-x-1/2 mt-1" },
  { style: { right: "0%", top: "21%" }, bet: "right-full top-4 mr-0.5" },
  { style: { right: "0%", top: "56%" }, bet: "right-full top-4 mr-0.5" },
];

/** A small red chip, for bets and the pot. */
function PokerChip() {
  return <span className="inline-block w-3.5 h-3.5 rounded-full bg-[#e11d48] border-[2px] border-dashed border-white/80 shadow" />;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const { data } = await supabase().auth.getSession();
  const r = await fetch(path, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token ?? ""}`, ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 409) throw new Error(j.error ?? "Something went wrong");
  return j as T;
}

export function PokerOnline({ nav, buyIn, code }: { nav: Nav; buyIn: number; code?: string }) {
  const { total, showToast, applyBalance } = useStore();
  const [resp, setResp] = useState<PokerTableResponse | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [rules, setRules] = useState(false);
  const [raising, setRaising] = useState(false);
  const [raiseAmt, setRaiseAmt] = useState(0);
  const [peek, setPeek] = useState(false); // result sheet closed to look at the table
  const [sheetHand, setSheetHand] = useState(0);
  const tableId = useRef<string | null>(null);
  const offset = useRef(0); // server clock − local clock
  const polling = useRef(false);

  const take = useCallback((r: PokerTableResponse) => {
    offset.current = r.table.serverNow - Date.now();
    setResp(r);
    applyBalance(r.balance);
  }, [applyBalance]);

  // Sit down, then follow the table.
  useEffect(() => {
    let alive = true;
    api<PokerTableResponse>("/api/poker/join", { method: "POST", body: JSON.stringify(code ? { code } : { boot: buyIn }) })
      .then((r) => { if (!alive) return; tableId.current = r.table.id; take(r); })
      .catch((e) => alive && setErr(e.message));
    const poll = async () => {
      if (!tableId.current || polling.current) return;
      polling.current = true;
      try { take(await api<PokerTableResponse>(`/api/poker/state?table=${tableId.current}`)); } catch (e) { if (alive) setErr((e as Error).message); }
      polling.current = false;
    };
    const t = setInterval(poll, 1000);
    const clock = setInterval(() => setNow(Date.now()), 250);
    return () => { alive = false; clearInterval(t); clearInterval(clock); };
  }, [buyIn, code, take]);

  const v = resp?.view ?? null;
  const tbl = resp?.table ?? null;
  useSoundOnRise(tbl?.handNo ?? 0, () => dealSound(8, 90));
  useSoundOnRise(v?.phase === "PLAYING" ? v.stage : 0, () => dealSound(v?.stage === 1 ? 3 : 1));
  useSoundOnRise(v?.pot ?? 0, sfx.chip);
  useEffect(() => { if (v?.phase === "COMPLETED" && tbl && sheetHand !== tbl.handNo) { setSheetHand(tbl.handNo); setPeek(false); } }, [v?.phase, tbl, sheetHand]);
  useEffect(() => { if (!v || v.turnId !== v.me?.playerId) setRaising(false); }, [v]);

  const serverNow = now + offset.current;
  const secsTo = (ms: number | null) => (ms ? Math.max(0, (ms - serverNow) / 1000) : 0);

  const act = async (type: ActionType, to?: number) => {
    if (!tableId.current || !v || busy) return;
    setBusy(true);
    setRaising(false);
    try {
      const r = await api<{ ok: boolean; message?: string; state: PokerTableResponse }>("/api/poker/act", {
        method: "POST",
        body: JSON.stringify({ table: tableId.current, actionId: crypto.randomUUID(), handId: v.handId, expectedVersion: v.version, type, to }),
      });
      if (r.state) take(r.state);
      if (!r.ok && r.message) showToast(r.message);
    } catch (e) {
      showToast((e as Error).message);
    }
    setBusy(false);
  };

  const leave = async () => {
    if (tableId.current) await api("/api/poker/leave", { method: "POST", body: JSON.stringify({ table: tableId.current }) }).catch(() => {});
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
  const unseated = (v?.players ?? []).filter((p) => !seats.some((s) => s.playerId === p.playerId)).map((p) => ({ seat: p.seat, playerId: p.playerId, name: p.name, emoji: "🤖", bot: p.bot, bal: null, away: false }));
  const others = [...seats, ...unseated].filter((s) => s.playerId !== myId).sort((a, b) => ((a.seat - mySeatNo + 6) % 6) - ((b.seat - mySeatNo + 6) % 6)).slice(0, 5);
  const inHand = (id: string) => v?.players.find((p) => p.playerId === id) ?? null;
  const liveHand = v?.phase === "PLAYING";
  const turnSecs = (tbl?.rules.turnTimeoutMs ?? 15000) / 1000;
  const lastAction = (id: string) => {
    const e = [...(v?.events ?? [])].reverse().find((x) => x.playerId === id && ["CHECK", "CALL", "RAISE", "FOLD", "TIMEOUT", "LEFT"].includes(x.type));
    if (!e) return null;
    // Actions from an earlier street are stale once a new card is out.
    const lastDeal = [...(v?.events ?? [])].reverse().find((x) => x.type === "DEAL");
    if (lastDeal && e.seq < lastDeal.seq && !["FOLD", "TIMEOUT", "LEFT"].includes(e.type)) return null;
    switch (e.type) {
      case "CHECK": return "Check";
      case "CALL": return e.note === "All in" ? `All in ${inr(e.amount ?? 0)}` : `Call ${inr(e.amount ?? 0)}`;
      case "RAISE": return e.note === "All in" ? `All in ${inr(e.amount ?? 0)}` : `Raise ${inr(e.amount ?? 0)}`;
      case "FOLD": return "Folded";
      case "TIMEOUT": return e.note === "Checked" ? "Check" : "Timed out";
      case "LEFT": return "Left";
    }
    return null;
  };
  const settled = v?.settlement ?? null;
  const iWon = !!settled && settled.winners.some((w) => w.playerId === myId);
  const myWin = settled?.winners.find((w) => w.playerId === myId)?.amount ?? 0;
  const nameOf = (id: string) => (id === myId ? "You" : seats.find((s) => s.playerId === id)?.name ?? inHand(id)?.name ?? "Player");
  const winnerNames = settled ? settled.winners.map((w) => nameOf(w.playerId)) : [];
  const meInHand = myId ? inHand(myId) : null;
  const myCards = me?.cards ?? null;
  const stageName = v ? STAGE_NAMES[Math.min(4, v.stage)] : "";
  const winHand = settled?.reason === "SHOWDOWN" ? settled.reveal.find((r) => r.playerId === settled.winners[0]?.playerId)?.handName : null;
  const Btn = ({ opt, label, amount, className, onClick }: { opt: { ok: boolean; reason: string | null }; label: string; amount?: number; className: string; onClick: () => void }) => (
    <button
      disabled={busy}
      title={opt.reason ?? undefined}
      onClick={() => (opt.ok ? onClick() : opt.reason && showToast(opt.reason))}
      className={`rounded-lg px-4 py-1.5 text-[12px] font-bold border leading-tight transition ${className} ${opt.ok ? "" : "opacity-40"}`}
    >
      {label}{amount !== undefined && amount > 0 && <><br /><span className="text-[13px]">{inr(amount)}</span></>}
    </button>
  );
  const raiseStep = Math.max(1, tbl?.boot ?? 1);
  const openRaise = () => {
    if (!me?.raise.ok) return me?.raise.reason && showToast(me.raise.reason);
    setRaiseAmt(me.raise.min);
    setRaising((r) => !r);
  };

  return (
    <div className="fixed inset-0 z-40 overflow-hidden pk-room">
      <div className="relative mx-auto w-full max-w-[480px] h-full flex flex-col select-none">
        {/* Top bar */}
        <div className="h-11 shrink-0 flex items-center gap-2 px-3">
          <button onClick={away} aria-label="Back to lobby (seat kept)" className="w-8 h-8 grid place-items-center rounded-full bg-white/10 active:scale-95"><ChevronLeft size={18} /></button>
          <HomeButton className="w-8 h-8 grid place-items-center rounded-full bg-white/10 active:scale-95" />
          <div className="leading-tight">
            <div className="text-sm font-semibold">Poker</div>
            <div className="text-[11px] text-white/60">Boot {inr(tbl?.boot ?? buyIn)}{tbl?.handNo ? ` • Hand #${tbl.handNo}` : ""}</div>
          </div>
          {tbl?.code && (
            <button onClick={() => { navigator.clipboard?.writeText(tbl.code!); showToast("Code copied"); }} className="ml-2 pill bg-white/10 px-2.5 py-1 text-[11px]">
              <b className="tracking-widest text-gold-300">{tbl.code}</b> • Copy
            </button>
          )}
          <div className="ml-auto flex items-center gap-3">
            <button onClick={() => setRules(true)} className="text-[12px] text-white/60 flex items-center gap-1"><BookOpen size={13} /> Rules</button>
            <Money n={total} className="text-sm font-semibold text-neon-400" />
            <button onClick={leave} className="text-[12px] text-white/60 flex items-center gap-1"><LogOut size={13} /> Leave</button>
          </div>
        </div>

        {/* Table: a tall oval, seats on its rim, you at the foot */}
        <div className="relative flex-1 min-h-0">
          <div className="absolute left-[11%] right-[11%] top-[6%] bottom-[13%] pk-felt">
            <div className="absolute inset-x-0 top-[47%] text-center text-[15px] font-black tracking-[0.4em] text-white/10">HOLD&apos;EM</div>
          </div>

          {/* Board, pot and status */}
          <div className="absolute left-1/2 top-[40%] -translate-x-1/2 -translate-y-1/2 flex flex-col items-center text-center z-10 w-[70%]">
            {!resp ? (
              <div className="text-[13px] text-white/80">Finding a table…</div>
            ) : !liveHand ? (
              <div className="fadein">
                {settled && settled.reason !== "VOID" && (
                  <>
                    {settled.reason === "SHOWDOWN" && v!.board.length > 0 && (
                      <div className="flex -space-x-1 mb-1.5 justify-center">
                        {v!.board.map((c, i) => <PlayingCard key={i} card={ui(c)} size="sm" className="shadow-md" />)}
                      </div>
                    )}
                    <div className="text-base font-semibold">{iWon ? "You win!" : `${winnerNames.join(" & ")} ${winnerNames.length > 1 ? "split the pot" : "wins"}`}</div>
                    <div className="text-[13px] text-gold-300 font-semibold">{inr(iWon ? myWin : settled.winners[0]?.amount ?? 0)} • {winHand ?? "Everyone else folded"}</div>
                  </>
                )}
                {settled?.reason === "VOID" && <div className="text-[13px] text-white/80">Hand voided — everyone refunded</div>}
                <div className="text-[12px] text-white/60 mt-0.5">
                  {tbl!.waiting ? (tbl!.code ? "Waiting for friends — share the code" : "Waiting for players…") : tbl!.nextHandAt ? `Dealing in ${Math.ceil(secsTo(tbl!.nextHandAt))}s` : "Dealing…"}
                </div>
              </div>
            ) : (
              <>
                <div className="pill bg-black/55 px-3 py-1 text-[13px] text-gold-300 font-bold flex items-center gap-1.5 mb-2"><PokerChip /> Pot {inr(v!.pot)}</div>
                <div className="flex -space-x-1 h-[52px] items-center">
                  {[0, 1, 2, 3, 4].map((i) => {
                    const c = v!.board[i];
                    return <PlayingCard key={i} card={c ? ui(c) : undefined} faceDown={!c} size="sm" className={`shadow-md ${c ? "flip" : "opacity-30"}`} />;
                  })}
                </div>
                <div className="text-[11px] text-white/60 mt-1">{stageName}{v!.betLevel > 0 ? ` • Bet ${inr(v!.betLevel)}` : ""}</div>
                {v!.turnId && (
                  <div className={`text-[12px] mt-0.5 ${v!.turnId === myId ? "text-neon-400 font-bold" : "text-white/75"}`}>
                    {v!.turnId === myId ? "Your turn" : `${nameOf(v!.turnId)}'s turn`} • {Math.ceil(secsTo(v!.turnDeadline))}s
                  </div>
                )}
              </>
            )}
          </div>

          {/* Other players, on the rim */}
          {others.map((s, k) => {
            const p = inHand(s.playerId);
            const seat = SEATS[4 - k] ?? SEATS[4];
            const turn = liveHand && v!.turnId === s.playerId;
            const won = !!settled && settled.winners.some((w) => w.playerId === s.playerId);
            const tagText = p ? lastAction(s.playerId) : null;
            const folded = p?.status === "FOLDED";
            return (
              <div key={s.playerId} className={`absolute z-10 w-[92px] flex flex-col items-center ${won ? "drop-shadow-[0_0_14px_rgba(253,224,71,.8)]" : ""}`} style={seat.style}>
                <div className="relative">
                  <TimerAvatar emoji={s.emoji} size={46} active={turn} left={turn ? secsTo(v!.turnDeadline) : 0} dim={!p || folded || s.away} total={turnSecs} dealer={p?.isDealer} />
                  {p && !folded && (
                    <div className="absolute -right-5 top-0 flex -space-x-2.5 pointer-events-none">
                      {(p.cards ?? [0, 1]).map((c, j) => (
                        <PlayingCard key={j} card={typeof c === "number" ? undefined : ui(c)} faceDown={!p.cards} size="xs" className="shadow" style={{ transform: `rotate(${(j - 0.5) * 12}deg)` }} />
                      ))}
                    </div>
                  )}
                  {(p?.handName || tagText || (p?.allIn && !folded)) && (
                    <div className={`absolute left-1/2 -translate-x-1/2 -bottom-1.5 z-10 text-[9px] font-semibold pill px-1.5 py-px whitespace-nowrap ${p?.handName ? "bg-gold-300 text-slate-900" : folded ? "bg-rose-600 text-white" : p?.allIn ? "bg-orange-500 text-white" : "bg-sky-500 text-white"}`}>
                      {p?.handName ?? (p?.allIn && !folded ? "ALL IN" : tagText)}
                    </div>
                  )}
                </div>
                <div className="mt-1 w-full rounded-lg bg-black/85 border border-white/10 text-center px-1.5 py-0.5">
                  <div className="text-[11px] font-medium leading-tight truncate">{s.name}{s.bot && <BotTag />}</div>
                  <div className="text-[11px] text-gold-300 font-semibold leading-tight">{s.bot ? inr(s.bal ?? 0) : p ? `In ${inr(p.contributed)}` : s.away ? "Away" : "Waiting"}</div>
                </div>
                {liveHand && p && p.bet > 0 && (
                  <div className={`absolute flex items-center gap-1 pill bg-black/55 pl-1 pr-2 py-0.5 text-[11px] text-white/90 whitespace-nowrap ${seat.bet}`}>
                    <PokerChip /> {inr(p.bet)}
                  </div>
                )}
              </div>
            );
          })}

          {/* You */}
          <div className="absolute left-1/2 bottom-0 -translate-x-1/2 flex items-end gap-3 z-20">
            <div className="flex flex-col items-center">
              <div className="relative">
                <TimerAvatar emoji={seats.find((s) => s.playerId === myId)?.emoji} size={52} active={!!liveHand && v!.turnId === myId} left={liveHand && v!.turnId === myId ? secsTo(v!.turnDeadline) : 0} dim={meInHand?.status === "FOLDED"} total={turnSecs} dealer={meInHand?.isDealer} />
                {liveHand && meInHand && meInHand.bet > 0 && (
                  <div className="absolute left-1/2 -translate-x-1/2 -top-7 flex items-center gap-1 pill bg-black/55 pl-1 pr-2 py-0.5 text-[11px] text-white/90 whitespace-nowrap"><PokerChip /> {inr(meInHand.bet)}</div>
                )}
              </div>
              <div className="mt-1 min-w-[92px] rounded-lg bg-black/85 border border-white/10 text-center px-2 py-0.5">
                <div className="text-[11px] font-medium leading-tight">You{meInHand && liveHand && meInHand.status === "FOLDED" && <span className="text-rose-300"> • Folded</span>}</div>
                <div className="text-[11px] text-gold-300 font-semibold leading-tight">{inr(total)}</div>
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
              <div className="flex flex-col items-center mb-1">
                <div className="flex -space-x-3">
                  {(myCards ?? [undefined, undefined]).map((c, i) => (
                    <PlayingCard key={i} card={c ? ui(c) : undefined} faceDown={!c} size="md" className={`${c ? "flip" : ""} ${meInHand.status === "FOLDED" ? "opacity-50" : ""}`} style={{ transform: `rotate(${(i - 0.5) * 8}deg)` }} />
                  ))}
                </div>
                {me?.handName && <div className="mt-1 text-[11px] pill px-2 py-px bg-gold-300/20 text-gold-200 whitespace-nowrap">{me.handName}</div>}
              </div>
            ) : null}
          </div>

          {/* Raise picker */}
          {raising && me?.raise.ok && (
            <div className="absolute inset-x-3 bottom-2 z-30 rounded-2xl bg-[#101743]/95 border border-neon-400/40 p-3 shadow-xl">
              <div className="flex items-center justify-between text-xs">
                <span className="text-white/60">Raise to</span>
                <b className="text-gold-300 text-base">{inr(raiseAmt)}</b>
              </div>
              <input type="range" min={me.raise.min} max={me.raise.max} step={raiseStep} value={raiseAmt} onChange={(e) => setRaiseAmt(Number(e.target.value))} className="w-full mt-2 accent-[#4ade80]" />
              <div className="grid grid-cols-4 gap-1.5 mt-2">
                {([["Min", me.raise.min], ["2×", me.raise.min * 2], ["Pot", Math.max(me.raise.min, v!.pot)], ["All in", me.raise.max]] as const).map(([l, val]) => (
                  <button key={l} onClick={() => setRaiseAmt(Math.max(me.raise.min, Math.min(me.raise.max, val)))} className="pill bg-white/10 py-1.5 text-[11px]">{l}</button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2.5">
                <button onClick={() => setRaising(false)} className="btn-ghost rounded-full py-2 text-[13px]">Cancel</button>
                <button disabled={busy} onClick={() => act("RAISE", Math.max(me.raise.min, Math.min(me.raise.max, raiseAmt)))} className="btn-green rounded-full py-2 text-[13px]">Raise {inr(raiseAmt)}</button>
              </div>
            </div>
          )}
        </div>

        {/* Action bar */}
        <div className="shrink-0 px-3 pt-2 pb-3 bg-black/45 border-t border-white/10" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
          {me?.inHand && meInHand?.status === "ACTIVE" && liveHand ? (
            <>
              <div className="text-center text-[11px] text-white/50 mb-1.5">{me.toCall > 0 ? (me.call.allIn ? `${inr(me.toCall)} to call — you have ${inr(me.call.amount)}: all in or fold` : `${inr(me.toCall)} to call`) : "Nothing to call"}</div>
              <div className="grid grid-cols-3 gap-2">
                <Btn opt={me.fold} label="Fold" className="bg-[#8b1d2c] border-white/15 py-3 text-sm" onClick={() => act("FOLD")} />
                {me.toCall > 0
                  ? <Btn opt={me.call} label={me.call.allIn ? "All in" : "Call"} amount={me.call.amount} className={`${me.call.allIn ? "bg-orange-600 border-orange-300/40" : "bg-sky-600 border-sky-300/30"} py-2 text-sm`} onClick={() => act("CALL")} />
                  : <Btn opt={me.check} label="Check" className="bg-sky-600 border-sky-300/30 py-3 text-sm" onClick={() => act("CHECK")} />}
                {me.raise.allIn
                  ? <Btn opt={me.raise} label="All in" amount={me.raise.max} className="bg-orange-600 border-orange-300/40 py-2 text-sm" onClick={() => act("RAISE", me.raise.max)} />
                  : <Btn opt={me.raise} label={raising ? "Close" : "Raise"} className="bg-[#3d7a1f] border-lime-300/30 py-3 text-sm" onClick={openRaise} />}
              </div>
            </>
          ) : (
            <div className="h-12 flex items-center justify-center text-center text-[13px] text-white/60">
              {liveHand && meInHand?.status === "FOLDED" ? "You folded — waiting for this hand to finish" : `Cards are dealt by the server • ${turnSecs}s per turn`}
            </div>
          )}
        </div>
      </div>

      {settled && v && tbl && settled.reason !== "VOID" && (
        <ResultSheet
          open={sheetHand === tbl.handNo && !peek}
          won={iWon}
          title={iWon ? `You won ${inr(myWin)}!` : `${winnerNames.join(" & ")} ${winnerNames.length > 1 ? "split the pot" : "wins"}`}
          sub={winHand ? `${winHand}${meInHand?.status === "FOLDED" ? " • you folded" : ""}` : "Everyone else folded"}
          left={Math.ceil(secsTo(tbl.nextHandAt))}
          nextLabel="Next hand starts in"
          onLeave={leave}
          onClose={() => setPeek(true)}
        >
          {settled.reason === "SHOWDOWN" && (
            <div className="flex justify-center -space-x-1 mt-3">{v.board.map((c, i) => <PlayingCard key={i} card={ui(c)} size="sm" />)}</div>
          )}
          {settled.reveal.length > 0 && (
            <div className="flex justify-center gap-6 mt-3 flex-wrap">
              {settled.reveal.map((r) => (
                <div key={r.playerId} className="flex flex-col items-center gap-1">
                  <div className="flex -space-x-2">{r.cards.map((c, i) => <PlayingCard key={i} card={ui(c)} size="sm" />)}</div>
                  <div className="text-[12px] text-white/60">{nameOf(r.playerId)} • {r.handName}</div>
                </div>
              ))}
            </div>
          )}
          {settled.returned && settled.returned.length > 0 && (
            <div className="text-[12px] text-white/60 mt-3">{settled.returned.map((r) => `${inr(r.amount)} back to ${nameOf(r.playerId)} (not matched)`).join(" • ")}</div>
          )}
          <div className="text-[12px] text-white/40 mt-3">Pot {inr(v.pot)} • Platform fee {v.rules.rakePct}%</div>
        </ResultSheet>
      )}

      <Sheet open={rules} onClose={() => setRules(false)} title="Poker rules (Texas Hold'em)">
        <div className="text-sm text-[var(--ink-soft)] space-y-3">
          <div>
            <div className="font-semibold text-white mb-1">Hands, strongest first</div>
            <ol className="list-decimal pl-5 space-y-0.5">
              <li><b className="text-white">Royal flush</b> — A K Q J 10, same suit</li>
              <li><b className="text-white">Straight flush</b> — five in a row, same suit</li>
              <li><b className="text-white">Four of a kind</b></li>
              <li><b className="text-white">Full house</b> — three of a kind + a pair</li>
              <li><b className="text-white">Flush</b> — five of one suit</li>
              <li><b className="text-white">Straight</b> — five in a row (A-2-3-4-5 is the lowest)</li>
              <li><b className="text-white">Three of a kind</b>, <b className="text-white">two pair</b>, <b className="text-white">pair</b>, <b className="text-white">high card</b></li>
            </ol>
          </div>
          <div>
            <div className="font-semibold text-white mb-1">Play</div>
            <div className="text-[12px]">Everyone puts in the boot and gets two cards. Betting goes round after the deal, after the flop (3 board cards), the turn (4th) and the river (5th), starting from the seat after the dealer. On your turn: check (nothing to call), call, raise (to at least double the bet, at most 100× the boot and what you hold) or fold. A player who can&apos;t cover a call can go all in for what they have: they are then in for a share of the pot up to what they matched, and any bet nobody could match goes back to whoever made it. At the showdown the best five cards out of your two and the five on the board win; equal hands split the pot. Out of time: fold if there is something to call, otherwise check.</div>
          </div>
          <div>
            <div className="font-semibold text-white mb-1">Private tables</div>
            <div className="text-[12px]">Friends only, no computer players. Share the 6-character code from the top bar; a hand starts once at least two of you are in.</div>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
