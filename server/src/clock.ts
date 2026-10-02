// Time source for the engines. Real time in production; tests swap in a virtual clock so thousands of
// hands run in seconds.

export interface Clock {
  now(): number;
  after(ms: number, fn: () => void): () => void; // returns cancel
}

export const realClock: Clock = {
  now: () => Date.now(),
  after: (ms, fn) => { const t = setTimeout(fn, Math.max(0, ms)); return () => clearTimeout(t); },
};

/** Virtual clock for tests: run() fires due timers in order, jumping time forward. */
export class FakeClock implements Clock {
  t = 1_700_000_000_000;
  private q: { at: number; seq: number; fn: () => void; dead: boolean }[] = [];
  private seq = 0;
  now() { return this.t; }
  after(ms: number, fn: () => void) {
    const item = { at: this.t + Math.max(0, ms), seq: this.seq++, fn, dead: false };
    this.q.push(item);
    return () => { item.dead = true; };
  }
  /** Fire timers until `ms` of virtual time has passed (or nothing is left). */
  async run(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.q = this.q.filter((x) => !x.dead);
      this.q.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.q[0];
      if (!next || next.at > end) break;
      this.q.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
      await Promise.resolve();
    }
    this.t = end;
  }
}
