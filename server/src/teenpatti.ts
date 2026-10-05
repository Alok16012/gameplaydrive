// Teen Patti table engine. One instance per table, held in memory; the server sends every seated player their own
// view after each change. Rules match the earlier database version (migrations 002–009):
//   boot → blind/seen chaal, raise (blind stake ≤ boot × 128), pack, show (2 players left), side show (10 s to answer),
//   pot limit boot × 1024 → automatic show, at most `blind_limit` blind chaals per player per hand (then Seen),
//   platform fee and turn time from Admin → Game Config. Bots are labelled and play by the same rules.
import { compare, deck, tpHandName, tpScore, type Card } from "./cards.js";
import type { Clock } from "./clock.js";
import { cfg } from "./config.js";
import { botStack, makeBot } from "./bots.js";
import type { Wallet } from "./wallet.js";

export interface TPSeat {
  uid?: string; name: string; emoji: string; bot: boolean; bal: number;
  playing: boolean; packed: boolean; seen: boolean; action: string | null; left: boolean;
  blinds: number; online: boolean; lastSeen: number; cards?: Card[];
  put?: number; // coins this player has put into the current hand (for refunds if a hand is cancelled)
}
interface Pending { from: number; to: number; ends: number; botAt: number | null }
export interface TPResult { seat: number; name: string; bot: boolean; uid?: string; amount: number; reason: string; reveal: { seat: number; cards: Card[]; hand: string }[]; pot: number; rake: number }

const MAX_SEATS = 6;
const NEXT_HAND_MS = 8000;
const FIRST_HAND_MS = 3000;
const SIDESHOW_MS = 10000;
const POT_LIMIT = 1024;
const STAKE_CAP = 128;
const OFFLINE_DROP_MS = 60000;

export class TPTable {
  status: "waiting" | "playing" | "done" = "waiting";
  hand = 0;
  pot = 0;
  stake = 0;
  round = 1;
  turn: number | null = null;
  turnEnds = 0;
  botAt: number | null = null;
  nextAt: number | null = null;
  result: TPResult | null = null;
  seats: TPSeat[] = [];
  queue: TPSeat[] = [];
  pending: Pending | null = null;
  lastSideshow: { from: number; to: number; loser: number; hand: number } | null = null;
  touched: number;
  private cancel: (() => void) | null = null;
  private starting = false;

  constructor(
    readonly id: string,
    readonly boot: number,
    readonly code: string | null,
    private clock: Clock,
    private wallet: Wallet,
    private onChange: (t: TPTable) => void,
  ) { this.touched = clock.now(); }

  get private() { return this.code !== null; }
  humans() { return this.seats.filter((s) => !s.bot && !s.left).length + this.queue.length; }
  members(): string[] { return [...this.seats.filter((s) => s.uid && !s.left).map((s) => s.uid!), ...this.queue.map((q) => q.uid!)]; }
  private seatOf(uid: string) { return this.seats.findIndex((s) => s.uid === uid); }
  private active() { return this.seats.map((s, i) => (s.playing && !s.packed ? i : -1)).filter((i) => i >= 0); }
  private changed() { this.touched = this.clock.now(); this.arm(); this.onChange(this); }

  // ------------------------------------------------------------------ people

  /** Sit down (or come back). New players wait in the queue until the next hand. */
  join(uid: string, name: string, emoji: string) {
    const i = this.seatOf(uid);
    if (i >= 0) {
      Object.assign(this.seats[i], { left: false, online: true, lastSeen: this.clock.now() });
    } else if (!this.queue.some((q) => q.uid === uid)) {
      this.queue.push({ uid, name, emoji, bot: false, bal: this.wallet.balance(uid), playing: false, packed: false, seen: false, action: null, left: false, blinds: 0, online: true, lastSeen: this.clock.now() });
    }
    if (this.status !== "playing" && this.nextAt === null) this.nextAt = this.clock.now() + FIRST_HAND_MS;
    this.changed();
  }

  setOnline(uid: string, online: boolean) {
    const s = this.seats.find((x) => x.uid === uid) ?? this.queue.find((x) => x.uid === uid);
    if (s) { s.online = online; s.lastSeen = this.clock.now(); }
  }

