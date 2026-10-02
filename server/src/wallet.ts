// Coins for players at tables. Every change is written to Supabase (wallet_move → ledger). Writes for one player
// are queued in order so they can never interleave; the table uses the cached balance immediately so play never
// waits on the database. Boots/entries are confirmed with the database before a hand starts.
import { getCoins, walletMove } from "./supa.js";

export interface Wallet {
  balance(uid: string): number;
  load(uid: string): Promise<number>;
  /** Take coins now and confirm with the database. Resolves to the confirmed balance, or null if refused. */
  take(uid: string, amt: number, note: string): Promise<number | null>;
  /** Spend from the cached balance without waiting (mid-hand bets); persisted in order in the background. */
  spend(uid: string, amt: number, note: string): boolean;
  give(uid: string, amt: number, kind: "win" | "refund", note: string): void;
  /** Wait until every queued write for this player has been saved. */
  settled(uid: string): Promise<void>;
}

export class SupabaseWallet implements Wallet {
  private bal = new Map<string, number>();
  private chain = new Map<string, Promise<unknown>>();
  private queue<T>(uid: string, job: () => Promise<T>): Promise<T> {
    const p = (this.chain.get(uid) ?? Promise.resolve()).then(job, job);
    this.chain.set(uid, p.catch(() => {}));
    return p;
  }
  balance(uid: string) { return this.bal.get(uid) ?? 0; }
  async load(uid: string) { const b = await this.queue(uid, () => getCoins(uid)); this.bal.set(uid, b); return b; }
  async take(uid: string, amt: number, note: string) {
    const r = await this.queue(uid, () => walletMove(uid, -amt, "bet", note));
    if (r !== null) this.bal.set(uid, r);
    return r;
  }
  spend(uid: string, amt: number, note: string) {
    const b = this.balance(uid);
    if (b < amt) return false;
    this.bal.set(uid, b - amt);
    this.queue(uid, () => walletMove(uid, -amt, "bet", note)).then((r) => {
      if (r === null) console.warn(`[wallet] bet refused for ${uid} (${amt})`); // spent elsewhere meanwhile
      else this.bal.set(uid, r);
    }).catch((e) => console.error("[wallet] spend failed", e.message));
    return true;
  }
  give(uid: string, amt: number, kind: "win" | "refund", note: string) {
    if (amt <= 0) return;
    this.bal.set(uid, this.balance(uid) + amt);
    this.queue(uid, () => walletMove(uid, amt, kind, note)).then((r) => { if (r !== null) this.bal.set(uid, r); })
      .catch((e) => console.error("[wallet] give failed", e.message));
  }
  async settled(uid: string) { await (this.chain.get(uid) ?? Promise.resolve()); }
}

/** In-memory wallet with a ledger, for tests. */
export class MemoryWallet implements Wallet {
  bal = new Map<string, number>();
  ledger: { uid: string; amt: number; kind: string; note: string }[] = [];
  balance(uid: string) { return this.bal.get(uid) ?? 0; }
  async load(uid: string) { return this.balance(uid); }
  async take(uid: string, amt: number, note: string) {
    if (this.balance(uid) < amt) return null;
    this.bal.set(uid, this.balance(uid) - amt); this.ledger.push({ uid, amt: -amt, kind: "bet", note });
    return this.balance(uid);
  }
  spend(uid: string, amt: number, note: string) {
    if (this.balance(uid) < amt) return false;
    this.bal.set(uid, this.balance(uid) - amt); this.ledger.push({ uid, amt: -amt, kind: "bet", note });
    return true;
  }
  give(uid: string, amt: number, kind: string, note: string) {
    if (amt <= 0) return;
    this.bal.set(uid, this.balance(uid) + amt); this.ledger.push({ uid, amt, kind, note });
  }
  async settled() {}
}
