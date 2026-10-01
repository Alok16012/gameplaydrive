"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownUp, Layers, LogOut, Users } from "lucide-react";
import { inr, type Card } from "../../lib/data";
import { KIND_LABEL, cardPoints, scoreGroups, type RCard } from "../../lib/rummyRules";
import { useStore } from "../../lib/store";
import { errText, fire, joinOnce, supabase } from "../../lib/supabase";
import { Header, Money, PlayingCard, Sheet } from "../ui";
import { BotTag, ResultSheet, TimerAvatar } from "./bots";
import type { Nav, RummyMode } from "../nav";

// 13 Card Rummy on the game server (supabase/migrations/003_teen_patti_rummy.sql). The server deals from two
// decks, runs every player's 30 s clock, validates declarations, scores hands, plays the bots and settles coins.
// This screen renders the table, keeps your own card arrangement (saved to the server so it counts if someone
// else declares) and sends actions.

export const MODE_LABEL: Record<RummyMode, string> = { points: "Points Rummy", pool101: "Pool 101", pool201: "Pool 201", deals: "Deals Rummy" };

interface Seat {
  uid?: string; name: string; emoji: string; bot: boolean; bal: number; in_match?: boolean; playing?: boolean; dropped?: boolean; middle?: boolean;
  wrong?: boolean; out?: boolean; score?: number; action?: string | null; left?: boolean; picked?: number | null; turns?: number;
}
interface Row { seat: number; name: string; bot: boolean; uid?: string; pts: number | null; score: number; note: string; out: boolean; coins: number | null; hand: RCard[][] | null }
interface Result { winner: number; winner_name: string; rows: Row[]; match_over: boolean; champion: number | null; champion_name: string | null; prize: number; deal_no: number; wild: Card; rake: number }
interface View {
  id: string; mode: RummyMode; stake: number; deals: number; code: string | null; status: "waiting" | "playing" | "dealdone";
  match_no: number; deal_no: number; round: number; turn: number | null; phase: "draw" | "discard" | null; turn_ends: string | null; next_at: string | null;
  wild: Card | null; open_top: RCard | null; stock_count: number; prize: number; match_over: boolean; result: Result | null; seats: Seat[];
  queued: boolean; me: number | null; my_cards: RCard[] | null; my_groups: number[][] | null; due_at: string | null; turn_secs: number; server_now: string;
}

const dropPts = (mode: RummyMode, middle: boolean) => (mode === "pool201" ? (middle ? 50 : 25) : middle ? 40 : 20);

