"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LogOut, Users } from "lucide-react";
import { inr, type Card } from "../../lib/data";
import { useStore } from "../../lib/store";
import { errText, fire, joinOnce, supabase } from "../../lib/supabase";
import { Header, Money, PlayingCard } from "../ui";
import { BotTag, ResultSheet, TimerAvatar } from "./bots";
import type { Nav } from "../nav";

// Teen Patti on the game server (supabase/migrations/002_game_server.sql). The database shuffles, deals, runs
// the 15 s turn clock, plays the bots and moves coins; this screen only renders the table and sends actions.
// Changes arrive through Supabase Realtime (plus a slow poll as a fallback); when a deadline passes, the
// client nudges the server with tp_tick so timeouts, bot moves and the next deal happen.

interface Seat { uid?: string; name: string; emoji: string; bot: boolean; bal: number; playing?: boolean; packed?: boolean; seen?: boolean; action?: string | null; left?: boolean }
interface Result { seat: number; name: string; bot: boolean; uid?: string; amount: number; reason: string; pot: number; reveal: { seat: number; cards: Card[]; hand: string }[] }
interface View {
  id: string; boot: number; status: "waiting" | "playing" | "done"; hand_no: number; pot: number; stake: number; round: number;
  turn: number | null; turn_ends: string | null; next_hand_at: string | null; due_at: string | null; result: Result | null;
  seats: Seat[]; queued: boolean; me: number | null; my_cards: Card[] | null; my_hand: string | null; server_now: string;
  code: string | null; turn_secs: number; pending: { from: number; to: number; ends: string } | null;
  sideshow: { seat: number; cards: Card[]; hand: string; lost: boolean } | null;
}

// Other seats, clockwise from your left, around an oval with you at the bottom.
const SEAT_POS = ["-left-2 top-[50%]", "left-1 top-[6%]", "left-1/2 -translate-x-1/2 -top-6", "right-1 top-[6%]", "-right-2 top-[50%]"];