  /** Leave on purpose: pack if in a hand, give up your seat. */
  leave(uid: string) {
    this.queue = this.queue.filter((q) => q.uid !== uid);
    const i = this.seatOf(uid);
    if (i >= 0) {
      const s = this.seats[i];
      if (this.status === "playing" && s.playing && !s.packed) {
        if (this.pending && (this.pending.from === i || this.pending.to === i)) this.resolveSideshow(false);
        if (this.status === "playing" && !s.packed) {
          if (this.turn === i) { s.left = true; this.apply(i, "pack"); this.changed(); return; }
          s.packed = true; s.action = "Left";
          const act = this.active();
          if (act.length === 1) this.finish(act[0], "Everyone else packed", false);
        }
      }
      s.left = true;
    }
    this.changed();
  }

  // ------------------------------------------------------------------ hand lifecycle

  private async startHand() {
    if (this.starting) return;
    this.starting = true;
    this.nextAt = null;
    const now = this.clock.now();
    // Keep players still here; bots stay unless broke or they randomly move on.
    let s = this.seats.filter((x) => x.bot ? !this.private && x.bal >= this.boot * 4 && Math.random() > 0.12 : !x.left && (x.online || now - x.lastSeen < OFFLINE_DROP_MS));
    for (const q of this.queue) {
      if (s.length >= MAX_SEATS) {
        const b = s.map((x, i) => (x.bot ? i : -1)).filter((i) => i >= 0).pop();
        if (b === undefined) break;
        s.splice(b, 1);
      }
      s.push(q);
    }
    this.queue = this.queue.filter((q) => !s.includes(q));
    if (!this.private) while (s.length < MAX_SEATS) s.push({ ...makeBot(s.map((x) => x.name), this.boot), playing: false, packed: false, seen: false, action: null, left: false, blinds: 0, online: true, lastSeen: now });

    // Not enough people who can pay (no player, or fewer than 2 friends at a private table): wait, take nothing.
    const canPay = s.filter((x) => !x.bot && this.wallet.balance(x.uid!) >= this.boot).length;
    if (canPay === 0 || (this.private && canPay < 2)) {
      for (const x of s) { x.playing = false; x.packed = false; if (!x.bot) x.action = this.wallet.balance(x.uid!) < this.boot ? "Not enough coins" : null; }
      this.seats = s;
      this.status = "waiting"; this.turn = null; this.pending = null;
      this.starting = false;
      this.changed();
      return;
    }
    // A bot running low adds chips before the hand, like a player buying back in.
    for (const x of s) if (x.bot && x.bal < this.boot * 40) x.bal = Math.max(x.bal, botStack(this.boot));
    // Collect boots from players (confirmed with the database) — bots pay from their table balance.
    const takes = await Promise.all(s.map((x) => (x.bot ? Promise.resolve(1) : this.wallet.take(x.uid!, this.boot, `Teen Patti • Boot ${this.boot}`))));
    s.forEach((x, i) => {
      x.packed = false; x.seen = false; x.blinds = 0; x.cards = undefined; x.put = 0;
      if (x.bot) { x.playing = true; x.bal -= this.boot; x.action = null; }
      else if (takes[i] === null) { x.playing = false; x.action = "Not enough coins"; x.bal = this.wallet.balance(x.uid!); }
      else { x.playing = true; x.action = null; x.bal = takes[i] as number; x.put = this.boot; }
    });
    this.seats = s;
    const players = s.filter((x) => x.playing);
    const humans = players.filter((x) => !x.bot).length;
    if (humans === 0 || (this.private && humans < 2)) {
      // Nobody (or not enough friends) can play: hand back any boots taken and wait.
      for (const x of players) if (!x.bot) this.wallet.give(x.uid!, this.boot, "refund", "Teen Patti • Boot returned");
      for (const x of s) { x.playing = false; if (x.bot) x.bal += this.boot; }
      this.status = "waiting"; this.turn = null; this.pending = null;
      this.starting = false;
      this.changed();
      return;
    }
    const d = deck();
    for (const x of players) x.cards = d.splice(0, 3);
    this.hand += 1;
    this.status = "playing";
    this.result = null;
    this.pending = null;
    this.pot = this.boot * players.length;
    this.stake = this.boot;
    this.round = 1;
    let first = (this.hand - 1) % s.length;
    while (!s[first].playing) first = (first + 1) % s.length;
    this.setTurn(first);
    this.starting = false;
    this.changed();
  }

