// Engine tests on a virtual clock (no network): many hands with two real players and bots.
import { FakeClock } from "../src/clock.js";
import { setConfig } from "../src/config.js";
import { MemoryWallet } from "../src/wallet.js";
import { TPTable } from "../src/teenpatti.js";

let fails = 0;
const check = (ok: boolean, msg: string) => { if (!ok) { fails++; console.log("FAIL:", msg); } };

async function teenPatti() {
  setConfig("teen-patti", { rake: 5, turn: 15, blind_limit: 4, enabled: true });
  const clock = new FakeClock();
  const wallet = new MemoryWallet();
  const A = "user-a", B = "user-b";
  wallet.bal.set(A, 200000); wallet.bal.set(B, 200000);
  let views = 0;
  const t = new TPTable("t1", 50, null, clock, wallet, () => { views++; });
  t.join(A, "Asha", "🧑🏽"); t.join(B, "Bala", "👩🏽");
  let hands = 0, last = 0, maxBlinds = 0, showdowns = 0, sideshows = 0, packs = 0, maxPot = 0, leaks = 0, errors = 0, potLimitShows = 0;
  for (let step = 0; step < 60000 && hands < 400; step++) {
    await clock.run(500);
    for (const uid of [A, B]) {
      const v = t.view(uid);
      // Nobody ever sees another player's cards except at a show or in their own side show.
      const others = JSON.stringify(v.seats);
      if (others.includes('"cards"')) leaks++;
      if (v.status === "playing") {
        maxPot = Math.max(maxPot, v.pot);
        for (const s of v.seats) maxBlinds = Math.max(maxBlinds, s.blinds);
        if (v.pending && v.pending.to === v.me) { t.act(uid, Math.random() < 0.5 ? "accept" : "decline"); continue; }
        if (v.turn === v.me && !v.pending) {
          const me = v.seats[v.me!];
          const active = v.seats.filter((s) => s.playing && !s.packed).length;
          const r = Math.random();
          let a = "chaal";
          if (!me.seen && r < 0.15) a = "see";
          else if (r < 0.06) a = "pack";
          else if (active === 2 && r < 0.3) a = "show";
          else if (me.seen && active >= 3 && r < 0.4) a = "sideshow";
          else if (r < 0.5) a = "raise";
          const err = t.act(uid, a);
          if (err && !/side show|Seen|Show is only/.test(err)) { errors++; if (errors < 4) console.log("act error", a, err); }
          if (!err && a === "sideshow") sideshows++;
          if (!err && a === "pack") packs++;
        }
      }
    }
    if (t.status === "done" && t.hand !== last) {
      last = t.hand; hands++;
      if (t.result!.reveal.length) showdowns++;
      if (t.result!.pot >= 50 * 1024) potLimitShows++;
    }
  }
  // Coins: each player's balance equals start + everything in their ledger.
  for (const uid of [A, B]) {
    const sum = wallet.ledger.filter((l) => l.uid === uid).reduce((a, l) => a + l.amt, 0);
    check(wallet.balance(uid) === 200000 + sum, `ledger matches balance for ${uid}`);
  }
  check(hands >= 400, `hands completed: ${hands}`);
  check(maxBlinds <= 4, `blind limit respected (max ${maxBlinds})`);
  check(leaks === 0, `no card leaks (${leaks})`);
  check(errors === 0, `no unexpected action errors (${errors})`);
  console.log(`teen patti: ${hands} hands, ${showdowns} shows, ${potLimitShows} at pot limit, ${sideshows} side shows asked, ${packs} packs, max pot ${maxPot}, max blinds ${maxBlinds}, ${views} view updates`);

  // Leave mid-hand: seat packs, hand continues, player is gone next hand.
  t.leave(B);
  await clock.run(60000);
  check(!t.view(A).seats.some((s) => s.uid === B), "player who left is not seated next hand");

  // Private table: waits for 2 friends, plays with no bots.
  const p = new TPTable("p1", 10, "ABCDEF", clock, wallet, () => {});
  p.join(A, "Asha", "x");
  await clock.run(5000);
  check(p.status === "waiting", "private table waits with one player");
  p.join(B, "Bala", "y");
  await clock.run(5000);
  check(p.status === "playing" && p.seats.every((s) => !s.bot) && p.seats.length === 2, "private table plays with 2 friends, no bots");
  // Not enough coins: sits out with a message, boot not taken.
  p.leave(A); await clock.run(30000);
  wallet.bal.set(B, 5);
  p.join(A, "Asha", "x"); wallet.bal.set(A, 3); await clock.run(30000);
  const vb = p.view(B);
  check(vb.status === "waiting", "table waits when nobody can pay");
  check(wallet.balance(B) === 5, "no boot taken when the player can't pay");
  p.dispose(); t.dispose();
}

await teenPatti();
console.log(fails ? `${fails} FAILURE(S)` : "ALL CHECKS PASSED");
process.exit(fails ? 1 : 0);
