// What one viewer may see of a hand. The only place cards leave the server.
//   * your own cards: once you have seen them (or at a reveal that includes you);
//   * anyone else's: only when the settlement reveals them (paid show: both; forced showdown: everyone left);
//   * packed players' cards: never; side show: the two players learn who lost, not each other's cards.

import { evaluate, type Card } from "./evaluator.ts";
import { betAmount, showCheck, sideshowCheck, type HandEvent, type HandState, type Phase, type Rules, type Settlement } from "./engine.ts";

export interface OptionView { amount: number; ok: boolean; reason: string | null }

export interface PlayerView {
  playerId: string; name: string; seat: number; bot: boolean;
  status: "ACTIVE" | "PACKED"; packReason: string | null; seen: boolean; contributed: number;
  isTurn: boolean; isDealer: boolean;
  /** Only at a permitted reveal. */
  cards: Card[] | null;
  handName: string | null;
}

export interface HandView {
  handId: string; handNo: number; version: number; phase: Phase; rules: Rules;
  pot: number; baseStake: number; dealerSeat: number;
  turnId: string | null; turnDeadline: number | null;
  players: PlayerView[];
  me: {
    playerId: string; inHand: boolean; status: "ACTIVE" | "PACKED" | null; seen: boolean;
    cards: Card[] | null; handName: string | null;
    canSee: OptionView; min: OptionView; double: OptionView; pack: OptionView; show: OptionView;
    sideshow: OptionView & { targetId: string | null };
    /** A side show you have to answer. */
    answer: { requestId: string; requesterId: string; deadline: number } | null;
  } | null;
  pending: { requesterId: string; targetId: string; deadline: number } | null;
  /** Side shows you took part in this hand, and who lost each. */
  mySideshows: { opponentId: string; youLost: boolean }[];
  settlement: (Omit<Settlement, "reveal"> & { reveal: { playerId: string; cards: Card[]; handName: string }[] }) | null;
  events: HandEvent[];
}

export function viewFor(s: HandState, viewerId: string | null, balance: number): HandView {
  const reveal = new Set(s.settlement?.reveal ?? []);
  const live = s.phase === "PLAYING" || s.phase === "SIDESHOW_PENDING";
  const meP = viewerId ? s.players[viewerId] : undefined;

  const players: PlayerView[] = s.order.map((id) => {
    const p = s.players[id];
    const shown = reveal.has(id);
    return {
      playerId: id, name: p.name, seat: p.seat, bot: p.bot, status: p.status, packReason: p.packReason, seen: p.seen,
      contributed: p.contributed, isTurn: s.turnId === id, isDealer: p.seat === s.dealerSeat,
      cards: shown ? s.cards[id] : null, handName: shown ? evaluate(s.cards[id]).name : null,
    };
  });

  let me: HandView["me"] = null;
  if (viewerId && meP) {
    const myCards = meP.seen || reveal.has(viewerId) ? s.cards[viewerId] : null;
    const myTurn = live && s.phase === "PLAYING" && s.turnId === viewerId && meP.status === "ACTIVE";
    const turnReason = !live ? "The hand is over" : meP.status !== "ACTIVE" ? "You have packed" : s.phase === "SIDESHOW_PENDING" ? "Waiting for the side show answer" : s.turnId !== viewerId ? "Not your turn" : null;
    const opt = (amount: number, extra: string | null): OptionView => {
      const reason = turnReason ?? extra ?? (amount > balance ? "Not enough coins" : null);
      return { amount, ok: !reason, reason };
    };
    const bmin = betAmount(s, viewerId, false);
    const bdbl = betAmount(s, viewerId, true);
    const sh = showCheck(s, viewerId);
    const ss = sideshowCheck(s, viewerId);
    const answer = s.pending && s.pending.targetId === viewerId && meP.status === "ACTIVE"
      ? { requestId: s.pending.requestId, requesterId: s.pending.requesterId, deadline: s.pending.deadline } : null;
    me = {
      playerId: viewerId, inHand: true, status: meP.status, seen: meP.seen,
      cards: myCards, handName: myCards ? evaluate(myCards).name : null,
      canSee: { amount: 0, ok: myTurn && !meP.seen, reason: meP.seen ? "Already seen" : turnReason },
      min: opt(bmin.amount, bmin.newBase > s.rules.maxBaseStake ? "Above the table maximum" : null),
      double: opt(bdbl.amount, bdbl.newBase > s.rules.maxBaseStake ? "Above the table maximum" : null),
      pack: { amount: 0, ok: myTurn, reason: turnReason },
      show: opt(sh.fee, sh.reason),
      sideshow: { ...opt(ss.fee, ss.reason), targetId: ss.targetId },
      answer,
    };
  } else if (viewerId) {
    const no = (r: string): OptionView => ({ amount: 0, ok: false, reason: r });
    const r = "You join from the next hand";
    me = { playerId: viewerId, inHand: false, status: null, seen: false, cards: null, handName: null, canSee: no(r), min: no(r), double: no(r), pack: no(r), show: no(r), sideshow: { ...no(r), targetId: null }, answer: null };
  }

  const mySideshows = viewerId
    ? s.sideshows.filter((x) => x.requesterId === viewerId || x.targetId === viewerId)
        .map((x) => ({ opponentId: x.requesterId === viewerId ? x.targetId : x.requesterId, youLost: x.loserId === viewerId }))
    : [];

  return {
    handId: s.handId, handNo: s.handNo, version: s.version, phase: s.phase, rules: s.rules,
    pot: s.pot, baseStake: s.baseStake, dealerSeat: s.dealerSeat, turnId: s.turnId, turnDeadline: s.turnDeadline,
    players, me,
    pending: s.pending ? { requesterId: s.pending.requesterId, targetId: s.pending.targetId, deadline: s.pending.deadline } : null,
    mySideshows,
    settlement: s.settlement
      ? { ...s.settlement, reveal: s.settlement.reveal.map((id) => ({ playerId: id, cards: s.cards[id], handName: evaluate(s.cards[id]).name })) }
      : null,
    events: s.events.slice(-30),
  };
}
