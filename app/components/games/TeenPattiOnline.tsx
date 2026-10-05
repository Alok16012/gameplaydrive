"use client";

import { clearActive } from "../../lib/rejoin";
import { dealSound, sfx, useSoundOnRise } from "../../lib/sound";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, LogOut, Users } from "lucide-react";
import { inr, type Card } from "../../lib/data";
import { useStore } from "../../lib/store";
import { gameSocket, type ServerMsg } from "../../lib/gameServer";
import { Header, Money, PlayingCard } from "../ui";
import { LandscapeStage } from "./LandscapeStage";
import { BotTag, ResultSheet, TimerAvatar } from "./bots";
import type { Nav } from "../nav";

// Teen Patti on the realtime game server (server/src/teenpatti.ts, deployed on Railway). The table lives in the
// server's memory with its own timers, so a bot's move, a timeout or another player's action reaches this
// screen the instant it happens — the server pushes the new view over WebSocket, there is no polling.

interface Seat { uid?: string; name: string; emoji: string; bot: boolean; bal: number; playing?: boolean; packed?: boolean; seen?: boolean; action?: string | null; left?: boolean; blinds?: number; blinds_hand?: number }
interface Result { seat: number; name: string; bot: boolean; uid?: string; amount: number; reason: string; pot: number; reveal: { seat: number; cards: Card[]; hand: string }[] }
interface View {
  id: string; boot: number; status: "waiting" | "playing" | "done"; hand_no: number; pot: number; stake: number; round: number;
  turn: number | null; turn_ends: string | null; next_hand_at: string | null; due_at: string | null; result: Result | null;
  seats: Seat[]; queued: boolean; me: number | null; my_cards: Card[] | null; my_hand: string | null; server_now: string;
  code: string | null; turn_secs: number; pending: { from: number; to: number; ends: string } | null;
  sideshow: { seat: number; cards: Card[]; hand: string; lost: boolean } | null;
  blind_limit?: number;
}

// Landscape table: the other five seats clockwise from your left around the oval, as % of the table area
// (seat centres). You sit at the bottom centre. Coins fly between these points and the pot.
const SEAT_XY: [number, number][] = [[7, 52], [20, 13], [50, 11], [80, 13], [93, 52]];
const ME_XY: [number, number] = [44, 88];
const POT_XY: [number, number] = [50, 36];
// Where each seat box sits: edge seats are pinned to the screen edge with their cards facing into the table.
const SEAT_BOX: { style: React.CSSProperties; reverse?: boolean }[] = [
  { style: { left: "1%", top: "52%", transform: "translateY(-50%)" } },
  { style: { left: "13%", top: "2%" } },
  { style: { left: "50%", top: "2%", transform: "translateX(-50%)" } },
  { style: { right: "13%", top: "2%" }, reverse: true },
  { style: { right: "1%", top: "52%", transform: "translateY(-50%)" }, reverse: true },
];

interface Fly { id: number; from: [number, number]; to: [number, number]; amt: number }

/** Neat stack of coins that grows a little as the pot grows. */
function PotStack({ pot, boot }: { pot: number; boot: number }) {
  const n = Math.max(1, Math.min(7, Math.ceil(Math.log2(Math.max(1, pot / Math.max(1, boot))))));
  return (
    <div className="relative mx-auto mb-1" style={{ width: 30, height: 14 + n * 4 }}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="coin absolute left-0" style={{ width: 30, height: 12, bottom: i * 4, borderRadius: "50%" }} />
      ))}
    </div>
  );
}

