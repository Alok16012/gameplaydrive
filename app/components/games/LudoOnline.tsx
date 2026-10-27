"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, LogOut, Share2, Trophy } from "lucide-react";
import { inr } from "../../lib/data";
import { useStore } from "../../lib/store";
import { errText, joinOnce, supabase } from "../../lib/supabase";
import { REJOIN_MS, clearActive, markActive } from "../../lib/rejoin";
import { sfx } from "../../lib/sound";
import { Avatar, Header, Money } from "../ui";
import { LPLAYERS, LUDO_STEP_MS, LUDO_TURN_SECS, LudoBoardSurface, LudoSeatPanel, ludoColourAt, ludoOnSafe, ludoTurns } from "./Board";
import type { Nav } from "../nav";

// Ludo with friends: a private table run by the database (supabase/migrations/028_ludo_private.sql). The host
// creates it with an entry and gets a code; friends join with the code; it starts when the table is full. The
// server rolls every dice and checks every move; when a turn's 20 s run out the table plays for that player.
// Closing this screen keeps your seat (Rejoin from Home); "Leave table" gives it up.

interface LSeat { name: string; emoji: string; colour: number; tokens: number[]; left: boolean; misses: number; me: boolean }
interface Last { kind: string; seat?: number; token?: number; from?: number; to?: number; dice?: number; caught?: { seat: number; token: number }[]; why?: string; name?: string }
interface View {
  id: string; code: string; entry: number; max_players: 2 | 4; status: "waiting" | "playing" | "done" | "cancelled";
  seats: LSeat[]; me: number | null; turn: number | null; phase: "roll" | "move" | null; dice: number | null; turn_ends: string | null;
  winner: number | null; pot: number; prize: number; fee: number; last: Last | null; seq: number; server_now: string;
}

const STEP_MS = LUDO_STEP_MS;
const empty = () => [0, 1, 2, 3].map(() => [-1, -1, -1, -1]);
const byColour = (v: View | null) => {
  const t = empty();
  for (const s of v?.seats ?? []) if (!s.left) t[s.colour] = [...s.tokens];
  return t;
};

