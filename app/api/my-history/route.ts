import { selectAll, userFromToken } from "../../lib/server/supabaseAdmin";

// GET /api/my-history — the signed-in player's recent rounds with what they bet on and how it came out, keyed the way
// the ledger notes name them, so Game History can show the detail under each row:
//   "aviator:<round>", "stockmarket:<round>", "roulette:<spin>", "blackjack:<hand>",
//   "dragon-tiger:<round>" / "andar-bahar:<round>" / "lucky-7:<round>" (casino_rounds, migration 062),
//   "cricket:<event name>" (their bets on that match).
// These tables are server-only, so the service role reads them here, always filtered to the caller.

const LIMIT = 200;

export async function GET(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const actor = token ? await userFromToken(token) : null;
  if (!actor) return Response.json({ error: "Please sign in again" }, { status: 401 });
  const uid = actor.id;
  const out: Record<string, unknown> = {};
  const safe = <T,>(p: Promise<T[]>) => p.catch(() => [] as T[]); // a missing table (migration not run) just has no detail

  const [casino, av, sm, rl, bj, sport] = await Promise.all([
    safe(selectAll<{ game: string; round: string | null; bets: unknown; cards: unknown; winner: string | null; stake: number; payout: number }>(
      "casino_rounds", `select=game,round,bets,cards,winner,stake,payout&user_id=eq.${uid}&order=id.desc&limit=${LIMIT}`)),
    safe(selectAll<{ round_id: number; slot: number; amount: number; auto: number | null; cash_mult: number | null; payout: number }>(
      "av_bets", `select=round_id,slot,amount,auto,cash_mult,payout&user_id=eq.${uid}&order=id.desc&limit=${LIMIT}`)),
    safe(selectAll<{ round_id: number; side: string; amount: number; cash_tick: number | null; payout: number }>(
      "sm_bets", `select=round_id,side,amount,cash_tick,payout&user_id=eq.${uid}&order=id.desc&limit=${LIMIT}`)),
    safe(selectAll<{ id: number; num: number; stake: number; payout: number }>(
      "rl_spins", `select=id,num,stake,payout&user_id=eq.${uid}&order=id.desc&limit=${LIMIT}`)),
    safe(selectAll<{ id: number; dealer: unknown; hands: unknown; status: string; payout: number }>(
      "bj_hands", `select=id,dealer,hands,status,payout&user_id=eq.${uid}&status=eq.done&order=id.desc&limit=${LIMIT}`)),
    safe(selectAll<{ event_name: string; market_name: string; runner_name: string; bet_type: string; market_type: string; odds: number; line: number | null; stake: number; status: string; payout: number; result: string | null }>(
      "sport_bets", `select=event_name,market_name,runner_name,bet_type,market_type,odds,line,stake,status,payout,result&user_id=eq.${uid}&order=id.desc&limit=${LIMIT}`)),
  ]);

  for (const r of casino) if (r.round) out[`${r.game}:${r.round}`] = { bets: r.bets, cards: r.cards, winner: r.winner };

  const avRounds = [...new Set(av.map((b) => b.round_id))];
  const crash = new Map<number, number>();
  if (avRounds.length) {
    for (const r of await safe(selectAll<{ id: number; crash: number; settled: boolean }>("av_rounds", `select=id,crash,settled&id=in.(${avRounds.join(",")})`))) {
      if (r.settled) crash.set(r.id, Number(r.crash));
    }
  }
  for (const b of av) {
    const k = `aviator:${b.round_id}`;
    const v = (out[k] as { crash: number | null; bets: unknown[] }) ?? { crash: crash.get(b.round_id) ?? null, bets: [] };
    v.bets.push({ slot: b.slot + 1, amount: Number(b.amount), auto: b.auto === null ? null : Number(b.auto), cash: b.cash_mult === null ? null : Number(b.cash_mult), payout: Number(b.payout) });
    out[k] = v;
  }

  const smRounds = [...new Set(sm.map((b) => b.round_id))];
  const close = new Map<number, number>();
  if (smRounds.length) {
    for (const r of await safe(selectAll<{ id: number; path: number[]; settled: boolean }>("sm_rounds", `select=id,path,settled&id=in.(${smRounds.join(",")})`))) {
      if (r.settled && r.path?.length) close.set(r.id, Number(r.path[r.path.length - 1]));
    }
  }
  for (const b of sm) {
    const k = `stockmarket:${b.round_id}`;
    const v = (out[k] as { close: number | null; bets: unknown[] }) ?? { close: close.get(b.round_id) ?? null, bets: [] };
    v.bets.push({ side: b.side, amount: Number(b.amount), cashTick: b.cash_tick, payout: Number(b.payout) });
    out[k] = v;
  }

  for (const s of rl) out[`roulette:${s.id}`] = { num: s.num };
  for (const h of bj) out[`blackjack:${h.id}`] = { dealer: h.dealer, hands: h.hands };

  for (const b of sport) {
    const k = `cricket:${b.event_name}`;
    const v = (out[k] as { bets: unknown[] }) ?? { bets: [] };
    v.bets.push({ market: b.market_name, runner: b.runner_name, type: b.bet_type, rate: b.market_type === "FANCY" ? b.line : Number(b.odds), stake: Number(b.stake), status: b.status, result: b.result, payout: Number(b.payout) });
    out[k] = v;
  }

  return Response.json({ detail: out });
}