export function TeenPattiOnline({ nav, buyIn, code }: { nav: Nav; buyIn: number; code?: string }) {
  const { total, showToast, applyBalance } = useStore();
  const [v, setV] = useState<View | null>(null);
  // Sounds: cards dealt for each new hand, chips into the pot.
  useSoundOnRise(v?.hand_no ?? 0, () => dealSound(9, 110));
  useSoundOnRise(v?.pot ?? 0, sfx.chip);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [sheetFor, setSheetFor] = useState(0); // hand number whose result sheet is open
  const [peek, setPeek] = useState(false);
  const offset = useRef(0); // server clock − local clock
  const [flies, setFlies] = useState<Fly[]>([]);
  const lastSeen = useRef<{ hand: number; status: string; bals: number[] } | null>(null);
  const flyId = useRef(0);

  const take = useCallback((view: View) => {
    offset.current = new Date(view.server_now).getTime() - Date.now();
    // Animate coins: a seat whose balance dropped put coins in the pot; when a hand ends the pot goes to the winner.
    const n = view.seats.length;
    const xy = (seat: number): [number, number] => {
      if (view.me === null) return SEAT_XY[seat % 5];
      if (seat === view.me) return ME_XY;
      return SEAT_XY[(seat - view.me - 1 + n) % n] ?? POT_XY;
    };
    const prev = lastSeen.current;
    const bals = view.seats.map((s) => s.bal);
    const add: Fly[] = [];
    if (prev && prev.hand === view.hand_no && view.status !== "waiting") {
      view.seats.forEach((s, i) => {
        const d = (prev.bals[i] ?? s.bal) - s.bal;
        if (d > 0 && s.playing) add.push({ id: ++flyId.current, from: xy(i), to: POT_XY, amt: d });
      });
      if (prev.status === "playing" && view.status === "done" && view.result) {
        add.push({ id: ++flyId.current, from: POT_XY, to: xy(view.result.seat), amt: view.result.amount });
      }
    }
    lastSeen.current = { hand: view.hand_no, status: view.status, bals };
    if (add.length) {
      setFlies((f) => [...f, ...add]);
      const ids = new Set(add.map((a) => a.id));
      setTimeout(() => setFlies((f) => f.filter((x) => !ids.has(x.id))), 950);
    }
    setErr("");
    setV(view);
    const mine = view.me !== null ? view.seats[view.me] : null;
    if (mine && !mine.bot) applyBalance(mine.bal);
  }, [applyBalance]);

  // Connect, join (or rejoin) the table, and apply every pushed update. The server re-sends the full state on
  // every change — a bot's move, a timeout, a side show answer, another player's action — so there is nothing
  // to poll. Closing the screen does not leave the table (your seat is kept by the server); only Leave does.
  useEffect(() => {
    let alive = true;
    const onMsg = (m: ServerMsg) => {
      if (!alive) return;
      if (m.t === "tp_view") { setBusy(false); take(m.view as View); }
      else if (m.t === "error") {
        setBusy(false);
        const message = String(m.message ?? "Something went wrong");
        if (m.code === "auth" || m.code === "join") setErr(message);
        else showToast(message);
      }
    };
    const off = gameSocket.on(onMsg);
    gameSocket.connect();
    gameSocket.resume({ t: "tp_join", boot: buyIn, code: code ?? undefined });
    return () => { alive = false; off(); gameSocket.disconnect(); };
  }, [buyIn, code, take, showToast]);

  // Clock: just redraws the countdowns locally between pushes; the server is the one deciding when time's up.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);

  // Show the table's result for a moment before the sheet slides up.
  useEffect(() => {
    if (v?.status !== "done" || !v.result) return;
    const hand = v.hand_no;
    const t = setTimeout(() => { setSheetFor(hand); setPeek(false); }, 2000);
    return () => clearTimeout(t);
  }, [v?.status, v?.hand_no, v?.result]);

  const leave = () => {
    gameSocket.resume(null);
    gameSocket.send({ t: "tp_leave" });
    clearActive();
    nav.back();
  };

  const act = (action: "see" | "pack" | "chaal" | "raise" | "show" | "sideshow" | "accept" | "decline") => {
    if (busy) return;
    setBusy(true);
    gameSocket.send({ t: "tp_act", action });
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

  const blindLimit = v?.blind_limit ?? 4;
  const myBlinds = mySeat?.blinds_hand === v?.hand_no ? mySeat?.blinds ?? 0 : 0; // blind chaals so far this hand
  const statusLine = !v || v.status === "waiting"
    ? (v?.code ? "Waiting for friends — a private table needs 2 players" : v?.queued || !v ? "Finding a table…" : "Waiting for players…")
    : null;

  return (
    <LandscapeStage>
      <div className="relative w-full h-full flex flex-col select-none">
        {/* Top bar */}
        <div className="h-11 shrink-0 flex items-center gap-2 px-3 bg-black/30">
          <button onClick={leave} aria-label="Leave table" className="w-8 h-8 grid place-items-center rounded-full bg-white/10"><ChevronLeft size={18} /></button>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Teen Patti</div>
            <div className="text-[11px] text-white/60">Boot {inr(v?.boot ?? buyIn)} • {humans} real player{humans === 1 ? "" : "s"}{v?.hand_no ? ` • Hand #${v.hand_no}` : ""}</div>
          </div>
          {v?.code && (
            <button onClick={() => { navigator.clipboard?.writeText(v.code!); showToast("Code copied"); }} className="ml-3 pill bg-white/10 px-3 py-1 text-[12px]">
              Private • <b className="tracking-widest text-gold-300">{v.code}</b> • Copy
            </button>
          )}
          <div className="ml-auto flex items-center gap-3">
            <Users size={16} className="text-white/50" />
            <Money n={total} className="text-sm font-semibold text-neon-400" />
            <button onClick={leave} className="text-[12px] text-white/60 flex items-center gap-1"><LogOut size={13} /> Leave</button>
          </div>
        </div>

        {/* Table */}
        <div className="relative flex-1 min-h-0">
          <div className="absolute left-[10%] right-[10%] top-[13%] bottom-[17%] felt-oval">
            <div className="absolute inset-x-0 top-[44%] text-center text-[20px] font-black tracking-[0.35em] text-white/10">TEEN PATTI</div>
          </div>

          {/* Pot and status */}
          <div className="absolute left-1/2 top-[36%] -translate-x-1/2 -translate-y-1/2 flex flex-col items-center text-center z-10 w-[40%]">
            {statusLine ? (
              <>
                <div className="text-[13px] text-white/80">{statusLine}</div>
                {v?.next_hand_at && <div className="text-base font-semibold mt-1">Dealing in {Math.ceil(secsTo(v.next_hand_at))}s</div>}
              </>
            ) : v && v.status === "done" && res ? (
              <div className="fadein">
                <div className="text-base font-semibold">{iWon ? "You win!" : `${res.name} wins`}</div>
                <div className="text-[13px] text-gold-300 font-semibold">{inr(res.amount)} • {res.reason}</div>
                <div className="text-[12px] text-white/60 mt-0.5">Next hand in {Math.ceil(secsTo(v.next_hand_at))}s</div>
              </div>
            ) : v ? (
              <>
                <PotStack pot={v.pot} boot={v.boot} />
                <div className="pill bg-black/55 px-4 py-1 text-[15px] text-gold-300 font-bold">Pot {inr(v.pot)}</div>
                <div className="text-[11px] text-white/60 mt-1">Round {v.round} • Pot limit {inr(v.boot * 1024)}</div>
                {pending ? (
                  <div className="text-[12px] text-fuchsia-300 mt-1">{pending.from === me ? "You" : v.seats[pending.from]?.name} asked {pending.to === me ? "you" : v.seats[pending.to]?.name} for a side show • {Math.ceil(secsTo(pending.ends))}s</div>
                ) : v.turn !== null && (
                  <div className={`text-[13px] mt-1 ${myTurn ? "text-neon-400 font-bold" : "text-white/75"}`}>{myTurn ? "Your turn" : `${v.seats[v.turn]?.name}'s turn`} • {Math.ceil(secsTo(v.turn_ends))}s</div>
                )}
              </>
            ) : null}
          </div>

          {/* Other players */}
          {v && others.map((si, k) => {
            const b = v.seats[si];
            if (!b) return null;
            const turn = playing && v.turn === si;
            const shown = reveal(si);
            const box = SEAT_BOX[k] ?? SEAT_BOX[0];
            const won = !!res && res.seat === si && v.status === "done";
            return (
              <div key={si + (b.uid ?? b.name)} className={`absolute flex items-center gap-1.5 z-10 ${box.reverse ? "flex-row-reverse" : ""} ${won ? "drop-shadow-[0_0_14px_rgba(253,224,71,.8)]" : ""}`} style={box.style}>
                <div className="flex flex-col items-center">
                  <TimerAvatar emoji={b.emoji} size={42} active={turn} left={turn ? secsTo(v.turn_ends) : 0} dim={b.packed || !b.playing || b.left} total={TURN_SECS} />
                  <div className="mt-0.5 px-2 py-0.5 rounded-md bg-black/60 text-center max-w-[96px]">
                    <div className="text-[11px] font-medium leading-tight truncate">{b.name}{b.bot && <BotTag />}</div>
                    <div className="text-[11px] text-gold-300 leading-tight">{inr(b.bal)}</div>
                  </div>
                </div>
                <div className="flex flex-col items-center">
                  {v.status !== "waiting" && b.playing && (
                    <div className="flex -space-x-4">
                      {(shown?.cards ?? [0, 1, 2]).map((c, j) => <PlayingCard key={j} card={typeof c === "number" ? undefined : c} faceDown={!shown} size="sm" className={b.packed ? "opacity-40" : ""} />)}
                    </div>
                  )}
                  {b.action ? (
                    <div className={`mt-1 text-[10px] pill px-1.5 py-0.5 whitespace-nowrap ${b.packed ? "bg-rose-500/30 text-rose-200" : "bg-black/50"}`}>{b.action}</div>
                  ) : playing && b.playing && !b.packed ? (
                    <div className="mt-1 text-[10px] text-white/70">{b.seen ? "Seen" : "Blind"}</div>
                  ) : null}
                </div>
              </div>
            );
          })}

          {/* Coins moving between seats and the pot */}
          {flies.map((f) => (
            <div key={f.id} className="coin-fly flex flex-col items-center" style={{ ["--sx" as string]: `${f.from[0]}%`, ["--sy" as string]: `${f.from[1]}%`, ["--ex" as string]: `${f.to[0]}%`, ["--ey" as string]: `${f.to[1]}%` } as React.CSSProperties}>
              <div className="coin" style={{ width: 20, height: 20 }} />
              <div className="mt-0.5 px-1.5 rounded bg-black/60 text-[11px] font-semibold text-gold-300 whitespace-nowrap">{inr(f.amt)}</div>
            </div>
          ))}

          {/* You: avatar and your three cards, large, at the bottom of the table */}
          <div className="absolute left-1/2 bottom-1 -translate-x-1/2 flex items-end gap-3 z-20">
            <div className="flex flex-col items-center mb-1">
              <TimerAvatar emoji={mySeat?.emoji} size={50} active={!!myTurn} left={myTurn ? secsTo(v!.turn_ends) : 0} dim={!!mySeat?.packed} total={TURN_SECS} />
              <div className="mt-0.5 px-2 py-0.5 rounded-md bg-black/65 text-center">
                <div className="text-[11px] font-medium leading-tight">
                  You{playing && mySeat?.playing && (mySeat.packed ? <span className="text-rose-300"> • Packed</span> : <span className="text-white/60"> • {mySeat.seen ? "Seen" : `Blind ${myBlinds}/${blindLimit}`}</span>)}
                </div>
                <div className="text-[11px] text-gold-300 leading-tight">{inr(total)}</div>
              </div>
            </div>
            {v?.queued ? (
              <div className="mb-6 text-[13px] text-white/75 bg-black/50 rounded-lg px-3 py-2">You&apos;ll be dealt in from the next hand</div>
            ) : mySeat && !mySeat.playing && v?.status !== "waiting" ? (
              <div className="mb-3 text-center bg-black/50 rounded-lg px-3 py-2">
                <div className="text-[12px] text-white/75">{mySeat.action ?? "Sitting out"} — you need {inr(v?.boot ?? buyIn)} for the boot</div>
                <button onClick={() => nav.push({ name: "addcash" })} className="btn-green pill px-5 py-1.5 mt-1.5 text-[12px]">Get Coins</button>
              </div>
            ) : mySeat?.playing && v?.status !== "waiting" ? (
              <div className="flex flex-col items-center">
                <div className="flex -space-x-3">
                  {(v?.my_cards ?? [undefined, undefined, undefined]).map((c, i) => (
                    <PlayingCard key={i} card={c} faceDown={!c} size="lg" className={`${c ? "flip" : ""} ${mySeat.packed ? "opacity-50" : ""}`} style={{ transform: `rotate(${(i - 1) * 7}deg) translateY(${Math.abs(i - 1) * 5}px)` }} />
                  ))}
                </div>
                <div className="mt-1 text-[12px] text-white/85 bg-black/45 rounded px-2">
                  {v?.my_hand ? <>Your hand: <b className="text-gold-300">{v.my_hand}</b></> : mySeat.packed ? "Packed without looking" : `Blind ${myBlinds}/${blindLimit} — tap See to look`}
                </div>
              </div>
            ) : null}
          </div>

          {/* Side show: answer, or what you saw */}
          {pending && pending.to === me && (
            <div className="absolute right-3 bottom-3 z-30 w-64 rounded-2xl bg-[#2a1450]/95 border border-fuchsia-400/40 p-3 text-center shadow-xl">
              <div className="text-[13px]"><b>{v!.seats[pending.from]?.name}</b> wants a side show — compare cards privately; the lower hand packs.</div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <button disabled={busy} onClick={() => act("decline")} className="btn-ghost rounded-full py-2 text-[13px]">Decline</button>
                <button disabled={busy} onClick={() => act("accept")} className="rounded-full py-2 text-[13px] font-semibold bg-fuchsia-600">Accept • {Math.ceil(secsTo(pending.ends))}s</button>
              </div>
            </div>
          )}
          {v?.sideshow && playing && (
            <div className="absolute left-3 bottom-3 z-30 rounded-xl bg-black/60 p-2 flex items-center gap-2 max-w-[40%]">
              <div className="flex -space-x-3">{v.sideshow.cards.map((c, i) => <PlayingCard key={i} card={c} size="xs" />)}</div>
              <div className="text-[12px]">Side show vs <b>{v.seats[v.sideshow.seat]?.name}</b> ({v.sideshow.hand}) — you {v.sideshow.lost ? <span className="text-rose-300">lost</span> : <span className="text-neon-400">won</span>}</div>
            </div>
          )}
        </div>

        {/* Action bar */}
        <div className="h-14 shrink-0 flex items-center gap-2 px-3 bg-black/45 border-t border-white/10">
          {inHand && mySeat?.packed === false ? (
            <>
              <button disabled={!myTurn || !!pending || busy} onClick={() => act("pack")} className="rounded-lg px-5 py-2.5 text-sm font-bold bg-[#8b1d2c] border border-white/15 disabled:opacity-40">Pack</button>
              <button disabled={!canSideShow || busy} onClick={() => act("sideshow")} className="rounded-lg px-3 py-2.5 text-[12px] font-bold bg-fuchsia-700 disabled:opacity-40">Side Show</button>
              <button disabled={!myTurn || !!pending || busy || active !== 2} onClick={() => act("show")} className="rounded-lg px-5 py-2.5 text-sm font-bold bg-[#8b1d2c] border border-white/15 disabled:opacity-40">Show</button>
              <div className="flex-1 flex justify-center">
                <button disabled={mySeat.seen || busy} onClick={() => act("see")} className="rounded-full px-6 py-2 text-sm font-bold bg-sky-500 disabled:opacity-40">{mySeat.seen ? "Seen ✓" : `See${myBlinds > 0 ? ` • blind ${myBlinds}/${blindLimit}` : ""}`}</button>
              </div>
              <button disabled={!myTurn || !!pending || busy || (v?.stake ?? 0) >= (v?.boot ?? buyIn) * 128} onClick={() => act("raise")} className="rounded-lg px-4 py-1.5 text-[12px] font-bold bg-[#3d7a1f] border border-lime-300/30 disabled:opacity-40 leading-tight">
                {mySeat.seen ? "Chaal" : "Blind"} 2x<br /><span className="text-[13px]">{inr(chaalAmt * 2)}</span>
              </button>
              <button disabled={!myTurn || !!pending || busy} onClick={() => act("chaal")} className="rounded-lg px-5 py-1.5 text-[12px] font-bold bg-[#b8231f] border border-white/20 disabled:opacity-40 leading-tight">
                {mySeat.seen ? "Chaal" : "Blind"}<br /><span className="text-[13px]">{inr(chaalAmt)}</span>
              </button>
            </>
          ) : (
            <div className="flex-1 text-center text-[13px] text-white/60">
              {playing && mySeat?.packed ? "You packed — waiting for this hand to finish" : `Cards are dealt by the server • ${TURN_SECS}s per turn`}
            </div>
          )}
        </div>
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
    </LandscapeStage>
  );
}
