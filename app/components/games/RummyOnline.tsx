"use client";

import { clearActive } from "../../lib/rejoin";
import { dealSound, sfx, useSoundOnRise } from "../../lib/sound";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownUp, ChevronLeft, Hand, Layers, ListOrdered, Menu, Plus } from "lucide-react";
import { inr, type Card } from "../../lib/data";
import { KIND_LABEL, cardPoints, scoreGroups, type RCard, isJoker, wildKey } from "../../lib/rummyRules";
import { useStore } from "../../lib/store";
import { errText, fire, joinOnce, supabase } from "../../lib/supabase";
import { Header, Money, PlayingCard, Sheet } from "../ui";
import { BotTag, DealerChip, ResultSheet, TimerAvatar, dealerSeat } from "./bots";
import { LandscapeStage } from "./LandscapeStage";
import type { Nav, RummyMode } from "../nav";

// 13 and 21 Card Rummy on the game server (migrations 003 and 011). The server deals from two (21 cards: three)
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
/** One turn on the table (server move log): where the card came from and what was thrown; or the deck reshuffle. */
interface Move { seat?: number; name?: string; src?: "open" | "closed"; took?: RCard | null; threw?: RCard; reshuffle?: boolean }
interface View {
  id: string; mode: RummyMode; stake: number; deals: number; code: string | null; status: "waiting" | "playing" | "dealdone";
  match_no: number; deal_no: number; round: number; turn: number | null; phase: "draw" | "discard" | null; turn_ends: string | null; next_at: string | null;
  wild: Card | null; open_top: RCard | null; stock_count: number; prize: number; match_over: boolean; result: Result | null; seats: Seat[];
  queued: boolean; me: number | null; my_cards: RCard[] | null; my_groups: number[][] | null; due_at: string | null; turn_secs: number; server_now: string;
  discards?: RCard[]; log?: Move[]; open_joker_ok?: boolean; // public table info (migration 024)
}

const cardTxt = (c?: RCard | null) => (c ? `${c.r}${c.s ?? ""}` : "");
const moveTxt = (m: Move, me: number | null) =>
  m.reshuffle ? "Closed deck ran out — open pile reshuffled into it"
  : `${m.seat === me ? "You" : m.name}: ${m.src === "open" ? `picked ${cardTxt(m.took)} from Open` : "drew from Closed"} • threw ${cardTxt(m.threw)}`;

const dropPts = (mode: RummyMode, middle: boolean) => (mode === "pool201" ? (middle ? 50 : 25) : middle ? 40 : 20);