  private setTurn(seat: number) {
    const c = cfg("teen-patti");
    const secs = c.turn ?? 15;
    const now = this.clock.now();
    this.turn = seat;
    this.turnEnds = now + secs * 1000;
    const x = this.seats[seat];
    // Blind limit: after N blind chaals this hand, the player must play Seen — their cards open now.
    if (!x.seen && x.blinds >= (c.blind_limit ?? 4)) { x.seen = true; x.action = "Blind limit • Seen"; }
    if (x.bot) {
      // Thinks like a person: a few quick calls, mostly a few seconds, sometimes a long think.
      const r = Math.random();
      const delay = r < 0.2 ? 1.5 + Math.random() * 1.5 : r < 0.72 ? 3 + Math.random() * 4 : r < 0.98 ? Math.min(7 + Math.random() * 5, secs - 1) : secs;
      this.botAt = now + delay * 1000;
    } else this.botAt = null;
  }

  private pay(seat: number, amt: number): boolean {
    const x = this.seats[seat];
    if (x.bot) { if (x.bal < amt) return false; x.bal -= amt; }
    else {
      if (!this.wallet.spend(x.uid!, amt, `Teen Patti • Hand #${this.hand}`)) return false;
      x.bal = this.wallet.balance(x.uid!);
      x.put = (x.put ?? 0) + amt;
    }
    this.pot += amt;
    return true;
  }

  private finish(winner: number, reason: string, showdown: boolean) {
    const w = this.seats[winner];
    const rake = cfg("teen-patti").rake ?? 5;
    const payout = Math.floor(this.pot * (1 - rake / 100));
    if (w.bot) w.bal += payout;
    else { this.wallet.give(w.uid!, payout, "win", `Teen Patti • Hand #${this.hand}`); w.bal = this.wallet.balance(w.uid!); }
    const reveal = showdown ? this.active().map((i) => ({ seat: i, cards: this.seats[i].cards!, hand: tpHandName(this.seats[i].cards!) })) : [];
    this.result = { seat: winner, name: w.name, bot: w.bot, uid: w.uid, amount: payout, reason: showdown ? tpHandName(w.cards!) : reason, reveal, pot: this.pot, rake };
    this.status = "done";
    this.turn = null;
    this.botAt = null;
    this.pending = null;
    this.nextAt = this.clock.now() + NEXT_HAND_MS;
  }

  private showdown() {
    const act = this.active();
    let best = act[0];
    for (const i of act.slice(1)) if (compare(tpScore(this.seats[i].cards!), tpScore(this.seats[best].cards!)) > 0) best = i;
    this.finish(best, "Show", true);
  }

  /** Next player after `seat`; ends the hand when one is left or the pot limit is hit. */
  private pass(seat: number) {
    const act = this.active();
    if (act.length === 1) return this.finish(act[0], "Everyone else packed", false);
    if (this.pot >= this.boot * POT_LIMIT) return this.showdown();
    let nxt = seat;
    for (;;) {
      nxt = (nxt + 1) % this.seats.length;
      if (nxt <= seat && nxt === act[0]) this.round += 1;
      if (act.includes(nxt)) break;
    }
    this.setTurn(nxt);
  }

  private apply(seat: number, action: "pack" | "timeout" | "chaal" | "raise" | "show"): string | null {
    const x = this.seats[seat];
    if (action === "pack" || action === "timeout") {
      x.packed = true; x.action = action === "pack" ? "Pack" : "Timed out";
      this.pass(seat);
      return null;
    }
    const prevStake = this.stake;
    if (action === "raise") this.stake = Math.min(this.stake * 2, this.boot * STAKE_CAP);
    const amt = x.seen ? this.stake * 2 : this.stake;
    if (!this.pay(seat, amt)) { this.stake = prevStake; return "Not enough coins"; }
    if (!x.seen) x.blinds += 1;
    x.action = action === "show" ? "Show" : action === "raise" ? `Raise ${amt}` : `${x.seen ? "Chaal" : "Blind"} ${amt}`;
    if (action === "show") {
      const act = this.active();
      if (act.length === 1) this.finish(act[0], "Everyone else packed", false); else this.showdown();
      return null;
    }
    this.pass(seat);
    return null;
  }

