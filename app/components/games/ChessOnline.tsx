"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Flag, Share2, Trophy } from "lucide-react";
import { inr } from "../../lib/data";
import { useStore } from "../../lib/store";
import { apiFetch, errText, joinOnce, supabase } from "../../lib/supabase";
import { clearActive, markActive } from "../../lib/rejoin";
import { sfx } from "../../lib/sound";
import { inCheck, kingSquare, legalMoves, type Move } from "../../lib/chess";
import { Header, Money } from "../ui";
import { ChessPiece } from "./ChessPieces";
import type { ChessView } from "../../lib/server/chess";
import type { Nav } from "../nav";

// Chess with a friend (migration 109): the host makes a table with an entry and shares the code; the friend joins
// with it, colours are drawn at random and both play 10 minutes a side. Moves go through our server, which checks
// them and keeps the clocks (/api/chess/move, /api/chess/state); this screen polls every second.

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await apiFetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? "Something went wrong");
  return j as T;
}
const fmt = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const same = (a: [number, number] | null | undefined, r: number, c: number) => !!a && a[0] === r && a[1] === c;
const REASON: Record<string, string> = { checkmate: "Checkmate", resigned: "Resigned", time: "Out of time", stalemate: "Stalemate", "insufficient material": "Not enough pieces to mate", "50-move rule": "50-move rule", "threefold repetition": "Same position three times" };