export function LudoOnline({ nav, code, entry }: { nav: Nav; code: string; entry: number }) {
  const { total, showToast, applyBalance } = useStore();
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [shown, setShown] = useState<number[][]>(empty); // tokens on screen (walk one square at a time)
  const [rolling, setRolling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stepping, setStepping] = useState(false); // a token is walking: no roll prompt until it lands
  // Each seat's last roll, so a dice waiting to be rolled shows that player's own last number (never a blank face).
  const [rolledBy, setRolledBy] = useState<Record<number, number>>({});
  const [confirmLeave, setConfirmLeave] = useState(false);
  const tableId = useRef<string | null>(null);
  const offset = useRef(0);
  const lastSeq = useRef(-1);
  const walking = useRef(0);
  const ticking = useRef(false);
  // A move of yours already walking on screen before the server answered (so a tap moves the token at once).
  const ahead = useRef<{ colour: number; token: number; to: number; doneAt: number } | null>(null);
  const prev = useRef<View | null>(null);
  const lastTick = useRef(-1);

  /** Walk one token square by square; returns when (ms from now) it lands. */
  const walk = useCallback((colour: number, token: number, from: number, to: number) => {
    const steps = from < 0 ? [0] : Array.from({ length: to - from }, (_, k) => from + k + 1);
    const run = ++walking.current;
    steps.forEach((prog, k) => {
      window.setTimeout(() => {
        if (walking.current !== run) return;
        setShown((sh) => { const n = sh.map((r) => [...r]); n[colour][token] = prog; return n; });
        if (prog === 56) sfx.home(); else sfx.hop();
      }, k * STEP_MS);
    });
    setStepping(true);
    window.setTimeout(() => { if (walking.current === run) setStepping(false); }, steps.length * STEP_MS + 60);
    return { run, ms: steps.length * STEP_MS };
  }, []);

  const take = useCallback((view: View) => {
    offset.current = new Date(view.server_now).getTime() - Date.now();
    setV((old) => (old && old.seq > view.seq ? old : view));
  }, []);

  const pull = useCallback(async () => {
    if (!tableId.current) return;
    const { data } = await supabase().rpc("ld_state", { p_table: tableId.current });
    if (data) take(data as View);
  }, [take]);

  const tick = useCallback(async () => {
    if (!tableId.current || ticking.current) return;
    ticking.current = true;
    const { data } = await supabase().rpc("ld_tick", { p_table: tableId.current });
    ticking.current = false;
    if (data) take(data as View);
  }, [take]);

  // Join (or come back to) the table, follow it live.
  useEffect(() => {
    let alive = true;
    const sb = supabase();
    let channel: ReturnType<typeof sb.channel> | null = null;
    (async () => {
      const { data, error } = await joinOnce("ld_join", { p_code: code });
      if (!alive) return;
      if (error) return setErr(errText(error));
      tableId.current = data as string;
      channel = sb.channel(`ld-${data}`)
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "ld_tables", filter: `id=eq.${data}` }, () => pull())
        .subscribe();
      tick();
    })();
    // Backup for missed realtime pushes (weak mobile data drops them): poll every second, and at once on return to the tab.
    const poll = setInterval(() => { if (!document.hidden) pull(); }, 1000);
    const back = () => { if (!document.hidden) pull(); };
    document.addEventListener("visibilitychange", back);
    return () => { alive = false; clearInterval(poll); document.removeEventListener("visibilitychange", back); if (channel) sb.removeChannel(channel); };
  }, [code, pull, tick]);

  // Clock: run out the turn on the server when it is due; tick through the last 5 seconds of your own turn.
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      if (v?.status === "playing" && v.turn === v.me && v.turn_ends) {
        const left = Math.ceil((new Date(v.turn_ends).getTime() - Date.now() - offset.current) / 1000);
        if (left >= 1 && left <= 5 && left !== lastTick.current) { lastTick.current = left; sfx.tickUrgent(); }
      }
      if (v?.status === "playing" && v.turn_ends && Date.now() + offset.current >= new Date(v.turn_ends).getTime() + 300) tick();
    }, 250);
    return () => clearInterval(t);
  }, [v?.status, v?.turn_ends, v?.turn, v?.me, tick]);

  // Rejoin from Home while the game is on; forget it when it's over.
  useEffect(() => {
    if (!v) return;
    const route = { name: "board" as const, game: "ludo" as const, table: `P-${v.code}`, buyIn: v.entry, players: v.max_players };
    if (v.status === "waiting" || v.status === "playing") markActive(route, `Ludo with friends • ${v.code}`, REJOIN_MS.ludo);
    else clearActive(route);
  }, [v?.status, v?.code, v?.entry, v?.max_players]); // eslint-disable-line react-hooks/exhaustive-deps

  // Play each change on the board: the moved token walks square by square, captures go home after it lands.
  useEffect(() => {
    if (!v || v.seq === lastSeq.current) return;
    const first = lastSeq.current < 0;
    lastSeq.current = v.seq;
    const target = byColour(v);
    const L = v.last;
    if (!first && L?.kind === "move" && L.seat !== undefined && L.token !== undefined && L.from !== undefined && L.to !== undefined) {
      const colour = v.seats[L.seat]?.colour ?? 0;
      const a = ahead.current;
      let run: number, ms: number;
      if (a && a.colour === colour && a.token === L.token && a.to === L.to) {
        // Already walking since the tap: just settle the board when it lands.
        ahead.current = null;
        run = walking.current;
        ms = Math.max(0, a.doneAt - Date.now());
      } else {
        ahead.current = null;
        ({ run, ms } = walk(colour, L.token, L.from, L.to));
      }
      window.setTimeout(() => {
        if (walking.current !== run) return;
        if (L.caught?.length) sfx.capture();
        else if (L.to !== 56 && ludoOnSafe(colour, L.to!)) sfx.bell(); // landed on a safe square
        setShown(target);
      }, ms + 60);
    } else {
      walking.current++;
      setStepping(false);
      setShown(target);
    }
    const before = prev.current;
    prev.current = v;
    if (L?.seat !== undefined && L.dice) setRolledBy((r) => (r[L.seat!] === L.dice ? r : { ...r, [L.seat!]: L.dice! }));
    // Someone else's roll (also one that moved their only token straight away).
    const rolledNow = L?.kind === "roll" || L?.kind === "nomove" || L?.kind === "skip" || (L?.kind === "move" && before?.phase === "roll" && before.turn === L.seat);
    if (!first && L?.seat !== v.me && rolledNow) sfx.dice();
    // Your turn starts: a short chime.
    if (!first && v.status === "playing" && v.turn === v.me && v.phase === "roll" && (before?.turn !== v.me || before?.phase !== "roll" || before.seq !== v.seq) && !(L?.seat === v.me && L?.kind === "roll")) sfx.slot();
    if (v.status === "done" && v.winner !== null) { if (v.winner === v.me) sfx.bigWin(); else sfx.lose(); }
  }, [v]);

  const act = async (action: "roll" | "move", token?: number) => {
    if (!tableId.current || busy) return;
    setBusy(true);
    if (action === "roll") { setRolling(true); sfx.dice(); }
    // A move starts walking at once; the server's answer then only confirms it.
    if (action === "move" && token !== undefined && v?.dice && mySeat) {
      const from = mySeat.tokens[token];
      const to = from < 0 ? 0 : from + v.dice;
      const { ms } = walk(mySeat.colour, token, from, to);
      ahead.current = { colour: mySeat.colour, token, to, doneAt: Date.now() + ms };
    }
    const [res] = await Promise.all([
      supabase().rpc("ld_act", { p_table: tableId.current, p_action: action, p_token: token ?? null }),
      new Promise((r) => setTimeout(r, action === "roll" ? 550 : 0)),
    ]);
    setRolling(false);
    setBusy(false);
    if (res.error) {
      showToast(errText(res.error));
      ahead.current = null;
      walking.current++;
      setStepping(false);
      setShown(byColour(v)); // undo a move shown ahead of the server
      pull();
      return;
    }
    take(res.data as View);
  };

  // The host (who made the table) can start a 4-player table with 2 or 3 in (migration 105).
  const hostStart = async () => {
    if (!tableId.current || busy) return;
    setBusy(true);
    const { data, error } = await supabase().rpc("ld_host_start", { p_table: tableId.current });
    setBusy(false);
    if (error) return showToast(errText(error));
    take(data as View);
  };

  const leave = async () => {
    setConfirmLeave(false);
    if (tableId.current) {
      const { data, error } = await supabase().rpc("ld_leave", { p_table: tableId.current });
      if (error) return showToast(errText(error));
      const vv = data as View;
      if (vv.status === "cancelled" || vv.status === "waiting") showToast("Left the table — entry returned");
    }
    clearActive();
    nav.back();
  };
  // Refresh the balance after the entry / prize moves.
  useEffect(() => {
    if (!v) return;
    supabase().auth.getSession().then(({ data: s }) => {
      const uid = s.session?.user.id;
      if (uid) supabase().from("wallets").select("coins").eq("user_id", uid).maybeSingle().then(({ data }) => data && applyBalance(data.coins));
    });
  }, [v?.status, v?.winner, v?.seats.length, applyBalance]); // eslint-disable-line react-hooks/exhaustive-deps

  const serverNow = now + offset.current;
  const me = v?.me ?? null;
  const mySeat = me !== null && v ? v.seats[me] : null;
  const myTurn = !!v && v.status === "playing" && v.turn === me && me !== null;
  const myColour = mySeat?.colour ?? 0;
  const turns = ludoTurns(myColour); // your yard always at the bottom-left, next to your dice
  const movable = myTurn && v?.phase === "move" && v.dice && mySeat
    ? mySeat.tokens.map((p, i) => ((p === -1 && v.dice === 6) || (p >= 0 && p + v.dice! <= 56) ? i : -1)).filter((i) => i >= 0)
    : [];
  const seatOfColour = (c: number) => (v ? v.seats.findIndex((s) => s.colour === c) : -1);
  const inPlay = (c: number) => { const i = seatOfColour(c); return i >= 0 && !v!.seats[i].left; };
  const secsLeft = v?.turn_ends ? Math.max(0, (new Date(v.turn_ends).getTime() - serverNow) / 1000) : 0;
  const nameOf = (i: number | undefined) => (i === undefined || !v ? "" : i === me ? "You" : v.seats[i]?.name ?? "");

  const lastText = (() => {
    const L = v?.last;
    if (!v || !L) return "";
    const who = nameOf(L.seat);
    switch (L.kind) {
      case "start": return `${who} ${L.seat === me ? "go" : "goes"} first`;
      case "joined": return `${nameOf(L.seat)} joined`;
      case "roll": return `${who} rolled ${L.dice}`;
      case "nomove": return `${who} rolled ${L.dice} — no move`;
      case "skip": return `${who} rolled three 6s — turn lost`;
      case "move": return L.caught?.length ? `${who} captured ${L.caught.map((c) => (c.seat === me ? "your" : `${nameOf(c.seat)}'s`)).join(", ")} token!` : L.to === 56 ? `${who} brought a token home!` : `${who} moved ${L.dice}`;
      case "left": return `${L.seat !== undefined ? nameOf(L.seat) : L.name} left the table`;
      default: return "";
    }
  })();

  const badge = (c: number, align: "left" | "right", top = false) => {
    const si = seatOfColour(c);
    if (si < 0 || !v) return <span />;
    const s = v.seats[si];
    const active = v.status === "playing" && v.turn === si;
    const canRoll = !!s.me && myTurn && v.phase === "roll" && !busy && !stepping && !done;
    return (
      <LudoSeatPanel
        colour={c} name={s.me ? "You" : s.name} emoji={s.emoji} align={align} top={top} dim={!!s.left} note={s.left ? "left" : undefined}
        active={active} timerKey={active ? `${v.seq}-${v.turn}` : null}
        dice={active ? v.dice ?? rolledBy[si] ?? 6 : v.last?.seat === si ? v.last.dice ?? null : null}
        showDice={!active && v.last?.seat === si && ["move", "nomove", "skip"].includes(v.last.kind)}
        rolling={!!s.me && rolling} canRoll={canRoll} onRoll={() => act("roll")}
        home={s.tokens.filter((x) => x === 56).length}
      />
    );
  };

  const share = () => {
    const text = `Join my Ludo table on Khelobaazi! Code: ${v?.code} (entry 🪙 ${v?.entry}). Open Ludo → Private Table → Join.`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
  };

  if (err && !v) {
    return (
      <div className="min-h-dvh flex flex-col fadein">
        <Header title="Ludo with friends" onBack={nav.back} />
        <div className="flex-1 grid place-items-center px-6 text-center">
          <div>
            <div className="text-sm text-white/80">{err}</div>
            {/run 028|ld_join|function/i.test(err) && <div className="text-xs text-white/50 mt-2">Private Ludo needs the database update 028_ludo_private.sql.</div>}
            <button onClick={nav.back} className="btn-ghost rounded-xl px-5 py-2.5 mt-4 text-sm">Back</button>
          </div>
        </div>
      </div>
    );
  }

  const waiting = !v || v.status === "waiting";
  const done = v?.status === "done" || v?.status === "cancelled";
  const iWon = !!v && v.winner !== null && v.winner === me;

  return (
    <div className="min-h-dvh flex flex-col pb-5 fadein" style={{ background: "radial-gradient(120% 70% at 50% 35%, #1d3a8a 0%, #0b1438 60%, #070b22 100%)" }}>
      <Header
        title="Ludo with friends"
        sub={v ? `Code ${v.code} • ${v.max_players === 2 ? "1 vs 1" : "4 players"} • Entry 🪙 ${v.entry}` : "Joining…"}
        onBack={nav.back}
        right={<div className="flex items-center gap-3"><Money n={total} className="text-sm font-semibold text-neon-400" /><button onClick={() => setConfirmLeave(true)} aria-label="Leave table" className="text-white/70"><LogOut size={18} /></button></div>}
      />
      <div className="px-3">
        {waiting ? (
          <div className="card p-4 mt-2 text-center">
            <div className="text-sm text-white/70">Share this code with your friends</div>
            <div className="text-4xl font-extrabold tracking-[0.3em] my-3">{v?.code ?? code}</div>
            <div className="flex justify-center gap-2">
              <button onClick={() => { navigator.clipboard?.writeText(v?.code ?? code); showToast("Code copied"); }} className="btn-ghost rounded-full px-4 py-2 text-sm flex items-center gap-1.5"><Copy size={15} /> Copy</button>
              <button onClick={share} className="rounded-full px-4 py-2 text-sm font-semibold flex items-center gap-1.5 bg-[#25d366] text-white"><Share2 size={15} /> WhatsApp</button>
            </div>
            <div className="mt-5 text-left">
              <div className="text-xs text-white/50 mb-2">Players {v?.seats.length ?? 1}/{v?.max_players ?? "…"} • the game starts when the table is full</div>
              <div className="space-y-2">
                {Array.from({ length: v?.max_players ?? 2 }, (_, i) => {
                  const s = v?.seats[i];
                  const colour = (v?.max_players === 2 ? [0, 2] : [0, 1, 2, 3])[i];
                  return (
                    <div key={i} className="flex items-center gap-3 rounded-xl bg-white/5 px-3 py-2">
                      <span className="w-3 h-3 rounded-full" style={{ background: LPLAYERS[colour].color }} />
                      <span className="flex-1 text-sm">{s ? (s.me ? "You" : s.name) : <span className="text-white/40">Waiting for a friend…</span>}</span>
                      {i === 0 && s && <span className="text-[11px] text-gold-300">Host</span>}
                    </div>
                  );
                })}
              </div>
              <div className="text-[11px] text-white/45 mt-3">Pot 🪙 {v?.pot ?? 0} • winner gets the pot less the {Math.round((v?.fee ?? 0.1) * 100)}% platform fee. Leave before the start and your entry comes back.</div>
              {v && v.seats[0]?.me && v.seats.length < v.max_players && (
                v.seats.length >= 2
                  ? <button onClick={hostStart} disabled={busy} className="btn-green w-full rounded-2xl py-3 mt-4 text-sm font-semibold">Start now with {v.seats.length} players</button>
                  : <div className="text-[12px] text-white/55 mt-3 text-center">You&apos;re the host — start as soon as a friend joins, or wait for the table to fill.</div>
              )}
              {v && !v.seats[0]?.me && v.seats.length >= 2 && v.seats.length < v.max_players && (
                <div className="text-[12px] text-white/55 mt-3 text-center">The host can start now, or wait for the table to fill.</div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="flex justify-between items-center mb-2 px-1 min-h-[46px]">{badge(ludoColourAt(0, turns), "left", true)}{badge(ludoColourAt(1, turns), "right", true)}</div>
            <LudoBoardSurface
              tokens={shown}
              inPlay={inPlay}
              turns={turns}
              glowAt={(c, i) => c === myColour && movable.includes(i)}
              onTap={(c, i) => { if (c === myColour && movable.includes(i)) act("move", i); }}
              blinkYard={myTurn && v?.phase === "roll" && !busy && !stepping && !done ? myColour : null}
            />
            <div className="flex justify-between items-center mt-2 px-1 min-h-[46px]">{badge(ludoColourAt(3, turns), "left")}{badge(ludoColourAt(2, turns), "right")}</div>
            <div className="mt-3 flex flex-col items-center">
              <div className="text-sm font-semibold">
                {done ? "Game over" : mySeat?.left ? "You're out — you missed 3 turns" : myTurn ? (v?.phase === "move" ? "Choose a glowing token" : "Your turn — tap the dice") : `${nameOf(v?.turn ?? undefined)}'s turn`}
                {v?.status === "playing" && <span className="text-white/50 font-normal"> • {Math.ceil(secsLeft)}s</span>}
              </div>
              <div className="text-xs text-white/60 mt-0.5 text-center min-h-4">{lastText}</div>
            </div>
          </>
        )}
      </div>

      {done && v && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-6">
          <div className="w-full max-w-[360px] rounded-3xl bg-[#0d1230] border border-white/10 p-6 text-center pop">
            <div className="inline-grid place-items-center w-20 h-20 rounded-full" style={{ background: iWon ? "radial-gradient(circle,#fde68a,#f59e0b)" : "rgba(255,255,255,.08)" }}>
              {iWon ? <Trophy size={40} className="text-amber-900" /> : <span className="text-4xl">😔</span>}
            </div>
            <div className="text-2xl font-semibold mt-3">
              {v.status === "cancelled" ? "Table closed" : iWon ? `You won ${inr(v.prize)}!` : `${nameOf(v.winner ?? undefined)} wins`}
            </div>
            {v.status === "done" && <div className="text-sm text-white/60 mt-1">Pot 🪙 {v.pot} • prize 🪙 {v.prize}</div>}
            <button onClick={() => { clearActive(); nav.back(); }} className="btn-green w-full py-3 rounded-2xl mt-5">Back to lobby</button>
          </div>
        </div>
      )}

      {confirmLeave && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-6" onClick={() => setConfirmLeave(false)}>
          <div className="w-full max-w-[360px] rounded-3xl bg-[#0d1230] border border-white/10 p-5" onClick={(e) => e.stopPropagation()}>
            <div className="text-lg font-semibold">Leave the table?</div>
            <div className="text-sm text-white/65 mt-1.5">
              {waiting ? "The game hasn't started — your entry comes back." : done ? "The game is over." : "The game is on — leaving gives it up and your entry is lost."}
            </div>
            <div className="grid grid-cols-2 gap-2 mt-4">
              <button onClick={() => setConfirmLeave(false)} className="btn-ghost rounded-xl py-2.5 text-sm">Stay</button>
              <button onClick={leave} className="rounded-xl py-2.5 text-sm font-semibold bg-rose-500">Leave</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
