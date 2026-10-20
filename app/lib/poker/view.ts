// What one viewer may see of a poker hand. The only place cards leave the server.
//   * your own two cards: always (hold'em hands are dealt face up to their owner);
//   * the board: only the cards turned over so far (all five at showdown);
//   * anyone else's cards: only at a showdown, and only the players still in;
//   * folded players' cards: never.

import { evaluate, type Card } from "./evaluator.ts";
import { boardVisible, raiseRange, toCall, type HandEvent, type HandState, type Phase, type Rules, type Settlement } from "./engine.ts";

export interface OptionView { amount: number; ok: boolean; reason: string | null }

export interface PlayerView {
  playerId: string; name: string; seat: number; bot: boolean;
  status: "ACTIVE" | "FOLDED"; foldReason: string | null; contributed: number; bet: number;
  isTurn: boolean; isDealer: boolean;
  /** Only at a permitted reveal. */
  cards: Card[] | null;
  handName: string | null;
}

export interface HandView {
  handId: string; handNo: number; version: number; phase: Phase; stage: number; rules: Rules;
  pot: number; betLevel: number; raises: number; dealerSeat: number;
  turnId: string | null; turnDeadline: number | null;
  /** Board cards turned over so far. */
  board: Card[];
  players: PlayerView[];
  me: {
    playerId: string; inHand: boolean; status: "ACTIVE" | "FOLDED" | null;
    cards: Card[] | null; handName: string | null;
    toCall: number;
    fold: OptionView; check: OptionView; call: OptionView;
    raise: OptionView & { min: number; max: number };
  } | null;
  settlement: (Omit<Settlement, "reveal"> & { reveal: { playerId: string; cards: Card[]; handName: string }[] }) | null;
  events: HandEvent[];
}

export function viewFor(s: HandState, viewerId: string | null, balance: number): HandView {
  const reveal = new Set(s.settlement?.reveal ?? []);
  const live = s.phase === "PLAYING";
  const board = s.board.slice(0, boardVisible(s.stage));
  const nameOf = (cards: Card[]) => (board.length + cards.length >= 5 ? evaluate([...cards, ...board]).name : cards[0].r === cards[1].r ? "Pair" : "High Card");
  const meP = viewerId ? s.players[viewerId] : undefined;

  const players: PlayerView[] = s.order.map((id) => {
    const p = s.players[id];
    const shown = reveal.has(id);
    return {
      playerId: id, name: p.name, seat: p.seat, bot: p.bot, status: p.status, foldReason: p.foldReason, contributed: p.contributed, bet: p.bet,
      isTurn: s.turnId === id, isDealer: p.seat === s.dealerSeat,
      cards: shown ? s.cards[id] : null, handName: shown ? nameOf(s.cards[id]) : null,
    };
  });

  let me: HandView["me"] = null;
  if (viewerId && meP) {
    const myCards = s.cards[viewerId];
    const myTurn = live && s.turnId === viewerId && meP.status === "ACTIVE";
    const turnReason = !live ? "The hand is over" : meP.status !== "ACTIVE" ? "You have folded" : s.turnId !== viewerId ? "Not your turn" : null;
    const call = toCall(s, viewerId);
    const bal = meP.bot ? s.botBalances[viewerId] ?? 0 : balance;
    const { min, max } = raiseRange(s, viewerId, bal);
    const raiseReason = turnReason ?? (s.raises >= s.rules.maxRaises ? "No more raises this round" : max < min ? "Not enough coins to raise" : null);
    me = {
      playerId: viewerId, inHand: true, status: meP.status,
      cards: myCards, handName: nameOf(myCards),
      toCall: call,
      fold: { amount: 0, ok: myTurn, reason: turnReason },
      check: { amount: 0, ok: myTurn && call === 0, reason: turnReason ?? (call > 0 ? `${call} to call` : null) },
      call: { amount: call, ok: myTurn && call > 0 && bal >= call, reason: turnReason ?? (call === 0 ? "Nothing to call" : bal < call ? "Not enough coins" : null) },
      raise: { amount: min, ok: myTurn && !raiseReason, reason: raiseReason, min, max: Math.max(min, max) },
    };
  } else if (viewerId) {
    const no = (r: string): OptionView => ({ amount: 0, ok: false, reason: r });
    const r = "You join from the next hand";
    me = { playerId: viewerId, inHand: false, status: null, cards: null, handName: null, toCall: 0, fold: no(r), check: no(r), call: no(r), raise: { ...no(r), min: 0, max: 0 } };
  }

  return {
    handId: s.handId, handNo: s.handNo, version: s.version, phase: s.phase, stage: s.stage, rules: s.rules,
    pot: s.pot, betLevel: s.betLevel, raises: s.raises, dealerSeat: s.dealerSeat, turnId: s.turnId, turnDeadline: s.turnDeadline,
    board, players, me,
    settlement: s.settlement
      ? { ...s.settlement, reveal: s.settlement.reveal.map((id) => ({ playerId: id, cards: s.cards[id], handName: evaluate([...s.cards[id], ...s.board]).name })) }
      : null,
    events: s.events.slice(-30),
  };
}