export function ChessOnline({ nav, code, entry }: { nav: Nav; code: string; entry: number }) {
  const { total, showToast } = useStore();
  const [v, setV] = useState<ChessView | null>(null);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [sel, setSel] = useState<[number, number] | null>(null);
  const [promo, setPromo] = useState<Move[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [askResign, setAskResign] = useState(false);
  const tableId = useRef<string | null>(null);
  const offset = useRef(0);
  const lastSeq = useRef(-1);

  const take = useCallback((x: ChessView) => {
    offset.current = x.serverNow - Date.now();
    setV((old) => (old && old.id === x.id && old.seq > x.seq ? old : x));
  }, []);
  const pull = useCallback(async () => {
    if (!tableId.current) return;
    try { take(await api<ChessView>(`/api/chess/state?table=${tableId.current}`)); } catch { /* next poll */ }
  }, [take]);

  // Join (or come back to) the table, then follow it.
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await joinOnce("ch_join", { p_code: code });
      if (!alive) return;
      if (error) return setErr(errText(error));
      tableId.current = data as string;
      pull();
    })();
    const poll = setInterval(() => { if (!document.hidden) pull(); }, 1000);
    const clock = setInterval(() => setNow(Date.now()), 250);
    const back = () => { if (!document.hidden) pull(); };
    document.addEventListener("visibilitychange", back);
    return () => { alive = false; clearInterval(poll); clearInterval(clock); document.removeEventListener("visibilitychange", back); };
  }, [code, pull]);

  // Sounds for each new move; the result.
  useEffect(() => {
    if (!v || v.seq === lastSeq.current) return;
    const first = lastSeq.current < 0;
    lastSeq.current = v.seq;
    if (first) return;
    if (v.status === "done") { if (v.outcome === "draw") sfx.chip(); else if (v.outcome === v.me) sfx.bigWin(); else sfx.lose(); return; }
    if (v.status === "playing" && v.moves.length) {
      const m = v.moves[v.moves.length - 1];
      if (m.endsWith("+") || m.endsWith("#")) sfx.tickUrgent(); else if (m.includes("x")) sfx.capture(); else sfx.move();
    }
  }, [v]);

  // Rejoin from Home while the game is on.
  useEffect(() => {
    if (!v) return;
    const route = { name: "board" as const, game: "chess" as const, table: `P-${v.code}`, buyIn: v.entry };
    if (v.status === "waiting" || v.status === "playing") markActive(route, `Chess with a friend • ${v.code}`, 10 * 60 * 1000);
    else clearActive(route);
  }, [v?.status, v?.code, v?.entry]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (m: Move) => {
    if (!tableId.current || busy) return;
    setBusy(true);
    setSel(null);
    try {
      take(await api<ChessView>("/api/chess/move", { method: "POST", body: JSON.stringify({ table: tableId.current, from: m.from, to: m.to, promo: m.promo }) }));
    } catch (e) {
      showToast((e as Error).message);
      pull();
    }
    setBusy(false);
  };
  const leave = async () => {
    setAskResign(false);
    if (tableId.current) {
      const { error } = await supabase().rpc("ch_leave", { p_table: tableId.current });
      if (error) return showToast(errText(error));
    }
    if (v?.status === "waiting") showToast("Table closed — entry returned");
    clearActive();
    nav.back();
  };

  if (err && !v) {
    return (
      <div className="min-h-dvh flex flex-col fadein">
        <Header title="Chess with a friend" onBack={nav.back} />
        <div className="flex-1 grid place-items-center px-6 text-center">
          <div>
            <div className="text-sm text-white/80">{err}</div>
            <button onClick={nav.back} className="btn-ghost rounded-xl px-5 py-2.5 mt-4 text-sm">Back</button>
          </div>
        </div>
      </div>
    );
  }

  const serverNow = now + offset.current;
  const pos = v?.pos ?? null;
  const me = v?.me ?? "w";
  const flip = me === "b";
  const playing = v?.status === "playing";
  const myTurn = !!pos && playing && pos.turn === me;
  // Clocks: the side to move counts down from the server's figure.
  const since = v ? serverNow - v.serverNow : 0;
  const clockOf = (s: "w" | "b") => (v ? Math.max(0, v.clock[s] - (playing && pos?.turn === s ? since : 0)) : 0);
  const moves = myTurn && pos ? legalMoves(pos) : [];
  const targets = sel ? moves.filter((m) => same(m.from, sel[0], sel[1])) : [];
  const own = (p: string) => p !== "." && (me === "w" ? p === p.toUpperCase() : p === p.toLowerCase());
  const check = !!pos && playing && inCheck(pos);
  const [kr, kc] = pos ? kingSquare(pos.board, pos.turn) : [-1, -1];
  const opp: "w" | "b" = me === "w" ? "b" : "w";

  const tap = (r: number, c: number) => {
    if (!pos || !myTurn || busy) return;
    const ms = targets.filter((m) => same(m.to, r, c));
    if (ms.length > 1) { setPromo(ms); setSel(null); return; }
    if (ms.length === 1) return send(ms[0]);
    setSel(own(pos.board[r][c]) && !same(sel, r, c) ? [r, c] : null);
  };

  const bar = (s: "w" | "b") => {
    const active = playing && pos?.turn === s;
    const ms = clockOf(s);
    const name = v?.names[s] ?? (s === me ? "You" : "Waiting…");
    return (
      <div className="flex items-center gap-3 card px-3 py-2">
        <span className="w-8 h-8 rounded-full grid place-items-center text-lg" style={{ background: s === "w" ? "#f2f2f2" : "#2b2b2b", color: s === "w" ? "#111" : "#eee" }}>{s === "w" ? "♔" : "♚"}</span>
        <div className="flex-1 text-sm font-medium leading-tight">{s === me ? "You" : name}<div className="text-[11px] font-normal text-white/50">{s === "w" ? "White" : "Black"}{active && s !== me ? " • thinking…" : ""}</div></div>
        <div className={`font-mono text-sm px-2.5 py-1 rounded-lg ${active ? (ms <= 30000 ? "bg-rose-500 text-white animate-pulse" : "bg-white text-slate-900") : "bg-white/10 text-white/60"}`}>{fmt(ms)}</div>
      </div>
    );
  };

  const share = () => {
    const text = `Play chess with me on Khelobaazi! Code: ${v?.code ?? code} (entry 🪙 ${v?.entry ?? entry}). Open Chess → Private Table → Join.`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
  };

  const done = v?.status === "done" || v?.status === "cancelled";
  const won = !!v && v.outcome !== null && v.outcome === v.me;

  return (
    <div className="min-h-dvh flex flex-col pb-5 fadein">
      <Header
        title="Chess with a friend"
        sub={v ? `Code ${v.code} • Entry 🪙 ${v.entry}${playing ? ` • You play ${me === "w" ? "White" : "Black"}` : ""}` : "Joining…"}
        onBack={nav.back}
        right={<Money n={total} className="text-sm font-semibold text-neon-400" />}
      />
      <div className="px-3 space-y-2">
        {!v || v.status === "waiting" ? (
          <div className="card p-4 mt-2 text-center">
            <div className="text-sm text-white/70">Share this code with your friend</div>
            <div className="text-4xl font-extrabold tracking-[0.3em] my-3">{v?.code ?? code}</div>
            <div className="flex justify-center gap-2">
              <button onClick={() => { navigator.clipboard?.writeText(v?.code ?? code); showToast("Code copied"); }} className="btn-ghost rounded-full px-4 py-2 text-sm flex items-center gap-1.5"><Copy size={15} /> Copy</button>
              <button onClick={share} className="rounded-full px-4 py-2 text-sm font-semibold flex items-center gap-1.5 bg-[#25d366] text-white"><Share2 size={15} /> WhatsApp</button>
            </div>
            <div className="text-[12px] text-white/55 mt-4">Waiting for your friend… the game starts as soon as they join. Colours are drawn at random; 10 minutes each.</div>
            <div className="text-[11px] text-white/45 mt-2">Winner gets both entries less the platform fee • a draw returns your entry • leave now and your entry comes back.</div>
            <button onClick={leave} className="mt-4 text-[12px] text-rose-300">Close table</button>
          </div>
        ) : (
          <>
            {bar(opp)}
            <div className="relative grid grid-cols-8 rounded-[4px] overflow-hidden shadow-2xl select-none">
              {pos && pos.board.map((row, dr) =>
                row.map((_, dc) => {
                  const r = flip ? 7 - dr : dr, c = flip ? 7 - dc : dc;
                  const p = pos.board[r][c];
                  const dark = (r + c) % 2 === 1;
                  const isLast = v.last && (same(v.last.from, r, c) || same(v.last.to, r, c));
                  const tgt = targets.find((m) => same(m.to, r, c));
                  return (
                    <button key={`${r}${c}`} onClick={() => tap(r, c)} className="relative aspect-square grid place-items-center"
                      style={{
                        backgroundColor: same(sel, r, c) ? "#f6e05e" : isLast ? (dark ? "#b9ca43" : "#f5f682") : dark ? "#779556" : "#ebecd0",
                        backgroundImage: check && r === kr && c === kc ? "radial-gradient(circle, rgba(255,0,0,.9) 0%, rgba(231,0,0,.55) 35%, rgba(169,0,0,0) 72%)" : undefined,
                      }}>
                      {dc === 0 && <span className={`absolute left-[3px] top-[1px] text-[10px] font-bold ${dark ? "text-[#ebecd0]" : "text-[#779556]"}`}>{8 - r}</span>}
                      {dr === 7 && <span className={`absolute right-[3px] bottom-0 text-[10px] font-bold ${dark ? "text-[#ebecd0]" : "text-[#779556]"}`}>{"abcdefgh"[c]}</span>}
                      {p !== "." && <span className="w-[92%] h-[92%] pointer-events-none"><ChessPiece p={p} /></span>}
                      {tgt && (tgt.captured !== "." || tgt.ep
                        ? <span className="absolute inset-[6%] rounded-full border-[4px] border-black/25 pointer-events-none" />
                        : <span className="absolute w-[28%] h-[28%] rounded-full bg-black/25 pointer-events-none" />)}
                    </button>
                  );
                }),
              )}
              {promo && (
                <div className="absolute inset-0 bg-black/55 grid place-items-center z-20">
                  <div className="rounded-2xl bg-[#0d1230] border border-white/15 p-3 pop">
                    <div className="text-center text-xs text-white/60 mb-2">Promote to</div>
                    <div className="flex gap-2">
                      {["Q", "R", "B", "N"].map((k) => (me === "w" ? k : k.toLowerCase())).map((k) => {
                        const m = promo.find((x) => x.promo === k);
                        return m ? <button key={k} onClick={() => { setPromo(null); send(m); }} className="w-14 h-14 rounded-xl bg-[#ebecd0] grid place-items-center p-1 active:scale-95"><ChessPiece p={k} /></button> : null;
                      })}
                    </div>
                    <button onClick={() => setPromo(null)} className="w-full mt-2 text-[11px] text-white/50">Cancel</button>
                  </div>
                </div>
              )}
            </div>
            {bar(me)}
            <div className={`text-center text-[12px] mt-1 ${check && myTurn ? "text-rose-400 font-semibold" : "text-white/50"}`}>
              {done ? (v.reason ? REASON[v.reason] ?? v.reason : "Game over") : myTurn ? (check ? "Check! Protect your king" : "Your move — tap a piece, then a square") : `${v.names[opp] ?? "Your friend"} is thinking…`}
            </div>
            {v.moves.length > 0 && <div className="text-[11px] text-white/40 text-center truncate">{v.moves.length} moves • last {v.moves[v.moves.length - 1]}</div>}
            {playing && (
              <div className="flex justify-center mt-2">
                <button onClick={() => setAskResign(true)} className="pill px-4 py-2 text-xs font-semibold bg-white/10 text-white/80 inline-flex items-center gap-1.5"><Flag size={14} /> Resign</button>
              </div>
            )}
          </>
        )}
      </div>

      {askResign && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-6" onClick={() => setAskResign(false)}>
          <div className="w-full max-w-[360px] rounded-3xl bg-[#0d1230] border border-white/10 p-6 text-center pop" onClick={(e) => e.stopPropagation()}>
            <div className="text-xl font-semibold">Resign this game?</div>
            <div className="text-sm text-white/60 mt-1">Your friend wins and your entry of {inr(v?.entry ?? entry)} is not returned.</div>
            <div className="grid grid-cols-2 gap-3 mt-5">
              <button onClick={() => setAskResign(false)} className="py-3 rounded-2xl bg-white/10 font-semibold">Keep playing</button>
              <button onClick={leave} className="py-3 rounded-2xl bg-rose-500 font-semibold">Resign</button>
            </div>
          </div>
        </div>
      )}
      {v?.status === "done" && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-6">
          <div className="w-full max-w-[360px] rounded-3xl bg-[#0d1230] border border-white/10 p-6 text-center pop">
            <div className="inline-grid place-items-center w-20 h-20 rounded-full" style={{ background: won ? "radial-gradient(circle,#fde68a,#f59e0b)" : "rgba(255,255,255,.08)" }}>
              {won ? <Trophy size={40} className="text-amber-900" /> : <span className="text-4xl">{v.outcome === "draw" ? "🤝" : "😔"}</span>}
            </div>
            <div className="text-2xl font-semibold mt-3">{v.outcome === "draw" ? "Draw — entry returned" : won ? `You won ${inr(v.prize)}!` : `${v.outcome ? v.names[v.outcome] ?? "Your friend" : "Your friend"} wins`}</div>
            {v.reason && <div className="text-sm text-white/60 mt-1">{REASON[v.reason] ?? v.reason}</div>}
            <button onClick={() => { clearActive(); nav.back(); }} className="btn-green w-full py-3 rounded-2xl mt-5">Back to lobby</button>
          </div>
        </div>
      )}
    </div>
  );
}
