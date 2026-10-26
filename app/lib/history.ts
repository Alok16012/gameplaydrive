// Game History: the coin ledger folded into one row per round (what was staked, what came back).

import type { Txn } from "./data";

export type Round = { id: string; game: string; desc: string; when: string; hand?: string; staked: number; paid: number; paidOut: boolean; lastAt: number; settled: boolean };

/**
 * Rounds from the coin ledger (newest first in, newest first out). Each bet and payout joins its round:
 *   * an entry that names its round ("Hand #29", "Round #88227", "Spin #12") always joins that round of that game,
 *     even when the next round's boot was written in the same second and came first;
 *   * an entry without one joins its game's current round; a new round starts at an Entry / Boot / Buy-in, or at a
 *     stake after the current round already paid out.
 */
export function groupRounds(txns: Txn[]): Round[] {
  const rounds: Round[] = [];
  const open: Record<string, Round> = {};
  const byHand: Record<string, Round> = {};
  for (const t of [...txns].reverse()) {
    const parts = t.sub.split(" • ");
    const game = parts[0];
    const when = parts[parts.length - 1];
    const desc = parts.slice(1, -1).join(" • ");
    const hand = desc.match(/(?:Hand|Round|Spin) #\d+/)?.[0];
    const handKey = hand ? `${game}|${hand}` : null;
    let r: Round | undefined = handKey ? byHand[handKey] : undefined;
    if (!r) {
      r = open[game];
      const start = /\b(entry|boot|buy-in)\b/i.test(desc) && !/returned/i.test(desc);
      if (!r || (t.amount < 0 && (start || r.paidOut)) || (hand && r.hand && hand !== r.hand)) {
        // A new round of the same game means the previous one is over, paid or not.
        if (r) r.settled = true;
        r = { id: t.id, game, desc: desc.replace(/(^| • )(Buy-in \(max loss\)|Entry|Buy-in returned|Boot|Bet|Win|Won)$/i, ""), when, hand, staked: 0, paid: 0, paidOut: false, lastAt: 0, settled: false };
        open[game] = r;
        rounds.push(r);
      }
      if (!r.hand && hand) r.hand = hand;
      if (handKey) byHand[handKey] = r;
    }
    if (t.amount < 0) r.staked -= t.amount;
    else { r.paid += t.amount; r.paidOut = true; }
    r.when = when;
    r.lastAt = t.at ? new Date(t.at).getTime() : 0;
  }
  // A round with no payout is lost once a newer round of that game exists, or it has been quiet for a while
  // (a Rummy deal or Pool match pays nothing back to a player who loses everything they put in).
  const quiet = Date.now() - 20 * 60 * 1000;
  for (const r of rounds) if (!r.settled && r.lastAt && r.lastAt < quiet) r.settled = true;
  return rounds.reverse();
}