  private prevActive(seat: number): number | null {
    const act = this.active();
    for (let k = 1; k < this.seats.length; k++) { const p = (seat - k + this.seats.length) % this.seats.length; if (act.includes(p)) return p; }
    return null;
  }

  private requestSideshow(seat: number): string | null {
    const prev = this.prevActive(seat);
    if (!this.seats[seat].seen) return "See your cards before asking for a side show";
    if (this.active().length < 3) return "Side show needs three or more players; use Show";
    if (prev === null || !this.seats[prev].seen) return "The previous player must be Seen for a side show";
    if (!this.pay(seat, this.stake * 2)) return "Not enough coins";
    const now = this.clock.now();
    this.seats[seat].action = "Side show?";
    this.pending = { from: seat, to: prev, ends: now + SIDESHOW_MS, botAt: this.seats[prev].bot ? now + 1500 + Math.random() * 3000 : null };
    this.turnEnds = this.pending.ends;
    this.botAt = null;
    return null;
  }

  private resolveSideshow(accept: boolean) {
    const p = this.pending!;
    this.pending = null;
    if (accept) {
      const loser = compare(tpScore(this.seats[p.from].cards!), tpScore(this.seats[p.to].cards!)) > 0 ? p.to : p.from; // tie → asker loses
      const winner = loser === p.from ? p.to : p.from;
      this.seats[loser].packed = true; this.seats[loser].action = "Lost side show";
      this.seats[winner].action = "Won side show";
      this.lastSideshow = { from: p.from, to: p.to, loser, hand: this.hand };
    } else this.seats[p.to].action = "Declined";
    this.pass(p.from);
  }

  private botMove() {
    const seat = this.turn!;
    const x = this.seats[seat];
    if (this.botAt !== null && this.botAt >= this.turnEnds) return void this.apply(seat, "timeout");
    if (!x.seen && Math.random() < 0.35) x.seen = true;
    let packP = 0.08 + this.round * 0.04;
    const sc = x.seen ? tpScore(x.cards!) : null;
    if (sc) packP *= sc[0] >= 3 ? 0.2 : sc[0] === 2 ? 0.6 : 1.6;
    const act = this.active();
    if (Math.random() < packP) return void this.apply(seat, "pack");
    if (act.length === 2 && this.round >= 3 && Math.random() < 0.5) { if (this.apply(seat, "show")) this.apply(seat, "pack"); return; }
    if (sc && sc[0] >= 2 && act.length >= 3 && Math.random() < 0.15) {
      const prev = this.prevActive(seat);
      if (prev !== null && this.seats[prev].seen && !this.requestSideshow(seat)) return;
    }
    if (sc && sc[0] >= 4 && Math.random() < 0.25 && this.stake < this.boot * 8 && !this.apply(seat, "raise")) return;
    // Can't cover the chaal from its table balance: it packs.
    if (this.apply(seat, "chaal")) this.apply(seat, "pack");
  }

  // ------------------------------------------------------------------ timers

  /** One timer per table: the next thing that is due (next hand, bot move, side show answer, turn timeout). */
  private arm() {
    this.cancel?.();
    this.cancel = null;
    let at: number | null = null;
    if (this.status !== "playing") at = this.nextAt;
    else if (this.pending) at = Math.min(this.pending.botAt ?? Infinity, this.pending.ends);
    else at = Math.min(this.botAt ?? Infinity, this.turnEnds);
    if (at === null || !Number.isFinite(at)) return;
    this.cancel = this.clock.after(at - this.clock.now(), () => this.due());
  }