export function RummyOnline({ nav, mode: askedMode, stake: askedStake, deals: askedDeals, code }: { nav: Nav; mode: RummyMode; stake: number; deals: number; code?: string }) {
  const { total, showToast, applyBalance } = useStore();
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [groups, setGroups] = useState<number[][]>([]);
  const [sel, setSel] = useState<number[]>([]);
  const [confirm, setConfirm] = useState<"declare" | "drop" | null>(null);
  const [sheetFor, setSheetFor] = useState("");
  const [peek, setPeek] = useState(false);
  const tableId = useRef<string | null>(null);
  const offset = useRef(0);
  const ticking = useRef(false);
  const dealKey = useRef("");
  const saveTimer = useRef<number | null>(null);

  const take = useCallback((view: View) => {
    offset.current = new Date(view.server_now).getTime() - Date.now();
    setV(view);
    const mine = view.me !== null ? view.seats[view.me] : null;
    if (mine && !mine.bot) applyBalance(mine.bal);
  }, [applyBalance]);

  const tick = useCallback(async () => {
    if (!tableId.current || ticking.current) return;
    ticking.current = true;
    const { data, error } = await supabase().rpc("rm_tick", { p_table: tableId.current });
    ticking.current = false;
    if (error) setErr(errText(error));
    else take(data as View);
  }, [take]);

  const pull = useCallback(async () => {
    if (!tableId.current) return;
    const { data } = await supabase().rpc("rm_state", { p_table: tableId.current });
    if (data) take(data as View);
  }, [take]);

  // Join (or rejoin) the table, follow it live, leave when the screen closes.
  useEffect(() => {
    let alive = true;
    const sb = supabase();
    let channel: ReturnType<typeof sb.channel> | null = null;
    (async () => {
      const { data, error } = await joinOnce("rm_join", { p_mode: askedMode, p_stake: askedStake, p_deals: askedMode === "deals" ? askedDeals : 0, p_code: code ?? null });
      if (!alive) return;
      if (error) return setErr(errText(error));
      tableId.current = data as string;
      channel = sb
        .channel(`rm-${data}`)
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "rm_tables", filter: `id=eq.${data}` }, () => pull())
        .subscribe();
      tick();
    })();
    const heartbeat = setInterval(() => tick(), 15000);
    const poll = setInterval(() => pull(), 3000);
    return () => {
      alive = false;
      clearInterval(heartbeat);
      clearInterval(poll);
      if (channel) sb.removeChannel(channel);
      // Closing the screen (reload, crash, lost connection) does not leave the table: the turn clock covers an
      // absent player and they can come back. Leaving is an explicit action (see leave()).
    };
  }, [askedMode, askedStake, askedDeals, code, pull, tick]);

  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      if (v?.due_at && Date.now() + offset.current >= new Date(v.due_at).getTime() + 150) tick();
    }, 250);
    return () => clearInterval(t);
  }, [v?.due_at, tick]);

  // Keep my arrangement in step with the cards the server says I hold.
  useEffect(() => {
    const cards = v?.my_cards;
    if (!v || !cards) return;
    const key = `${v.match_no}:${v.deal_no}`;
    const ids = new Set(cards.map((c) => c.id));
    setGroups((gs) => {
      let base = gs;
      if (dealKey.current !== key) {
        dealKey.current = key;
        base = v.my_groups?.length ? v.my_groups : [cards.map((c) => c.id)];
        setSel([]);
      }
      const kept = base.map((g) => g.filter((id) => ids.has(id))).filter((g) => g.length);
      const placed = new Set(kept.flat());
      const fresh = cards.filter((c) => !placed.has(c.id)).map((c) => c.id);
      if (!fresh.length) return kept;
      return kept.length ? [...kept.slice(0, -1), [...kept[kept.length - 1], ...fresh]] : [fresh];
    });
  }, [v]);

  // Save the arrangement (debounced) so it's used for my score if someone else declares.
  const save = useCallback((gs: number[][]) => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      if (tableId.current) fire(supabase().rpc("rm_arrange", { p_table: tableId.current, p_groups: gs }));
    }, 800);
  }, []);
  const arrange = (gs: number[][]) => { setGroups(gs); save(gs); };

  // Show the scoreboard a moment after the deal ends.
  useEffect(() => {
    if (v?.status !== "dealdone" || !v.result) return;
    const key = `${v.match_no}:${v.deal_no}`;
    const t = setTimeout(() => { setSheetFor(key); setPeek(false); }, 1800);
    return () => clearTimeout(t);
  }, [v?.status, v?.match_no, v?.deal_no, v?.result]);

  const leave = () => {
    if (tableId.current) fire(supabase().rpc("rm_leave", { p_table: tableId.current }));
    nav.back();
  };

  const act = async (action: string, card?: number, gs?: number[][]) => {
    if (!tableId.current || busy) return;
    setBusy(true);
    const { data, error } = await supabase().rpc("rm_act", { p_table: tableId.current, p_action: action, p_card: card ?? null, p_groups: gs ?? null });
    setBusy(false);
    if (error) return showToast(errText(error));
    setSel([]);
    take(data as View);
  };

  // A private table's format comes from the table itself.
  const mode = v?.mode ?? askedMode;
  const stake = v?.stake ?? askedStake;
  const deals = v?.deals || askedDeals;
  const byId = useMemo(() => new Map((v?.my_cards ?? []).map((c) => [c.id, c])), [v?.my_cards]);
  const cardGroups = groups.map((g) => g.map((id) => byId.get(id)).filter(Boolean) as RCard[]);
  const wild = v?.wild?.r ?? "";
  const sc = scoreGroups(cardGroups, wild);
  const serverNow = now + offset.current;
  const secsTo = (iso: string | null) => (iso ? Math.max(0, (new Date(iso).getTime() - serverNow) / 1000) : 0);

  if (err && !v) {
    return (
      <div className="min-h-dvh flex flex-col fadein">
        <Header title="Rummy" sub={MODE_LABEL[askedMode]} onBack={leave} />
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
  const others = v ? (me !== null ? Array.from({ length: n - 1 }, (_, k) => (me + 1 + k) % n) : v.seats.map((_, i) => i)) : [];
  const playing = v?.status === "playing";
  const inDeal = playing && !!mySeat?.playing && !mySeat.dropped && !mySeat.wrong;
  const myTurn = inDeal && v?.turn === me;
  const turnSecs = v?.turn_secs ?? 30;
  const pool = v?.mode === "pool101" ? 101 : v?.mode === "pool201" ? 201 : null;
  const res = v?.result ?? null;
  const key = v ? `${v.match_no}:${v.deal_no}` : "";
  const humans = v ? v.seats.filter((s) => !s.bot && !s.left).length : 0;
  const stakeText = mode === "points" ? `${inr(stake)}/point` : `Entry ${inr(stake)}`;
  const scoreText = (s: Seat) => (!v || v.mode === "points" || !s.in_match ? null : v.mode === "deals" ? `${(s.score ?? 0) >= 0 ? "+" : ""}${s.score ?? 0}` : `${s.score ?? 0}/${pool}`);
  const toggle = (id: number) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const iWonMatch = !!res && res.match_over && res.champion === me;
  const iWonDeal = !!res && res.winner === me;
  const myRow = res?.rows.find((r) => r.seat === me);

  const sortHand = () => {
    const all = (v?.my_cards ?? []).slice();
    const suits = ["♠", "♥", "♦", "♣"];
    const low = (c: Card) => ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"].indexOf(c.r);
    arrange(suits.map((s) => all.filter((c) => c.s === s && c.r !== wild).sort((a, b) => low(a) - low(b)).map((c) => c.id)).concat([all.filter((c) => c.r === wild).map((c) => c.id)]).filter((g) => g.length));
    setSel([]);
  };
  const makeGroup = () => {
    if (sel.length < 2) return showToast("Select 2 or more cards to group");
    arrange([...groups.map((g) => g.filter((id) => !sel.includes(id))).filter((g) => g.length), sel]);
    setSel([]);
  };
  const declareGroups = () => groups.map((g) => g.filter((id) => id !== sel[0])).filter((g) => g.length);

  return (
    <div className="min-h-dvh flex flex-col pb-5 fadein">
      <Header
        title="Rummy"
        sub={`${MODE_LABEL[mode]}${mode === "deals" ? ` ×${deals}` : ""}${v?.deal_no && mode !== "points" ? ` • Deal ${v.deal_no}` : ""} • ${stakeText}`}
        onBack={leave}
        right={<div className="flex items-center gap-2"><Money n={total} className="text-sm font-semibold text-neon-400" /><Users size={16} className="text-white/60" /><span className="text-sm text-white/60">{humans}</span></div>}
      />

      {v?.code && (
        <div className="mx-3 mb-2 rounded-xl bg-white/5 px-3 py-2 text-sm flex items-center justify-between">
          <span>Private table • code <b className="tracking-widest text-gold-300">{v.code}</b></span>
          <button onClick={() => { navigator.clipboard?.writeText(v.code!); showToast("Code copied"); }} className="text-neon-400">Copy</button>
        </div>
      )}

      <div className="px-2">
        <div className="grid grid-cols-5 gap-1">
          {v && others.slice(0, 5).map((si) => {
            const b = v.seats[si];
            if (!b) return <div key={si} />;
            const active = playing && v.turn === si;
            const outOfDeal = !b.playing || b.dropped || b.wrong || b.out;
            return (
              <div key={si + (b.uid ?? b.name)} className="flex flex-col items-center min-w-0">
                <TimerAvatar emoji={b.emoji} size={38} active={active} left={active ? secsTo(v.turn_ends) : 0} dim={outOfDeal || b.left} total={turnSecs} />
                <div className={`text-[12px] mt-1.5 font-medium truncate max-w-full ${active ? "text-neon-400" : ""}`}>{b.name}</div>
                {b.bot && <BotTag />}
                {scoreText(b) && <div className="text-[10.5px] text-gold-300 leading-tight">{scoreText(b)}</div>}
                {b.out ? (
                  <div className="text-[10px] pill px-1.5 py-0.5 mt-0.5 bg-white/10 text-white/60 font-semibold">OUT</div>
                ) : b.dropped || b.wrong ? (
                  <div className="text-[10px] pill px-1.5 py-0.5 mt-0.5 bg-rose-500/25 text-rose-200 font-semibold">{(b.action ?? "Dropped").toUpperCase()}</div>
                ) : (
                  <>
                    <div className="flex -space-x-4 mt-0.5 scale-[.6] origin-top h-5">{b.playing && playing && Array.from({ length: 4 }, (_, j) => <PlayingCard key={j} faceDown size="xs" />)}</div>
                    <div className={`text-[10.5px] leading-tight text-center h-5 ${active ? "text-white" : "text-white/45"}`}>{playing ? b.action ?? "" : ""}</div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="felt rounded-[36px] mt-4 mx-2 p-4 flex items-center justify-center gap-5" style={{ minHeight: 150 }}>
          {!v || v.status === "waiting" ? (
            <div className="text-center">
              <div className="text-sm font-semibold">{v?.code ? "Waiting for friends…" : "Finding players…"}</div>
              <div className="text-sm text-white/70 mt-1">
                {v?.next_at ? `Dealing in ${Math.ceil(secsTo(v.next_at))}s` : v?.code ? "A private table starts when 2 players are in" : ""}
              </div>
            </div>
          ) : v.status === "dealdone" && res ? (
            <div className="text-center fadein">
              <div className="text-sm font-semibold">{iWonDeal ? "You declared!" : `${res.winner_name} ${res.rows.find((r) => r.seat === res.winner)?.note === "Declared" ? "declared" : "wins"}`}</div>
              {res.match_over && mode !== "points" && <div className="text-[13px] text-gold-300 mt-0.5">{iWonMatch ? "You win the match!" : `${res.champion_name} wins the match`}</div>}
              <div className="text-[13px] text-white/70 mt-1">{res.match_over ? "Next game" : `Deal ${v.deal_no + 1}`} in {Math.ceil(secsTo(v.next_at))}s</div>
            </div>
          ) : (
            <>
              <button disabled={!myTurn || v.phase !== "draw" || busy} onClick={() => act("draw_stock")} className="flex flex-col items-center gap-1">
                <div className={`relative ${myTurn && v.phase === "draw" ? "ring-2 ring-neon-400 rounded-lg" : ""}`}><PlayingCard faceDown size="md" /><PlayingCard faceDown size="md" className="absolute -top-1 -left-1" /></div>
                <span className="text-[12px] text-white/70">Closed ({v.stock_count})</span>
              </button>
              <button disabled={!myTurn || v.phase !== "draw" || busy || !v.open_top || v.open_top.r === wild} onClick={() => act("draw_open")} className="flex flex-col items-center gap-1">
                {v.open_top ? <PlayingCard key={v.open_top.id} card={v.open_top} size="md" className="flip" /> : <div className="w-12 h-[68px] rounded-lg border-2 border-dashed border-white/30" />}
                <span className="text-[12px] text-white/70">Open</span>
              </button>
              {v.wild && (
                <div className="flex flex-col items-center gap-1">
                  <PlayingCard card={v.wild} size="sm" className="ring-2 ring-gold-300" />
                  <span className="text-[12px] text-gold-300">Wild Joker</span>
                </div>
              )}
            </>
          )}
        </div>

        {playing && v && (
          <div className="mt-2 text-center text-sm h-5">
            {!inDeal ? (
              <span className="text-white/60">{mySeat?.out ? "You're out of this match — watching" : mySeat?.dropped ? "You dropped — waiting for this deal to finish" : mySeat?.wrong ? "Wrong show (80 points) — waiting for this deal to finish" : v.queued ? "You'll join from the next game" : "Watching"}</span>
            ) : myTurn ? (
              <span className={secsTo(v.turn_ends) <= 8 ? "text-rose-400 font-semibold" : "text-neon-400"}>
                Your turn • {v.phase === "draw" ? "draw from Closed or Open" : "select a card to discard, or declare"} • {Math.ceil(secsTo(v.turn_ends))}s
              </span>
            ) : v.turn !== null ? (
              <span className="text-white/70">{v.seats[v.turn]?.name}&apos;s turn • {Math.ceil(secsTo(v.turn_ends))}s</span>
            ) : null}
          </div>
        )}
      </div>

      {/* My hand */}
      {v && mySeat && !mySeat.playing && v.status !== "waiting" && mySeat.action === "Not enough coins" ? (
        <div className="text-center mt-8">
          <div className="text-sm text-white/70">You need {inr(mode === "points" ? stake * 80 : stake)} to play this table</div>
          <button onClick={() => nav.push({ name: "addcash" })} className="btn-green pill px-6 py-2.5 mt-2 text-sm">Get Coins</button>
        </div>
      ) : (
        <div className={`px-2 mt-3 flex flex-wrap gap-x-3 gap-y-5 justify-center min-h-[130px] ${!inDeal && playing ? "opacity-40" : ""}`}>
          {v?.status !== "waiting" && mySeat?.playing && cardGroups.map((g, gi) => (
            <div key={gi} className="flex flex-col items-center">
              <div className={`text-[11px] pill px-2 py-0.5 mb-2 ${sc.kinds[gi] === "invalid" ? "bg-rose-500/20 text-rose-300" : "bg-neon-400/15 text-neon-400"}`}>
                {KIND_LABEL[sc.kinds[gi]]}{sc.kinds[gi] !== "invalid" ? " ✓" : ` • ${g.reduce((a, c) => a + cardPoints(c, wild), 0)}`}
              </div>
              <div className="flex pl-6">
                {g.map((c) => (
                  <PlayingCard key={c.id} card={c} size="md" selected={sel.includes(c.id)} onClick={() => toggle(c.id)} className={`-ml-6 ${c.r === wild ? "outline-2 outline-gold-300" : ""}`} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {inDeal && v && (
        <div className="px-3 mt-auto pt-4">
          <div className="text-center text-[13px] text-white/50 mb-2">
            Points in hand: <b className="text-white">{sc.points}</b>{sc.valid && <b className="text-neon-400"> • ready to declare</b>} • {v.my_cards?.length ?? 0} cards
            {pool ? <> • You {mySeat?.score ?? 0}/{pool}</> : mode === "deals" ? <> • Chips {scoreText(mySeat!)}</> : <> • {inr(stake)}/pt</>}
          </div>
          <div className="grid grid-cols-5 gap-1.5 text-[13px]">
            <button onClick={sortHand} className="btn-ghost rounded-xl py-2.5 flex flex-col items-center gap-0.5"><ArrowDownUp size={15} />Sort</button>
            <button onClick={makeGroup} className="btn-ghost rounded-xl py-2.5 flex flex-col items-center gap-0.5"><Layers size={15} />Group</button>
            <button disabled={!myTurn || v.phase !== "discard" || sel.length !== 1 || busy} onClick={() => act("discard", sel[0])} className="rounded-xl py-2.5 bg-sky-500 font-semibold disabled:opacity-40">Discard</button>
            <button disabled={!myTurn || v.phase !== "draw" || busy} onClick={() => setConfirm("drop")} className="rounded-xl py-2.5 bg-[#1b2350] border border-white/10 disabled:opacity-40">Drop</button>
            <button disabled={!myTurn || v.phase !== "discard" || sel.length !== 1 || busy} onClick={() => setConfirm("declare")} className="btn-green rounded-xl py-2.5">Declare</button>
          </div>
          {myTurn && v.phase === "discard" && <div className="text-center text-[12px] text-white/40 mt-2">To declare: arrange your groups, select the one card to put aside, then tap Declare.</div>}
        </div>
      )}
      <button onClick={leave} className="mx-auto mt-3 text-[13px] text-white/50 flex items-center gap-1"><LogOut size={12} /> Leave table{mode !== "points" && inDeal ? " (counts as a drop and forfeits the match)" : ""}</button>

      <Sheet open={confirm !== null} onClose={() => setConfirm(null)} title={confirm === "drop" ? "Drop this deal?" : "Declare?"}>
        {confirm === null ? null : confirm === "drop" ? (
          <div className="text-sm text-[var(--ink-soft)]">
            You&apos;ll take <b className="text-white">{dropPts(mode, (mySeat?.turns ?? 0) > 0)} points</b> and sit out the rest of this deal.
            <div className="grid grid-cols-2 gap-3 mt-5">
              <button onClick={() => setConfirm(null)} className="btn-ghost py-3 rounded-2xl">Cancel</button>
              <button onClick={() => { setConfirm(null); act("drop"); }} className="rounded-2xl py-3 bg-rose-500 font-semibold">Drop</button>
            </div>
          </div>
        ) : (
          <div className="text-sm text-[var(--ink-soft)]">
            {(() => {
              const d = scoreGroups(declareGroups().map((g) => g.map((id) => byId.get(id)).filter(Boolean) as RCard[]), wild);
              return d.valid
                ? <>Your 13 cards form a valid hand. The selected card goes to the open pile.</>
                : <span className="text-rose-300">These groups are not a valid declaration. A wrong show costs 80 points.</span>;
            })()}
            <div className="grid grid-cols-2 gap-3 mt-5">
              <button onClick={() => setConfirm(null)} className="btn-ghost py-3 rounded-2xl">Cancel</button>
              <button onClick={() => { setConfirm(null); act("declare", sel[0], declareGroups()); }} className="btn-green py-3 rounded-2xl">Declare</button>
            </div>
          </div>
        )}
      </Sheet>

      {res && v && (
        <ResultSheet
          open={v.status === "dealdone" && sheetFor === key && !peek}
          won={res.match_over ? iWonMatch : iWonDeal}
          title={
            res.match_over && mode !== "points"
              ? iWonMatch ? `You won ${inr(res.prize)}!` : `${res.champion_name} wins the match`
              : iWonDeal ? (mode === "points" ? `You won ${inr(res.prize)}!` : "You won this deal!") : `${res.winner_name} wins`
          }
          sub={mode === "points" ? (myRow && !iWonDeal ? `You lose ${myRow.pts} points = ${inr(Math.abs(myRow.coins ?? 0))}` : `Deal ${res.deal_no}`) : res.match_over ? `Prize ${inr(res.prize)}` : `Deal ${res.deal_no}${pool ? ` • over ${pool} points is out` : ` of ${v.deals}`}`}
          left={Math.ceil(secsTo(v.next_at))}
          nextLabel={res.match_over || mode === "points" ? "Next game starts in" : `Deal ${v.deal_no + 1} starts in`}
          onLeave={leave}
          onClose={() => setPeek(true)}
        >
          <div className="mt-4 rounded-xl bg-white/5 overflow-hidden text-left">
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-3 py-2 text-[12px] text-white/50 border-b border-white/5">
              <span>Player</span><span className="text-right">Points</span><span className="text-right w-16">{mode === "points" ? "Coins" : mode === "deals" ? "Chips" : "Total"}</span>
            </div>
            {res.rows.map((r) => (
              <div key={r.seat} className={`grid grid-cols-[1fr_auto_auto] gap-x-4 px-3 py-1.5 text-sm ${r.seat === me ? "bg-neon-400/10" : ""}`}>
                <span className="truncate">{r.seat === res.winner && "🏆 "}{r.seat === me ? "You" : r.name}{r.bot && <BotTag />} <span className="text-[12px] text-white/40">{r.note}</span></span>
                <span className="text-right tabular-nums">{r.pts ?? "—"}</span>
                <span className={`text-right tabular-nums w-16 ${r.out ? "text-rose-300" : ""}`}>
                  {mode === "points" ? (r.coins === null ? "—" : `${r.coins >= 0 ? "+" : "-"}${inr(r.coins)}`) : mode === "deals" ? `${r.score >= 0 ? "+" : ""}${r.score}` : r.out ? `${r.score} out` : r.score}
                </span>
              </div>
            ))}
          </div>
          {res.rows.find((r) => r.seat === res.winner)?.hand && (
            <div className="mt-3">
              <div className="text-[12px] text-white/50 mb-1">{res.winner === me ? "Your" : `${res.winner_name}'s`} hand</div>
              <div className="flex flex-wrap gap-2 justify-center">
                {res.rows.find((r) => r.seat === res.winner)!.hand!.map((g, i) => (
                  <div key={i} className="flex -space-x-3">{g.map((c) => <PlayingCard key={c.id} card={c} size="xs" />)}</div>
                ))}
              </div>
            </div>
          )}
          <div className="text-[12px] text-white/40 mt-2">Platform fee {res.rake}%</div>
        </ResultSheet>
      )}
    </div>
  );
}