export function RummyOnline({ nav, mode: askedMode, stake: askedStake, deals: askedDeals, code, cards = 13, avoid }: { nav: Nav; mode: RummyMode; stake: number; deals: number; code?: string; cards?: 13 | 21; avoid?: string }) {
  const maxPts = cards === 21 ? 120 : 80;
  const gameName = cards === 21 ? "21 Card Rummy" : "Rummy";
  const { total, showToast, applyBalance } = useStore();
  const [v, setV] = useState<View | null>(null);
  // Sounds: the deal, then every card you pick up.
  useSoundOnRise(v ? v.match_no * 1000 + v.deal_no : 0, () => dealSound(8, 90));
  useSoundOnRise(v?.my_cards?.length ?? 0, sfx.card);
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
  const [drag, setDrag] = useState<{ id: number; gi: number; ci: number; x0: number; y0: number; dx: number; dy: number; moving: boolean; over: "discard" | "show" | null } | null>(null);
  const openRef = useRef<HTMLButtonElement | null>(null);
  const showRef = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState(false);
  const [moves, setMoves] = useState(false);
  // Scoreboard and the last deal: kept after the next deal starts, so you can look back any time.
  const [scores, setScores] = useState(false);
  const [lastOpen, setLastOpen] = useState(false);
  const [lastRes, setLastRes] = useState<Result | null>(null);
  // The table scales with the stage: 1 = a typical phone held sideways (844 × 390).
  const [stage, setStage] = useState({ w: 844, h: 390 });
  const ro = useRef<ResizeObserver | null>(null);
  const stageEl = useRef<HTMLDivElement | null>(null);
  const stageRef = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    stageEl.current = el;
    if (!el) return;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    ro.current = new ResizeObserver(measure);
    ro.current.observe(el);
  }, []);
  const S = Math.max(0.8, Math.min(1.8, Math.min(stage.w / 844, stage.h / 390)));

  const take = useCallback((view: View) => {
    offset.current = new Date(view.server_now).getTime() - Date.now();
    setV(view);
    const mine = view.me !== null ? view.seats[view.me] : null;
    if (mine && !mine.bot) applyBalance(mine.bal);
  }, [applyBalance]);

  // Cards in flight: every draw (closed deck / open pile → the player) and every throw (player → open pile)
  // is shown travelling across the table, one after another, instead of jumping into place.
  interface Pt { x: number; y: number }
  interface Flight { key: number; card: RCard | null; from: Pt; to: Pt; go: boolean }
  const FLY_MS = 620;
  const [flights, setFlights] = useState<Flight[]>([]);
  const [pileHold, setPileHold] = useState<{ card: RCard | null } | null>(null); // open pile as it was until a throw lands
  const [hidden, setHidden] = useState<number[]>([]); // your new card, until it lands in your hand
  const flightSeq = useRef(0);
  const prevV = useRef<View | null>(null);
  const drawnSeat = useRef<number | null>(null); // a draw already shown whose throw hasn't come yet
  const throwFrom = useRef<Pt | null>(null); // where your thrown card was in your hand
  const deckRef = useRef<HTMLButtonElement | null>(null);
  /** Centre of an element in stage coordinates (the stage may be turned 90° on an upright phone). */
  const ptOf = (el: Element | null | undefined): Pt | null => {
    const st = stageEl.current;
    if (!el || !st) return null;
    const r = el.getBoundingClientRect(), b = st.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    return st.closest(".stage-rotated") ? { x: cy - b.top, y: b.right - cx } : { x: cx - b.left, y: cy - b.top };
  };
  const fly = (card: RCard | null, from: Pt | null, to: Pt | null) => {
    if (!from || !to) return;
    const key = ++flightSeq.current;
    setFlights((f) => [...f, { key, card, from, to, go: false }]);
    window.setTimeout(() => setFlights((f) => f.map((x) => (x.key === key ? { ...x, go: true } : x))), 30);
    window.setTimeout(() => setFlights((f) => f.filter((x) => x.key !== key)), FLY_MS + 80);
  };

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
      const args = { p_mode: askedMode, p_stake: askedStake, p_deals: askedMode === "deals" ? askedDeals : 0, p_code: code ?? null, p_cards: cards };
      // "Join another table": skip the table just left (needs 030_rummy_join_another.sql; without it, join as before).
      let { data, error } = await joinOnce("rm_join", avoid ? { ...args, p_avoid: avoid } : args);
      if (error && avoid && /rm_join|function|schema cache/i.test(errText(error))) ({ data, error } = await joinOnce("rm_join", args));
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

  // Work out what happened since the last update and play it as flights.
  useEffect(() => {
    const prev = prevV.current;
    prevV.current = v;
    if (!v || !prev || v.status !== "playing" || prev.status !== "playing" || prev.match_no !== v.match_no || prev.deal_no !== v.deal_no) {
      drawnSeat.current = null;
      return;
    }
    type Ev = { kind: "draw"; seat: number; src: "open" | "closed"; card: RCard | null } | { kind: "throw"; seat: number; card: RCard };
    const evs: Ev[] = [];
    if (v.log) {
      for (const m of v.log.slice(prev.log?.length ?? 0)) {
        if (m.reshuffle || m.seat == null) continue;
        if (drawnSeat.current !== m.seat) evs.push({ kind: "draw", seat: m.seat, src: m.src ?? "closed", card: m.src === "open" ? m.took ?? null : null });
        drawnSeat.current = null;
        if (m.threw) evs.push({ kind: "throw", seat: m.seat, card: m.threw });
      }
    } else if (v.open_top && v.open_top.id !== prev.open_top?.id && prev.phase === "discard" && prev.turn !== null) {
      if (drawnSeat.current !== prev.turn) evs.push({ kind: "draw", seat: prev.turn, src: "closed", card: null });
      drawnSeat.current = null;
      evs.push({ kind: "throw", seat: prev.turn, card: v.open_top });
    }
    // A draw whose throw is still to come.
    if (v.phase === "discard" && v.turn !== null && (prev.turn !== v.turn || prev.phase === "draw") && drawnSeat.current !== v.turn) {
      const src = v.stock_count < prev.stock_count ? "closed" : "open";
      evs.push({ kind: "draw", seat: v.turn, src, card: src === "open" ? prev.open_top : null });
      drawnSeat.current = v.turn;
    }
    if (!evs.length) return;

    const prevIds = new Set((prev.my_cards ?? []).map((c) => c.id));
    const fresh = (v.my_cards ?? []).filter((c) => !prevIds.has(c.id)).map((c) => c.id);
    if (fresh.length) setHidden(fresh);
    const throws = evs.filter((e) => e.kind === "throw").length;
    if (throws) setPileHold({ card: v.discards?.[throws] ?? (evs[0].kind === "draw" && evs[0].src === "open" ? null : prev.open_top) });

    const seatPt = (seat: number): Pt | null => {
      if (seat === v.me) return { x: stage.w / 2, y: stage.h - 40 * S };
      return ptOf(stageEl.current?.querySelector(`[data-rc-seat="${seat}"]`));
    };
    let t = 0;
    let thrown = 0;
    for (const e of evs) {
      window.setTimeout(() => {
        if (e.kind === "draw") {
          const from = ptOf(e.src === "open" ? openRef.current : deckRef.current);
          const mineCard = e.seat === v.me && fresh.length ? stageEl.current?.querySelector(`[data-rc-card="${fresh[0]}"]`) : null;
          fly(e.seat === v.me && fresh.length ? (v.my_cards ?? []).find((c) => c.id === fresh[0]) ?? e.card : e.card, from, ptOf(mineCard) ?? seatPt(e.seat));
          sfx.card();
          if (e.seat === v.me) window.setTimeout(() => setHidden([]), FLY_MS);
        } else {
          const from = e.seat === v.me ? throwFrom.current ?? seatPt(e.seat) : seatPt(e.seat);
          if (e.seat === v.me) throwFrom.current = null;
          fly(e.card, from, ptOf(openRef.current));
          thrown += 1;
          const last = thrown === throws;
          window.setTimeout(() => { sfx.flip(); if (last) setPileHold(null); }, FLY_MS);
        }
      }, t);
      t += FLY_MS + 140;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);

  useEffect(() => { if (v?.result) setLastRes(v.result); }, [v?.result]);

  // Show the scoreboard a moment after the deal ends.
  useEffect(() => {
    if (v?.status !== "dealdone" || !v.result) return;
    const key = `${v.match_no}:${v.deal_no}`;
    const t = setTimeout(() => { setSheetFor(key); setPeek(false); }, 1800);
    return () => clearTimeout(t);
  }, [v?.status, v?.match_no, v?.deal_no, v?.result]);

  // Back to the lobby without giving up the seat: the server keeps you at the table (your turn clock runs
  // as usual) and Home / the lobby offer Rejoin. Only "Leave table" gives the seat up.
  const away = () => {
    showToast("Your seat is kept — tap Rejoin to come back");
    nav.back();
  };

  // Dropped (or a wrong show): move on to another table at the same stake instead of sitting out.
  const [moving, setMoving] = useState(false);
  const joinAnother = async () => {
    if (moving) return;
    if (mode !== "points" && !window.confirm("Leaving now gives up this match — your entry is not returned. Join another table?")) return;
    setMoving(true);
    const old = tableId.current;
    // Leave first and wait for it — joining before the leave lands put you back at this same table.
    if (old) {
      const { error } = await supabase().rpc("rm_leave", { p_table: old });
      if (error) { setMoving(false); return showToast(errText(error)); }
    }
    clearActive();
    nav.back();
    nav.push({ name: "rummy", table: `S-${askedStake}-${Date.now() % 1000000}`, buyIn: askedStake, mode: askedMode, deals: askedDeals, cards, avoid: old ?? undefined });
  };

  const leave = () => {
    if (tableId.current) fire(supabase().rpc("rm_leave", { p_table: tableId.current }));
    clearActive();
    nav.back();
  };

  const act = async (action: string, card?: number, gs?: number[][]) => {
    if (!tableId.current || busy) return;
    if (action === "discard" && card != null) throwFrom.current = ptOf(stageEl.current?.querySelector(`[data-rc-card="${card}"]`));
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
  const wild = wildKey(v?.wild, cards); // "5" or, with 21 cards, "5:♥" (also 4♥/6♥) — see isJoker
  const sc = scoreGroups(cardGroups, wild);
  const serverNow = now + offset.current;
  const secsTo = (iso: string | null) => (iso ? Math.max(0, (new Date(iso).getTime() - serverNow) / 1000) : 0);

  if (err && !v) {
    return (
      <div className="min-h-dvh flex flex-col fadein">
        <Header title={gameName} sub={MODE_LABEL[askedMode]} onBack={leave} />
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
  // Seats round the table run anticlockwise, like a real Rummy table: the player after you sits on your right,
  // so the turn (and the dealer, deal to deal) moves right-to-left across the top.
  const others = v ? (me !== null ? Array.from({ length: n - 1 }, (_, k) => (me + n - 1 - k) % n) : v.seats.map((_, i) => i)) : [];
  const playing = v?.status === "playing";
  const inDeal = playing && !!mySeat?.playing && !mySeat.dropped && !mySeat.wrong;
  const myTurn = inDeal && v?.turn === me;
  // Dealer of this deal (the seat before the one who plays first), shown with a DEALER tag.
  const dealer = v && v.status !== "waiting" && v.deal_no > 0 ? dealerSeat(v.seats.map((s) => !!s.playing), v.match_no + v.deal_no) : null;
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
    arrange(suits.map((s) => all.filter((c) => c.s === s && !isJoker(c, wild)).sort((a, b) => low(a) - low(b)).map((c) => c.id)).concat([all.filter((c) => isJoker(c, wild)).map((c) => c.id)]).filter((g) => g.length));
    setSel([]);
  };
  // Move the selected cards into an existing group (tap a card or two, then "Move here" on the target group).
  const moveTo = (gi: number) => {
    if (!sel.length) return;
    const target = groups[gi];
    const rest = groups.map((g, i) => (i === gi ? g : g.filter((id) => !sel.includes(id))));
    rest[gi] = [...target.filter((id) => !sel.includes(id)), ...sel];
    arrange(rest.filter((g) => g.length));
    setSel([]);
  };
  const makeGroup = () => {
    if (!sel.length) return showToast("Select cards first, then tap Group");
    arrange([...groups.map((g) => g.filter((id) => !sel.includes(id))).filter((g) => g.length), sel]);
    setSel([]);
  };
  const declareGroups = () => groups.map((g) => g.filter((id) => id !== sel[0])).filter((g) => g.length);

  // Drag a card with your finger to rearrange the hand: drop it between cards of any group, or past the
  // last group to start a new one. A short tap still selects the card. Positions are worked out in the
  // table's own coordinates, so it behaves the same when the table is rotated on an upright phone.
  const toLocal = (sdx: number, sdy: number): [number, number] =>
    window.matchMedia("(orientation: portrait)").matches ? [sdy, -sdx] : [sdx, sdy];
  // On your discard turn, dragging a card up onto the open pile discards it, and onto the Show slot
  // declares with it. Hit-testing uses screen rectangles, so it works rotated too.
  const dropTarget = (x: number, y: number, dy: number): "discard" | "show" | null => {
    if (!(myTurn && v?.phase === "discard" && !busy)) return null;
    const hit = (el: HTMLElement | null, pad: number) => {
      const r = el?.getBoundingClientRect();
      return !!r && x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
    };
    if (hit(showRef.current, 12)) return "show";
    // The open pile, generously — or any card lifted well clear of the hand.
    if (hit(openRef.current, deckW * 0.8) || dy < -ch * 1.3) return "discard";
    return null;
  };
  const onCardDown = (e: React.PointerEvent, id: number, gi: number, ci: number) => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ id, gi, ci, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, moving: false, over: null });
  };
  const onCardMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const [dx, dy] = toLocal(e.clientX - drag.x0, e.clientY - drag.y0);
    const moving = drag.moving || Math.hypot(dx, dy) > 8;
    setDrag({ ...drag, dx, dy, moving, over: moving ? dropTarget(e.clientX, e.clientY, dy) : null });
  };
  const onCardUp = (e: React.PointerEvent) => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (!d.moving) return toggle(d.id);
    const over = dropTarget(e.clientX, e.clientY, d.dy);
    if (over === "discard") return act("discard", d.id);
    if (over === "show") { setSel([d.id]); return setConfirm("declare"); }
    // Where did the card's centre land, along the row of groups?
    const widths = groups.map((g) => cw + (g.length - 1) * cstep);
    const starts = widths.map((_, i) => widths.slice(0, i).reduce((a, w) => a + w + cgap, 0));
    const centre = starts[d.gi] + d.ci * cstep + cw / 2 + d.dx;
    let target = -1;
    for (let i = 0; i < groups.length; i++) if (centre >= starts[i] - cgap / 2 && centre <= starts[i] + widths[i] + cgap / 2) target = i;
    const without = groups.map((g) => g.filter((x) => x !== d.id));
    if (target === -1) {
      // Past either end: a new group of its own at that end.
      const left = centre < 0;
      const next = left ? [[d.id], ...without] : [...without, [d.id]];
      arrange(next.filter((g) => g.length));
    } else {
      const at = Math.max(0, Math.min(without[target].length, Math.round((centre - starts[target] - cw / 2) / cstep)));
      without[target] = [...without[target].slice(0, at), d.id, ...without[target].slice(at)];
      arrange(without.filter((g) => g.length));
    }
    setSel([]);
  };

  // Opponent seats along the top rim (centre points, % of the stage), picked to spread out by player count.
  const POS: [number, number][] = [[12, 41], [29, 29], [50, 25], [71, 29], [88, 41]];
  const PICK: Record<number, number[]> = { 1: [2], 2: [1, 3], 3: [1, 2, 3], 4: [0, 1, 3, 4], 5: [0, 1, 2, 3, 4] };
  const shownOthers = others.slice(0, 5);
  const slots = PICK[shownOthers.length] ?? [];

  // Hand geometry: big overlapping cards, shrunk only if the arrangement would not fit the table.
  const base = cards === 21 ? { w: 52, h: 74, step: 20, gap: 8 } : { w: 68, h: 96, step: 28, gap: 11 };
  const visibleGroups = v?.status !== "waiting" && mySeat?.playing ? cardGroups : [];
  const rawWidth = visibleGroups.reduce((a, g) => a + base.w + (g.length - 1) * base.step, 0) + Math.max(0, visibleGroups.length - 1) * base.gap;
  const hs = Math.min(S, rawWidth ? (stage.w * 0.94) / rawWidth : S);
  const cw = Math.round(base.w * hs), ch = Math.round(base.h * hs), cstep = Math.round(base.step * hs), cgap = Math.round(base.gap * hs);
  const deckW = Math.round(52 * S), deckH = Math.round(72 * S);
  const av = Math.round(46 * S);
  const canDiscard = myTurn && v?.phase === "discard" && sel.length === 1 && !busy;
  const tagText = (s: Seat, isMe: boolean) => {
    const name = isMe ? "You" : s.name;
    if (v && v.mode !== "points" && s.in_match) return `${v.mode === "deals" ? `${(s.score ?? 0) >= 0 ? "+" : ""}${s.score ?? 0}` : s.score ?? 0} pts • ${name}`;
    if (isMe && inDeal) return `${sc.points} pts • You`;
    return name;
  };

  return (
    <LandscapeStage className="rc-room">
      <div ref={stageRef} className="relative w-full h-full select-none overflow-hidden">
        {/* Felt: a wide oval running off the bottom of the screen */}
        <div className="absolute left-[6%] right-[6%] top-[31%] -bottom-[42%] rc-felt" />

        {/* Top bar */}
        <div className="absolute left-[7%] right-[7%] top-2 z-30 h-12 rounded-2xl bg-[#121512]/95 border border-white/10 flex items-center px-3 gap-3">
          <button onClick={away} aria-label="Back to lobby (seat kept)" className="w-9 h-9 grid place-items-center rounded-full hover:bg-white/10"><ChevronLeft size={24} /></button>
          <div className="flex-1 min-w-0 text-center leading-tight">
            <div className="text-[15px] font-semibold truncate">
              {cards === 21 ? "21 Card • " : ""}{mode === "pool101" ? "101 Pool" : mode === "pool201" ? "201 Pool" : mode === "deals" ? `Deals ×${deals}` : "Points"} • {mode === "points" ? `${inr(stake)}/pt` : inr(stake)}
              {mode !== "points" && v?.prize ? <> • 🏆 {inr(v.prize)}</> : null}
            </div>
            <div className="text-[11px] text-white/55 truncate">
              {v?.deal_no ? `Deal ${v.deal_no} • ` : ""}#{(v?.id ?? "").replace(/-/g, "").slice(0, 10).toUpperCase() || "—"}
              {v?.code && <button onClick={() => { navigator.clipboard?.writeText(v.code!); showToast("Code copied"); }} className="ml-1 text-gold-300 font-semibold tracking-widest">• Private {v.code} ⧉</button>}
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-white/25 pl-3 pr-1 py-1">
            <Money n={total} className="text-[14px] font-semibold" />
            <button onClick={() => nav.push({ name: "addcash" })} aria-label="Get coins" className="w-6 h-6 rounded-full bg-white text-black grid place-items-center"><Plus size={16} strokeWidth={3} /></button>
          </div>
          <div className="w-px h-6 bg-white/15" />
          <div className="relative">
            <button onClick={() => setMenu((m) => !m)} aria-label="Menu" className="w-9 h-9 grid place-items-center rounded-full hover:bg-white/10"><Menu size={22} /></button>
            {menu && (
              <div className="absolute right-0 top-11 w-48 rounded-xl bg-[#1a1e1a] border border-white/10 shadow-xl overflow-hidden text-[13px]">
                <button onClick={() => { setMenu(false); sortHand(); }} className="w-full text-left px-4 py-2.5 hover:bg-white/5">Sort cards</button>
                {v?.log && <button onClick={() => { setMenu(false); setMoves(true); }} className="w-full text-left px-4 py-2.5 hover:bg-white/5">Table moves &amp; discards</button>}
                <button onClick={() => { setMenu(false); setScores(true); }} className="w-full text-left px-4 py-2.5 hover:bg-white/5">Scoreboard</button>
                {lastRes && <button onClick={() => { setMenu(false); setLastOpen(true); }} className="w-full text-left px-4 py-2.5 hover:bg-white/5">Last deal — all hands</button>}
                <button onClick={() => { setMenu(false); leave(); }} className="w-full text-left px-4 py-2.5 text-rose-300 hover:bg-white/5">Leave table</button>
              </div>
            )}
          </div>
        </div>

        {/* Hand points chip */}
        {inDeal ? (
          <div className="absolute left-[3%] top-[17%] z-20 rounded-lg bg-[#1a1e1a] border border-white/10 px-2.5 py-1 text-[12px]">
            <span className="text-white/60">Points</span> <b>{sc.points}</b>{sc.valid && <span className="text-neon-400"> ✓</span>}
          </div>
        ) : playing && v ? (
          <div className="absolute left-[3%] top-[17%] z-20 flex flex-col items-start gap-1.5">
            <div className="rounded-lg bg-[#1a1e1a] border border-white/10 px-2.5 py-1 text-[12px] text-white/75 whitespace-nowrap">
              {mySeat?.out ? "Out — watching" : mySeat?.dropped ? (mode === "points" ? "Dropped" : "Dropped — next deal soon") : mySeat?.wrong ? `Wrong show (${maxPts})` : v.queued ? "Joining next game" : "Watching"}
            </div>
            {(mySeat?.dropped || mySeat?.wrong || mySeat?.out) && (
              <button onClick={joinAnother} disabled={moving} className="rounded-full px-3 py-1.5 text-[12px] font-semibold bg-neon-500 text-slate-900 shadow-lg whitespace-nowrap disabled:opacity-60">{moving ? "Moving…" : "Join another table →"}</button>
            )}
          </div>
        ) : null}

        {/* Scoreboard — who is on how many points, and the last deal */}
        {v && v.status !== "waiting" && (
          <button onClick={() => setScores(true)} className="absolute right-[3%] top-[17%] z-20 rounded-lg bg-[#1a1e1a] border border-white/10 px-2.5 py-1 text-[12px] flex items-center gap-1.5">
            <ListOrdered size={14} /> Scores
          </button>
        )}


        {/* Opponents */}
        {v && shownOthers.map((si, k) => {
          const b = v.seats[si];
          const pos = POS[slots[k]];
          if (!b || !pos) return null;
          const active = playing && v.turn === si;
          const dropped = playing && (b.dropped || b.wrong);
          const away = !b.playing || b.out || b.left;
          return (
            <div key={si + (b.uid ?? b.name)} data-rc-seat={si} className="absolute z-10 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center" style={{ left: `${pos[0]}%`, top: `${pos[1]}%` }}>
              <RcAvatar emoji={b.emoji} size={av} active={active} left={active ? secsTo(v.turn_ends) : 0} total={turnSecs} dim={away && !dropped} badge={dropped ? (b.wrong ? "Wrong show" : "Dropped") : b.out ? "Out" : null} dealer={dealer === si} />
              <div className={`-mt-1.5 relative rounded-full bg-[#141814] border px-2.5 py-0.5 text-[12px] whitespace-nowrap max-w-[150px] truncate ${active ? "border-neon-400/70" : "border-white/15"}`}>
                {tagText(b, false)}{b.bot && <BotTag />}
              </div>
              {playing && !dropped && b.action && !active && <div className="mt-0.5 rounded-full bg-black/35 px-2 text-[11px] text-white/80 max-w-[160px] truncate">{b.action}</div>}
            </div>
          );
        })}

        {/* Centre: deck with the wild joker under it, open card, show slot — or the deal status */}
        <div className="absolute left-0 right-0 top-[45%] -translate-y-1/2 z-10">
          {!v || v.status === "waiting" ? (
            <div className="text-center">
              <div className="text-[15px] font-semibold">{v?.code ? "Waiting for friends…" : "Finding players…"}</div>
              <div className="text-[13px] text-white/70 mt-1">{v?.next_at ? `Dealing in ${Math.ceil(secsTo(v.next_at))}s` : v?.code ? "A private table starts when 2 players are in" : ""}</div>
            </div>
          ) : v.status === "dealdone" && res ? (
            <div className="text-center fadein">
              <div className="text-base font-semibold">{iWonDeal ? "You declared!" : `${res.winner_name} ${res.rows.find((r) => r.seat === res.winner)?.note === "Declared" ? "declared" : "wins"}`}</div>
              {res.match_over && mode !== "points" && <div className="text-[13px] text-gold-300 mt-0.5">{iWonMatch ? "You win the match!" : `${res.champion_name} wins the match`}</div>}
              <div className="text-[12px] text-white/70 mt-1">{res.match_over ? "Next game" : `Deal ${v.deal_no + 1}`} in {Math.ceil(secsTo(v.next_at))}s</div>
            </div>
          ) : (
            <div className="relative h-0">
              {/* Closed deck, wild joker tucked underneath */}
              <button ref={deckRef} disabled={!myTurn || v.phase !== "draw" || busy} onClick={() => act("draw_stock")} aria-label={`Closed deck, ${v.stock_count} cards`} className="absolute -translate-y-1/2" style={{ left: "38%" }}>
                {v.wild && (
                  <div className="absolute top-1/2" style={{ left: -deckH * 0.62, transform: "translateY(-50%) rotate(-90deg)" }}>
                    <RcCard card={v.wild} wild w={deckW} h={deckH} />
                  </div>
                )}
                <div className={`relative rounded-[10px] ${myTurn && v.phase === "draw" ? "rc-glow" : ""}`}><RcBack w={deckW} h={deckH} /></div>
              </button>
              {/* Open card */}
              <button disabled={!myTurn || v.phase !== "draw" || busy || !v.open_top || (isJoker(v.open_top, wild) && !v.open_joker_ok)} onClick={() => act("draw_open")} aria-label="Open card" ref={openRef} className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-[10px] transition-transform ${drag?.over === "discard" ? "scale-110 ring-4 ring-white/90" : ""}`} style={{ left: "52%" }}>
                {drag?.over === "discard" && <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-[11px] font-bold rounded-full px-2 py-0.5 bg-white text-black whitespace-nowrap z-10">Discard</div>}
                {(() => {
                  const top = pileHold ? pileHold.card : v.open_top;
                  return top
                    ? <div className={`rounded-[10px] ${!pileHold && myTurn && v.phase === "draw" && (!isJoker(top, wild) || v.open_joker_ok) ? "rc-glow" : ""}`}><RcCard key={top.id} card={top} wild={isJoker(top, wild)} w={deckW} h={deckH} /></div>
                    : <div className="rounded-[10px] border-2 border-dashed border-white/25" style={{ width: deckW, height: deckH }} />;
                })()}
              </button>
              {/* Show (finish) slot: select one card to put aside, then tap here */}
              <button ref={showRef} disabled={!canDiscard} onClick={() => setConfirm("declare")} aria-label="Show" className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-md border grid place-items-center text-[12px] font-semibold tracking-wide leading-tight text-center transition-transform ${drag?.over === "show" ? "scale-110 border-2 border-gold-300 text-gold-300 bg-gold-500/25" : canDiscard || (myTurn && v.phase === "discard" && drag?.moving) ? "border-gold-300 text-gold-300 bg-black/20 animate-pulse" : "border-black/40 text-black/45 bg-black/10"}`} style={{ left: "71%", width: deckW * 0.95, height: deckH * 1.02 }}>
                SHOW<br />HERE
              </button>
            </div>
          )}
        </div>

        {/* My hand */}
        <div className="absolute inset-x-0 z-20 flex justify-center" style={{ bottom: Math.round(72 * S) }}>
          {v && mySeat && !mySeat.playing && v.status !== "waiting" && mySeat.action === "Not enough coins" ? (
            <div className="text-center bg-black/50 rounded-lg px-3 py-2">
              <div className="text-[12px] text-white/75">You need {inr(mode === "points" ? stake * maxPts : stake)} to play this table</div>
              <button onClick={() => nav.push({ name: "addcash" })} className="btn-green pill px-5 py-1.5 mt-1.5 text-[12px]">Get Coins</button>
            </div>
          ) : (
            <div className={`relative flex items-end ${!inDeal && playing ? "opacity-45" : ""}`} style={{ gap: cgap }}>
              {/* Discard / group actions float above the hand */}
              {inDeal && sel.length > 0 && (
                <div className="absolute left-1/2 -translate-x-1/2 flex gap-2 z-30" style={{ bottom: ch + 26 }}>
                  {sel.length === 1 && myTurn && v?.phase === "discard" && (
                    <>
                      <button disabled={busy} onClick={() => act("discard", sel[0])} className="rounded-full px-5 py-1.5 text-[13px] font-bold bg-white text-black shadow-lg">Discard</button>
                      <button disabled={busy} onClick={() => setConfirm("declare")} className="rounded-full px-5 py-1.5 text-[13px] font-bold bg-gold-500 text-black shadow-lg">Finish</button>
                    </>
                  )}
                  {sel.length >= 2 && <button onClick={makeGroup} className="rounded-full px-5 py-1.5 text-[13px] font-bold bg-white text-black shadow-lg">Group</button>}
                </div>
              )}
              {visibleGroups.map((g, gi) => (
                <div key={gi} className="relative flex flex-col items-start">
                  <div className="absolute left-0 right-0 flex justify-center" style={{ bottom: ch + 4 }}>
                    {sel.length > 0 && !g.some((c) => sel.includes(c.id)) ? (
                      <button onClick={() => moveTo(gi)} className="text-[11px] font-semibold rounded-full px-2.5 py-0.5 whitespace-nowrap bg-sky-500 text-white">⤵ Move here</button>
                    ) : (
                      <div className={`text-[10px] rounded-full px-2 py-px whitespace-nowrap ${sc.kinds[gi] === "invalid" ? "bg-black/35 text-rose-200" : "bg-black/35 text-neon-300"}`}>
                        {KIND_LABEL[sc.kinds[gi]]}{sc.kinds[gi] !== "invalid" ? " ✓" : ` (${g.reduce((a, c) => a + cardPoints(c, wild), 0)})`}
                      </div>
                    )}
                  </div>
                  <div className="relative" style={{ width: cw + (g.length - 1) * cstep, height: ch }}>
                    {g.map((c, ci) => {
                      const dragging = drag?.id === c.id && drag.moving;
                      return (
                        <div
                          key={c.id}
                          onPointerDown={(e) => onCardDown(e, c.id, gi, ci)}
                          onPointerMove={onCardMove}
                          onPointerUp={onCardUp}
                          onPointerCancel={() => setDrag(null)}
                          data-rc-card={c.id}
                          className="absolute top-0"
                          style={{
                            left: ci * cstep,
                            opacity: hidden.includes(c.id) ? 0 : undefined,
                            touchAction: "none",
                            zIndex: dragging ? 50 : undefined,
                            transform: dragging ? `translate(${drag!.dx}px, ${drag!.dy - 10}px) scale(1.06)` : undefined,
                            filter: dragging ? "drop-shadow(0 10px 14px rgba(0,0,0,.5))" : undefined,
                          }}
                        >
                          <RcCard card={c} wild={isJoker(c, wild)} w={cw} h={ch} selected={sel.includes(c.id)} onClick={() => {}} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Me: avatar and tag at the bottom centre, Drop to the right */}
        {mySeat && (
          <div className="absolute left-1/2 -translate-x-1/2 bottom-0 z-10 flex flex-col items-center">
            <RcAvatar emoji={mySeat.emoji} size={av} active={!!myTurn} left={myTurn ? secsTo(v!.turn_ends) : 0} total={turnSecs} badge={playing && (mySeat.dropped || mySeat.wrong) ? "Dropped" : null} dealer={v?.me != null && dealer === v.me} />
            <div className={`-mt-1.5 relative rounded-full bg-[#141814] border px-2.5 py-0.5 text-[12px] whitespace-nowrap ${myTurn ? "border-neon-400/70" : "border-white/15"}`}>{tagText(mySeat, true)}</div>
          </div>
        )}
        {inDeal && (
          <button disabled={!myTurn || v?.phase !== "draw" || busy} onClick={() => setConfirm("drop")} className="absolute z-20 bottom-2 rounded-full border-2 border-white/85 px-4 py-1.5 text-[16px] font-bold flex items-center gap-2 bg-black/30 disabled:opacity-40" style={{ left: "calc(50% + " + Math.round(70 * S) + "px)" }}>
            <Hand size={18} /> Drop
          </button>
        )}

        {/* Bottom-left: sort and group in sequence next to user profile */}
        {inDeal && (
          <div
            className="absolute z-20 bottom-2 flex items-center gap-2"
            style={{ right: "calc(50% + " + Math.round(70 * S) + "px)" }}
          >
            <button
              onClick={makeGroup}
              className={`rounded-full border-2 px-3.5 sm:px-4 py-1.5 text-[15px] sm:text-[16px] font-bold flex items-center gap-1.5 shadow-md active:scale-95 transition-all ${
                sel.length ? "border-white bg-white/20 text-white" : "border-white/85 bg-black/40 text-white/90"
              }`}
            >
              <Layers size={17} /> Group
            </button>
            <button
              onClick={sortHand}
              className="rounded-full border-2 border-white/85 px-3.5 sm:px-4 py-1.5 text-[15px] sm:text-[16px] font-bold flex items-center gap-1.5 bg-black/40 text-white/90 shadow-md active:scale-95 transition-all"
            >
              <ArrowDownUp size={17} /> Sort
            </button>
          </div>
        )}
        {!inDeal && v && mode !== "points" && (
          <div className="absolute left-[3%] bottom-3 z-20 text-[11px] text-white/45 max-w-[30%]">Leaving mid-deal counts as a drop and forfeits the match</div>
        )}
      </div>

      {flights.map((f) => {
        const p = f.go ? f.to : f.from;
        return (
          <div
            key={f.key}
            className="absolute left-0 top-0 z-[60] pointer-events-none"
            style={{
              transform: `translate(${p.x - deckW / 2}px, ${p.y - deckH / 2}px) rotate(${f.go ? 0 : -10}deg) scale(${f.go ? 1 : 1.08})`,
              transition: f.go ? `transform ${FLY_MS}ms cubic-bezier(.22,.8,.3,1)` : "none",
              filter: "drop-shadow(0 8px 10px rgba(0,0,0,.45))",
            }}
          >
            {f.card ? <RcCard card={f.card} wild={isJoker(f.card, wild)} w={deckW} h={deckH} /> : <RcBack w={deckW} h={deckH} />}
          </div>
        );
      })}

      <Sheet open={scores} onClose={() => setScores(false)} title="Scoreboard">
        <div className="text-[12px] text-white/50 mb-2">
          {mode === "points" ? `Points Rummy • ${stakeText}` : mode === "deals" ? `Deals • best of ${v?.deals ?? askedDeals} • deal ${v?.deal_no ?? 1}` : `Pool ${pool} • over ${pool} is out • deal ${v?.deal_no ?? 1}`}
        </div>
        <div className="rounded-xl bg-white/5 overflow-hidden text-sm">
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-3 py-2 text-[12px] text-white/50 border-b border-white/5">
            <span>Player</span><span className="text-right">Last deal</span><span className="text-right w-20">{mode === "points" ? "Status" : mode === "deals" ? "Chips" : "Total"}</span>
          </div>
          {(v?.seats ?? []).map((st, i) => {
            if (!st || (!st.in_match && !st.playing)) return null;
            const last = lastRes?.rows.find((r) => r.seat === i);
            const status = st.left ? "Left" : st.out ? "Out" : st.wrong ? "Wrong show" : st.dropped ? "Dropped" : st.playing ? "Playing" : "Waiting";
            return (
              <div key={i} className={`grid grid-cols-[1fr_auto_auto] gap-x-4 px-3 py-1.5 ${i === me ? "bg-neon-400/10" : ""}`}>
                <span className="truncate">{i === me ? "You" : st.name}{st.bot && <BotTag />} <span className="text-[11px] text-white/40">{status}</span></span>
                <span className="text-right tabular-nums text-white/70">{last ? last.pts ?? "—" : "—"}</span>
                <span className={`text-right tabular-nums w-20 ${st.out ? "text-rose-300" : ""}`}>
                  {mode === "points" ? status : mode === "deals" ? `${(st.score ?? 0) >= 0 ? "+" : ""}${st.score ?? 0}` : `${st.score ?? 0}/${pool}`}
                </span>
              </div>
            );
          })}
        </div>
        {lastRes ? (
          <button onClick={() => { setScores(false); setLastOpen(true); }} className="btn-green w-full rounded-xl py-2.5 text-sm mt-3">See the last deal — every player&apos;s hand</button>
        ) : (
          <div className="text-[12px] text-white/40 mt-3 text-center">No deal finished yet at this table.</div>
        )}
      </Sheet>

      <Sheet open={lastOpen && !!lastRes} onClose={() => setLastOpen(false)} title={lastRes ? `Last deal • Deal ${lastRes.deal_no}` : "Last deal"}>
        {lastRes && (
          <div className="text-sm">
            <div className="mb-2">
              <b>{lastRes.winner === me ? "You" : lastRes.winner_name}</b>{" "}
              {lastRes.rows.find((r) => r.seat === lastRes.winner)?.note === "Declared" ? "declared and won" : "won"}
              {lastRes.wild && <span className="text-white/50"> • joker {lastRes.wild.r}{lastRes.wild.s}</span>}
            </div>
            <div className="space-y-2.5">
              {[...lastRes.rows].sort((a, b) => (a.seat === lastRes.winner ? -1 : b.seat === lastRes.winner ? 1 : (a.pts ?? 0) - (b.pts ?? 0))).map((r) => (
                <div key={r.seat} className={`rounded-xl p-2.5 ${r.seat === lastRes.winner ? "bg-gold-400/10 border border-gold-300/40" : "bg-white/5"}`}>
                  <div className="flex items-center gap-2 text-[13px]">
                    <span className="flex-1 truncate">{r.seat === lastRes.winner && "🏆 "}{r.seat === me ? "You" : r.name}{r.bot && <BotTag />} <span className="text-white/45 text-[12px]">{r.note}</span></span>
                    <span className="tabular-nums">{r.pts ?? "—"} pts</span>
                    {lastRes && (mode === "points"
                      ? r.coins !== null && <span className={`tabular-nums w-16 text-right ${r.coins >= 0 ? "text-neon-400" : "text-rose-300"}`}>{r.coins >= 0 ? "+" : "-"}{inr(Math.abs(r.coins))}</span>
                      : <span className="tabular-nums w-16 text-right text-white/60">{mode === "deals" ? `${r.score >= 0 ? "+" : ""}${r.score}` : r.out ? `${r.score} out` : r.score}</span>)}
                  </div>
                  {r.hand && r.hand.length > 0 ? (
                    <div className="flex flex-wrap gap-2 mt-1.5">
                      {r.hand.map((g, gi) => (
                        <div key={gi} className="flex -space-x-3">{g.map((c, ci) => <PlayingCard key={`${c.id}:${ci}`} card={c} size="xs" />)}</div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[11px] text-white/40 mt-1">{r.note || "No cards shown"}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </Sheet>

      <Sheet open={moves} onClose={() => setMoves(false)} title="Table moves">
        <div className="text-[13px]">
          <div className="text-white/50 text-[12px] mb-1.5">Open pile (top first) • {v?.discards?.length ?? 0} cards</div>
          <div className="flex flex-wrap gap-1">
            {(v?.discards ?? []).map((c, i) => <RcCard key={c.id + ":" + i} card={c} wild={isJoker(c, wild)} w={30} h={42} />)}
            {!v?.discards?.length && <span className="text-white/40">Empty</span>}
          </div>
          <div className="text-white/50 text-[12px] mt-4 mb-1.5">This deal, latest first</div>
          <div className="space-y-1">
            {[...(v?.log ?? [])].reverse().map((m, i) => (
              <div key={i} className={`rounded-lg px-2.5 py-1.5 ${m.reshuffle ? "bg-gold-500/15 text-gold-300" : m.seat === v?.me ? "bg-white/10" : "bg-white/5"}`}>{moveTxt(m, v?.me ?? null)}</div>
            ))}
            {!v?.log?.length && <div className="text-white/40">No moves yet this deal</div>}
          </div>
          <div className="text-[11px] text-white/35 mt-3">
            Rummy uses {cards === 21 ? "three" : "two"} decks, so each card exists {cards === 21 ? "three" : "two"} times. A thrown card can also be picked up and thrown again, and when the closed deck runs out the open pile is reshuffled back in — so the same card can come round more than once.
          </div>
        </div>
      </Sheet>

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
                ? <>Your {cards} cards form a valid hand. The selected card goes to the open pile.</>
                : <span className="text-rose-300">These groups are not a valid declaration{cards === 21 ? " (21 cards need 3 pure sequences)" : ""}. A wrong show costs {maxPts} points.</span>;
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
    </LandscapeStage>
  );
}

// ---------------------------------------------------------------- table pieces (styled like native rummy apps)

/** A big card: large rank and suit in the corner (the part that shows when cards overlap), big suit below. */
function RcCard({ card, w, h, wild, selected, onClick, className = "", style }: { card: Card; w: number; h: number; wild?: boolean; selected?: boolean; onClick?: () => void; className?: string; style?: React.CSSProperties }) {
  const red = card.s === "♥" || card.s === "♦";
  const ink = red ? "#e11d2a" : "#111";
  if ((card.r as string) === "JK") {
    return (
      <div
        onClick={onClick}
        className={`${className} ${className.includes("absolute") ? "" : "relative"} rounded-[10px] bg-white border border-black/15 shadow-[0_2px_6px_rgba(0,0,0,.35)] transition-transform ${selected ? "-translate-y-4 ring-[3px] ring-sky-400" : ""} ${onClick ? "cursor-pointer" : ""}`}
        style={{ width: w, height: h, ...style }}
      >
        <div className="absolute font-black leading-[0.95] text-center text-[#c2410c]" style={{ left: w * 0.06, top: h * 0.05, fontSize: h * 0.13, width: w * 0.2 }}>J<br />O<br />K<br />E<br />R</div>
        <div className="absolute leading-none" style={{ right: w * 0.06, bottom: h * 0.06, fontSize: h * 0.42 }}>🃏</div>
      </div>
    );
  }
  return (
    <div
      onClick={onClick}
      className={`${className} ${className.includes("absolute") ? "" : "relative"} rounded-[10px] bg-white border border-black/15 shadow-[0_2px_6px_rgba(0,0,0,.35)] transition-transform ${selected ? "-translate-y-4 ring-[3px] ring-sky-400" : ""} ${onClick ? "cursor-pointer" : ""}`}
      style={{ width: w, height: h, ...style }}
    >
      <div className="absolute font-bold leading-[0.9] text-center" style={{ left: w * 0.07, top: h * 0.05, color: ink, fontSize: h * 0.27, width: w * 0.32 }}>
        <div style={{ letterSpacing: card.r === "10" ? "-0.08em" : undefined }}>{card.r}</div>
        <div style={{ fontSize: h * 0.21 }}>{card.s}</div>
      </div>
      <div className="absolute leading-none" style={{ right: w * 0.08, bottom: h * 0.05, color: ink, fontSize: h * 0.42 }}>{card.s}</div>
      {wild && <div className="absolute -left-1 top-1 rounded-r-md bg-sky-600 text-white font-bold grid place-items-center" style={{ width: h * 0.15, height: h * 0.18, fontSize: h * 0.12 }}>J</div>}
    </div>
  );
}

/** The closed deck's card back. */
function RcBack({ w, h }: { w: number; h: number }) {
  return (
    <div className="rounded-[10px] grid place-items-center shadow-[0_4px_10px_rgba(0,0,0,.45)] border border-black/30" style={{ width: w, height: h, background: "linear-gradient(160deg,#a3202f,#6e0f1b)" }}>
      <span className="font-black italic text-white/95" style={{ fontSize: h * 0.3, textShadow: "0 2px 0 rgba(0,0,0,.25)" }}>GH</span>
    </div>
  );
}

/** Player avatar; on their turn it becomes a countdown ring with the seconds left, and it can carry a badge. */
function RcAvatar({ emoji, size, active, left, total, dim, badge, dealer }: { emoji: string; size: number; active: boolean; left: number; total: number; dim?: boolean; badge?: string | null; dealer?: boolean }) {
  const frac = Math.max(0, Math.min(1, left / total));
  const ring = frac > 0.5 ? "#22c55e" : frac > 0.25 ? "#f59e0b" : "#ef4444";
  const outer = size + 10;
  return (
    <div className="relative grid place-items-center" style={{ width: outer, height: outer }}>
      {active ? (
        <div className="rounded-full grid place-items-center shadow-[0_0_18px_rgba(34,197,94,.45)]" style={{ width: outer, height: outer, background: `conic-gradient(${ring} ${frac * 360}deg, #1f2a1f 0deg)` }}>
          <div className="rounded-full bg-[#101410] grid place-items-center font-bold" style={{ width: size - 4, height: size - 4, fontSize: size * 0.48 }}>{Math.ceil(left)}</div>
        </div>
      ) : (
        <div className={`rounded-full grid place-items-center bg-gradient-to-b from-[#5b6460] to-[#2b302d] border-2 border-[#1a1d1a] ${dim || badge ? "grayscale opacity-60" : ""}`} style={{ width: size, height: size, fontSize: size * 0.56 }}>{emoji}</div>
      )}
      {dealer && <DealerChip className="left-1/2 -translate-x-1/2 -top-1.5" />}
      {badge && !active && <div className="absolute rounded-full bg-[#6b6f6c]/95 text-white text-[10px] font-medium px-2 py-px whitespace-nowrap">{badge}</div>}
    </div>
  );
}