export function TeenPattiOnline({ nav, buyIn, code }: { nav: Nav; buyIn: number; code?: string }) {
  const { total, showToast, applyBalance } = useStore();
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [sheetFor, setSheetFor] = useState(0); // hand number whose result sheet is open
  const [peek, setPeek] = useState(false);
  const tableId = useRef<string | null>(null);
  const offset = useRef(0); // server clock − local clock
  const ticking = useRef(false);

  const take = useCallback((view: View) => {
    offset.current = new Date(view.server_now).getTime() - Date.now();
    setV(view);
    const mine = view.me !== null ? view.seats[view.me] : null;
    if (mine && !mine.bot) applyBalance(mine.bal);
  }, [applyBalance]);

  const tick = useCallback(async () => {
    if (!tableId.current || ticking.current) return;
    ticking.current = true;
    const { data, error } = await supabase().rpc("tp_tick", { p_table: tableId.current });
    ticking.current = false;
    if (error) setErr(errText(error));
    else take(data as View);
  }, [take]);

  const pull = useCallback(async () => {
    if (!tableId.current) return;
    const { data } = await supabase().rpc("tp_state", { p_table: tableId.current });
    if (data) take(data as View);
  }, [take]);

  // Join (or rejoin) a table, follow it live, and leave when this screen closes.
  useEffect(() => {
    let alive = true;
    const sb = supabase();
    let channel: ReturnType<typeof sb.channel> | null = null;
    (async () => {
      const { data, error } = await joinOnce("tp_join", { p_boot: buyIn, p_code: code ?? null });
      if (!alive) return;
      if (error) return setErr(errText(error));
      tableId.current = data as string;
      channel = sb
        .channel(`tp-${data}`)
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "tp_tables", filter: `id=eq.${data}` }, () => pull())
        .subscribe();
      tick();
    })();
    const heartbeat = setInterval(() => tick(), 12000);
    const poll = setInterval(() => pull(), 3000);
    return () => {
      alive = false;
      clearInterval(heartbeat);
      clearInterval(poll);
      if (channel) sb.removeChannel(channel);
      // Closing the screen (reload, crash, lost connection) does not leave the table: the turn clock covers an
      // absent player and they can come back. Leaving is an explicit action (see leave()).
    };
  }, [buyIn, code, pull, tick]);

  // Clock: redraw timers, and nudge the server once something is due.
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      if (v?.due_at && Date.now() + offset.current >= new Date(v.due_at).getTime() + 150) tick();
    }, 250);
    return () => clearInterval(t);
  }, [v?.due_at, tick]);

  // Show the table's result for a moment before the sheet slides up.
  useEffect(() => {
    if (v?.status !== "done" || !v.result) return;
    const hand = v.hand_no;
    const t = setTimeout(() => { setSheetFor(hand); setPeek(false); }, 2000);
    return () => clearTimeout(t);
  }, [v?.status, v?.hand_no, v?.result]);

  const leave = () => {
    if (tableId.current) fire(supabase().rpc("tp_leave", { p_table: tableId.current }));
    nav.back();
  };

  const act = async (action: "see" | "pack" | "chaal" | "raise" | "show" | "sideshow" | "accept" | "decline") => {
    if (!tableId.current || busy) return;
    setBusy(true);
    const { data, error } = await supabase().rpc("tp_act", { p_table: tableId.current, p_action: action });
    setBusy(false);
    if (error) showToast(errText(error));
    else take(data as View);
  };

  const serverNow = now + offset.current;
  const secsTo = (iso: string | null) => (iso ? Math.max(0, (new Date(iso).getTime() - serverNow) / 1000) : 0);

  if (err && !v) {
    return (
      <div className="min-h-dvh flex flex-col fadein">
        <Header title="Teen Patti" sub={`Boot ${inr(buyIn)}`} onBack={leave} />
        <div className="flex-1 grid place-items-center px-6 text-center">
          <div>
            <div className="text-sm text-white/80">{err}</div>
            {/coins/i.test(err) && <button onClick={() => nav.push({ name: "addcash" })} className="btn-green pill px-6 py-2.5 mt-4 text-sm">Get Coins</button>}
          </div>
        </div>
      </div>
    );
  }

  const me = v?.me ?? null;
  const mySeat = v && me !== null ? v.seats[me] : null;
  const n = v?.seats.length ?? 6;
  const others = v && me !== null ? Array.from({ length: n - 1 }, (_, k) => (me + 1 + k) % n) : v ? v.seats.map((_, i) => i).slice(0, 5) : [];
  const playing = v?.status === "playing";
  const myTurn = playing && v?.turn === me && !!mySeat?.playing && !mySeat.packed;
  const inHand = playing && !!mySeat?.playing && !mySeat.packed;
  const active = v ? v.seats.filter((s) => s.playing && !s.packed).length : 0;
  const chaalAmt = v ? (mySeat?.seen ? v.stake * 2 : v.stake) : 0;
  const reveal = (seat: number) => v?.status === "done" ? v.result?.reveal.find((r) => r.seat === seat) : undefined;
  const humans = v ? v.seats.filter((s) => !s.bot && !s.left).length : 0;
  const res = v?.result ?? null;
  const iWon = !!res && !res.bot && me !== null && res.seat === me;
  const TURN_SECS = v?.turn_secs ?? 15;
  const pending = playing ? v?.pending ?? null : null;
  // Side show is with the previous player still in the hand; both must have seen their cards.
  const prevActive = (() => {
    if (!v || me === null) return null;
    for (let k = 1; k < n; k++) { const p = (me - k + n) % n; const s = v.seats[p]; if (s?.playing && !s.packed) return p; }
    return null;
  })();
  const canSideShow = myTurn && !pending && !!mySeat?.seen && active >= 3 && prevActive !== null && !!v?.seats[prevActive]?.seen;

  return (
    <div className="min-h-dvh flex flex-col pb-5 fadein">
      <Header
        title="Teen Patti"
        sub={`Boot ${inr(v?.boot ?? buyIn)} • ${humans} real player${humans === 1 ? "" : "s"}${v?.hand_no ? ` • Hand #${v.hand_no}` : ""}`}
        onBack={leave}
        right={<div className="flex items-center gap-3"><Money n={total} className="text-sm font-semibold text-neon-400" /><Users size={18} className="text-white/60" /></div>}
      />

      {v?.code && (
        <div className="mx-3 rounded-xl bg-white/5 px-3 py-2 text-sm flex items-center justify-between">
          <span>Private table • code <b className="tracking-widest text-gold-300">{v.code}</b></span>
          <button onClick={() => { navigator.clipboard?.writeText(v.code!); showToast("Code copied"); }} className="text-neon-400">Copy</button>
        </div>
      )}
      <div className="px-3 flex-1 flex flex-col">
        <div className="relative mt-12 mx-4 felt" style={{ height: 350, borderRadius: "170px" }}>
          {v && others.map((si, k) => {
            const b = v.seats[si];
            if (!b) return null;
            const turn = playing && v.turn === si;
            const shown = reveal(si);
            return (
              <div key={si + (b.uid ?? b.name)} className={`absolute ${SEAT_POS[k]} flex flex-col items-center z-10 w-[84px] ${res && res.seat === si && v.status === "done" ? "scale-110 transition-transform" : ""}`}>
                <TimerAvatar emoji={b.emoji} size={40} active={turn} left={turn ? secsTo(v.turn_ends) : 0} dim={b.packed || !b.playing || b.left} total={TURN_SECS} />
                <div className="mt-1 px-2 py-0.5 rounded-lg bg-black/55 text-center max-w-full">
                  <div className="text-[12px] font-medium leading-tight truncate">{b.name}{b.bot && <BotTag />}</div>
                  <div className="text-[12px] text-gold-300 leading-tight">{inr(b.bal)}</div>
                </div>
                {v.status !== "waiting" && b.playing && (
                  <div className="flex -space-x-3 mt-1">
                    {(shown?.cards ?? [0, 1, 2]).map((c, j) => <PlayingCard key={j} card={typeof c === "number" ? undefined : c} faceDown={!shown} size="xs" />)}
                  </div>
                )}
                {b.action && <div className={`mt-1 text-[11px] pill px-1.5 py-0.5 ${b.packed ? "bg-rose-500/30 text-rose-200" : "bg-white/15"}`}>{b.action}</div>}
                {playing && b.playing && !b.packed && !b.action && <div className="mt-1 text-[11px] text-white/60">{b.seen ? "Seen" : "Blind"}</div>}
              </div>
            );
          })}

          <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-16">
            {!v || v.status === "waiting" ? (
              <>
                <div className="text-sm text-white/70">{v?.code ? "Waiting for friends — a private table needs 2 players" : v?.queued || !v ? "Finding a table…" : "Waiting for players…"}</div>
                {v?.next_hand_at && <div className="text-sm font-semibold mt-1">Dealing in {Math.ceil(secsTo(v.next_hand_at))}s</div>}
              </>
            ) : v.status === "done" && res ? (
              <div className="fadein">
                <div className="text-sm font-semibold">{iWon ? "You win!" : `${res.name} wins`}</div>
                <div className="text-[13px] text-gold-300 font-semibold">{inr(res.amount)} • {res.reason}</div>
                <div className="text-[13px] text-white/60 mt-1">Next hand in {Math.ceil(secsTo(v.next_hand_at))}s</div>
              </div>
            ) : (
              <>
                <div className="text-sm font-semibold">Round {v.round}</div>
                <div className="text-[13px] text-gold-300 font-semibold">Pot {inr(v.pot)}</div>
                {pending && <div className="text-[13px] text-fuchsia-300 mt-1">{pending.from === me ? "You" : v.seats[pending.from]?.name} asked {pending.to === me ? "you" : v.seats[pending.to]?.name} for a side show</div>}
                <div className="text-lg font-bold mt-0.5">
                  {pending ? <span className="text-sm font-normal text-white/70">{Math.ceil(secsTo(pending.ends))}s</span> : myTurn ? `${Math.ceil(secsTo(v.turn_ends))}s` : v.turn !== null && <span className="text-sm font-normal text-white/70">{v.seats[v.turn]?.name}&apos;s turn • {Math.ceil(secsTo(v.turn_ends))}s</span>}
                </div>
              </>
            )}
          </div>

          {/* You */}
          <div className="absolute left-1/2 -translate-x-1/2 -bottom-7 flex flex-col items-center z-10">
            <TimerAvatar emoji={mySeat?.emoji} size={48} active={!!myTurn} left={myTurn ? secsTo(v!.turn_ends) : 0} dim={!!mySeat?.packed} total={TURN_SECS} />
            <div className="mt-1 px-2 py-0.5 rounded-lg bg-black/55 text-center">
              <div className="text-[12px] font-medium leading-tight">
                You {playing && mySeat?.playing && (mySeat.packed ? <span className="text-rose-300">• Packed</span> : <span className="text-white/60">• {mySeat.seen ? "Seen" : "Blind"}</span>)}
              </div>
              <div className="text-[12px] text-gold-300 leading-tight">{inr(total)}</div>
            </div>
          </div>
        </div>

        {/* My hand */}
        <div className="mt-14 flex flex-col items-center min-h-[120px]">
          {v?.queued ? (
            <div className="text-sm text-white/60 mt-6">You&apos;ll be dealt in from the next hand</div>
          ) : mySeat && !mySeat.playing && v?.status !== "waiting" ? (
            <div className="text-center mt-4">
              <div className="text-sm text-white/70">{mySeat.action ?? "Sitting out"} — you need {inr(v?.boot ?? buyIn)} for the boot</div>
              <button onClick={() => nav.push({ name: "addcash" })} className="btn-green pill px-6 py-2.5 mt-2 text-sm">Get Coins</button>
            </div>
          ) : mySeat?.playing && v?.status !== "waiting" ? (
            <>
              <div className="flex -space-x-3">
                {(v?.my_cards ?? [undefined, undefined, undefined]).map((c, i) => (
                  <PlayingCard key={i} card={c} faceDown={!c} size="lg" className={`${c ? "flip" : ""} ${mySeat.packed ? "opacity-50" : ""}`} style={{ transform: `rotate(${(i - 1) * 8}deg) translateY(${Math.abs(i - 1) * 5}px)` }} />
                ))}
              </div>
              <div className="mt-2 text-sm text-white/70">{v?.my_hand ? <>Your hand: <b className="text-gold-300">{v.my_hand}</b></> : mySeat.packed ? "Packed without looking" : "Playing blind — tap See to look"}</div>
            </>
          ) : null}
        </div>

        {pending && pending.to === me && (
          <div className="mt-2 rounded-2xl bg-fuchsia-600/20 border border-fuchsia-400/30 p-3 text-center">
            <div className="text-sm"><b>{v!.seats[pending.from]?.name}</b> wants a side show — compare cards privately; the lower hand packs.</div>
            <div className="grid grid-cols-2 gap-2 mt-3">
              <button disabled={busy} onClick={() => act("decline")} className="btn-ghost rounded-full py-2.5 text-sm">Decline</button>
              <button disabled={busy} onClick={() => act("accept")} className="rounded-full py-2.5 text-sm font-semibold bg-fuchsia-600">Accept • {Math.ceil(secsTo(pending.ends))}s</button>
            </div>
          </div>
        )}
        {v?.sideshow && playing && (
          <div className="mt-2 rounded-2xl bg-white/5 p-3 flex items-center gap-3">
            <div className="flex -space-x-3">{v.sideshow.cards.map((c, i) => <PlayingCard key={i} card={c} size="xs" />)}</div>
            <div className="text-sm">Side show vs <b>{v.seats[v.sideshow.seat]?.name}</b> ({v.sideshow.hand}) — you {v.sideshow.lost ? <span className="text-rose-300">lost</span> : <span className="text-neon-400">won</span>}</div>
          </div>
        )}
        {inHand && mySeat?.packed === false && (
          <div className="mt-auto pt-3 space-y-2">
            <div className="grid grid-cols-3 gap-2">
              <button disabled={!myTurn || !!pending || busy} onClick={() => act("pack")} className="rounded-full py-3 text-sm font-bold tracking-wide bg-[#1b2350] border border-white/10 disabled:opacity-40">PACK</button>
              <button disabled={mySeat.seen || busy} onClick={() => act("see")} className="rounded-full py-3 text-sm font-bold tracking-wide bg-sky-500 disabled:opacity-40">{mySeat.seen ? "SEEN ✓" : "SEE"}</button>
              <button disabled={!myTurn || !!pending || busy || active !== 2} onClick={() => act("show")} className="rounded-full py-3 text-sm font-bold tracking-wide bg-gold-500 text-slate-900 disabled:opacity-40">SHOW</button>
            </div>
            <div className="grid grid-cols-[1fr_1fr_2fr] gap-2">
              <button disabled={!canSideShow || busy} onClick={() => act("sideshow")} className="rounded-full py-3 text-[13px] font-bold tracking-wide bg-fuchsia-600 disabled:opacity-40">SIDE SHOW</button>
              <button disabled={!myTurn || !!pending || busy} onClick={() => act("raise")} className="rounded-full py-3 text-[13px] font-bold tracking-wide bg-[#2a3470] disabled:opacity-40">RAISE {inr(chaalAmt * 2)}</button>
              <button disabled={!myTurn || !!pending || busy} onClick={() => act("chaal")} className="btn-green rounded-full py-3 text-sm font-bold tracking-wide">{mySeat.seen ? "CHAAL" : "BLIND"} {inr(chaalAmt)}</button>
            </div>
            {myTurn && !pending && (
              <div className="text-center text-[12px] text-white/40">
                {active !== 2 ? "Show unlocks when two players are left" : ""}{active >= 3 && !canSideShow ? " • Side show needs you and the previous player to be Seen" : ""}
              </div>
            )}
          </div>
        )}
        {playing && mySeat?.packed && <div className="text-center text-sm text-white/60 mt-auto">You packed — waiting for this hand to finish</div>}
        <div className="text-center text-[12px] text-white/35 mt-2">Cards are dealt by the server. If you disconnect, your turn times out after {TURN_SECS}s and your hand is packed.</div>
        <button onClick={leave} className="mx-auto mt-2 text-[13px] text-white/50 flex items-center gap-1"><LogOut size={12} /> Leave table</button>
      </div>

      {res && v && (
        <ResultSheet
          open={v.status === "done" && sheetFor === v.hand_no && !peek}
          won={iWon}
          title={iWon ? `You won ${inr(res.amount)}!` : `${res.name} wins`}
          sub={mySeat?.packed && !iWon ? `${res.reason} • you packed` : res.reason}
          left={Math.ceil(secsTo(v.next_hand_at))}
          nextLabel="Next hand starts in"
          onLeave={leave}
          onClose={() => setPeek(true)}
        >
          {res.reveal.length > 0 && (
            <div className="flex justify-center gap-6 mt-4 flex-wrap">
              {res.reveal.map((r) => (
                <div key={r.seat} className="flex flex-col items-center gap-1">
                  <div className="flex -space-x-2">{r.cards.map((c, i) => <PlayingCard key={i} card={c} size="sm" />)}</div>
                  <div className="text-[12px] text-white/60">{r.seat === me ? "You" : v.seats[r.seat]?.name} • {r.hand}</div>
                </div>
              ))}
            </div>
          )}
          <div className="text-[12px] text-white/40 mt-3">Pot {inr(res.pot)} • Platform fee 5%</div>
        </ResultSheet>
      )}
    </div>
  );
}