  private due() {
    this.cancel = null;
    const now = this.clock.now();
    if (this.status !== "playing") {
      if (this.nextAt !== null && this.nextAt <= now) { void this.startHand(); return; }
    } else if (this.pending) {
      if (this.pending.botAt !== null && this.pending.botAt <= now) {
        const sc = tpScore(this.seats[this.pending.to].cards!);
        this.resolveSideshow(sc[0] >= 2 || Math.random() < 0.5);
      } else if (this.pending.ends <= now) this.resolveSideshow(false);
    } else if (this.turn !== null && this.seats[this.turn].bot && this.botAt !== null && this.botAt <= now) {
      this.botMove();
    } else if (this.turn !== null && this.turnEnds <= now) {
      this.apply(this.turn, "timeout");
    }
    this.changed();
  }

  // ------------------------------------------------------------------ player actions

  act(uid: string, action: string): string | null {
    const me = this.seatOf(uid);
    if (me < 0 || this.status !== "playing" || !this.seats[me].playing || this.seats[me].packed) return "You are not in this hand";
    let err: string | null = null;
    if (action === "see") this.seats[me].seen = true;
    else if (action === "accept" || action === "decline") {
      if (!this.pending || this.pending.to !== me) return "No side show to answer";
      this.resolveSideshow(action === "accept");
    } else {
      if (this.pending) return "Waiting for the side show answer";
      if (this.turn !== me) return "Not your turn";
      if (action === "show" && this.active().length !== 2) return "Show is only allowed when two players are left";
      if (action === "sideshow") err = this.requestSideshow(me);
      else if (action === "pack" || action === "chaal" || action === "raise" || action === "show") err = this.apply(me, action);
      else return "Unknown action";
    }
    if (!err) this.changed();
    return err;
  }

  // ------------------------------------------------------------------ what one player may see

  view(uid: string) {
    const me = this.seatOf(uid);
    const mySeat = me >= 0 ? this.seats[me] : null;
    const mine = mySeat && mySeat.cards && (mySeat.seen || this.status === "done") ? mySeat.cards : null;
    const ss = this.lastSideshow;
    let sideshow = null;
    if (ss && ss.hand === this.hand && (me === ss.from || me === ss.to)) {
      const other = me === ss.from ? ss.to : ss.from;
      const cards = this.seats[other].cards!;
      sideshow = { seat: other, cards, hand: tpHandName(cards), lost: ss.loser === me };
    }
    const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);
    const c = cfg("teen-patti");
    return {
      id: this.id, boot: this.boot, code: this.code, status: this.status, hand_no: this.hand, pot: this.pot, stake: this.stake, round: this.round,
      turn: this.turn, turn_ends: this.status === "playing" ? iso(this.pending ? this.pending.ends : this.turnEnds) : null,
      next_hand_at: this.status !== "playing" ? iso(this.nextAt) : null, result: this.result,
      seats: this.seats.map((x) => ({
        uid: x.uid, name: x.name, emoji: x.emoji, bot: x.bot, bal: x.bot ? x.bal : this.wallet.balance(x.uid!),
        playing: x.playing, packed: x.packed, seen: x.seen, action: x.action, left: x.left, blinds: x.blinds, blinds_hand: this.hand, online: x.online,
      })),
      pending: this.pending ? { from: this.pending.from, to: this.pending.to, ends: iso(this.pending.ends) } : null,
      queued: this.queue.some((q) => q.uid === uid),
      me: me >= 0 ? me : null, my_cards: mine, my_hand: mine ? tpHandName(mine) : null, sideshow,
      due_at: null, turn_secs: c.turn ?? 15, blind_limit: c.blind_limit ?? 4, server_now: new Date(this.clock.now()).toISOString(),
    };
  }

  /** Server shutting down: return the boots/bets of a hand that can't finish. */
  refundInProgress() {
    if (this.status !== "playing") return;
    for (const x of this.seats) if (!x.bot && x.playing && x.uid) {
      this.wallet.give(x.uid, x.put ?? this.boot, "refund", `Teen Patti • Hand #${this.hand} cancelled (server restart)`);
    }
    this.status = "waiting";
  }

  dispose() { this.cancel?.(); this.cancel = null; }
}
