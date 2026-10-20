import { selectAll, selectOne, userFromToken } from "../../lib/server/supabaseAdmin";

// GET /api/round-lookup?round=88245&game=all — everything bet on one casino round, by its Round ID:
//   Aviator / Stock Market: the round (crash point / close) and every bet in it;
//   Dragon Tiger / Andar Bahar / Lucky 7: each player's round with their bets, the cards, the winner and the payout
//   (casino_rounds, migration 062). Those Round IDs are counted per player, so one ID can match several players'
//   rounds. Older rounds without a casino_rounds row fall back to their ledger lines (stake and payout only).
// The Super Admin sees every player; anyone else only their own downline.

type Profile = { id: string; parent_id: string | null; role: string; code: string; name: string; username: string | null };

const CASINO: Record<string, string> = { "dragon-tiger": "Dragon Tiger", "andar-bahar": "Andar Bahar", "lucky-7": "Lucky 7" };
const GAMES = ["aviator", "stockmarket", ...Object.keys(CASINO)];

export interface RoundBet {
  user: { id: string; name: string; code: string } | null;
  stake: number;
  payout: number;
  at: string;
  /** Game-specific detail: Aviator { slot, auto, cash }, Stock Market { side, cashTick }, casino { bets, cards, winner }. */
  detail: Record<string, unknown>;
}
export interface RoundResult { game: string; round: string; at: string | null; info: Record<string, unknown>; bets: RoundBet[]; legacy?: boolean }

export async function GET(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const actor = token ? await userFromToken(token) : null;
  if (!actor) return Response.json({ error: "Please sign in again" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const round = (params.get("round") ?? "").replace(/[^0-9]/g, "");
  const game = params.get("game") ?? "all";
  if (!round) return Response.json({ error: "Enter a Round ID" }, { status: 400 });
  if (game !== "all" && !GAMES.includes(game)) return Response.json({ error: "Unknown game" }, { status: 400 });
  const want = (g: string) => game === "all" || game === g;

  try {
    const profiles = await selectAll<Profile>("profiles", "select=id,parent_id,role,code,name,username");
    const byId = new Map(profiles.map((p) => [p.id, p]));
    const me = byId.get(actor.id);
    if (!me || me.role === "player") return Response.json({ error: "Not allowed" }, { status: 403 });
    let visible: Set<string> | null = null;
    if (me.role !== "superadmin") {
      const kids = new Map<string, string[]>();
      for (const p of profiles) if (p.parent_id) kids.set(p.parent_id, [...(kids.get(p.parent_id) ?? []), p.id]);
      visible = new Set<string>();
      const stack = [me.id];
      while (stack.length) {
        const cur = stack.pop()!;
        visible.add(cur);
        stack.push(...(kids.get(cur) ?? []));
      }
    }
    const seen = (uid: string) => !visible || visible.has(uid);
    const who = (uid: string) => {
      const p = byId.get(uid);
      return p ? { id: p.id, name: p.name, code: p.code } : null;
    };

    const results: RoundResult[] = [];

    if (want("aviator")) {
      const r = await selectOne<{ id: number; starts_at: string; crash: number; settled: boolean }>("av_rounds", `select=id,starts_at,crash,settled&id=eq.${round}`);
      if (r) {
        const bets = await selectAll<{ user_id: string; slot: number; amount: number; auto: number | null; cash_mult: number | null; payout: number; created_at: string }>(
          "av_bets", `select=user_id,slot,amount,auto,cash_mult,payout,created_at&round_id=eq.${round}&order=created_at`);
        results.push({
          game: "Aviator", round, at: r.starts_at, info: { crash: Number(r.crash), settled: r.settled },
          bets: bets.filter((b) => seen(b.user_id)).map((b) => ({
            user: who(b.user_id), stake: Number(b.amount), payout: Number(b.payout), at: b.created_at,
            detail: { slot: b.slot + 1, auto: b.auto === null ? null : Number(b.auto), cash: b.cash_mult === null ? null : Number(b.cash_mult) },
          })),
        });
      }
    }

    if (want("stockmarket")) {
      const r = await selectOne<{ id: number; starts_at: string; path: number[]; settled: boolean }>("sm_rounds", `select=id,starts_at,path,settled&id=eq.${round}`);
      if (r) {
        const bets = await selectAll<{ user_id: string; side: string; amount: number; cash_tick: number | null; payout: number; created_at: string }>(
          "sm_bets", `select=user_id,side,amount,cash_tick,payout,created_at&round_id=eq.${round}&order=created_at`);
        const close = r.path?.length ? Number(r.path[r.path.length - 1]) : null;
        results.push({
          game: "Stock Market", round, at: r.starts_at, info: { close, result: close === null ? null : close > 1 ? "Up" : close < 1 ? "Down" : "Flat", settled: r.settled },
          bets: bets.filter((b) => seen(b.user_id)).map((b) => ({
            user: who(b.user_id), stake: Number(b.amount), payout: Number(b.payout), at: b.created_at,
            detail: { side: b.side, cashTick: b.cash_tick },
          })),
        });
      }
    }

    const casinoGames = Object.keys(CASINO).filter(want);
    if (casinoGames.length) {
      const rows = await selectAll<{ user_id: string; game: string; bets: { side: string; v: number }[]; cards: unknown; winner: string | null; stake: number; payout: number; created_at: string }>(
        "casino_rounds", `select=user_id,game,bets,cards,winner,stake,payout,created_at&round=eq.${round}&game=in.(${casinoGames.join(",")})&order=created_at`,
      ).catch(() => []); // before migration 062 there is no table: fall back to the ledger below
      const covered = new Set(rows.map((r) => `${r.game}:${r.user_id}`));
      for (const r of rows) {
        if (!seen(r.user_id)) continue;
        results.push({
          game: CASINO[r.game] ?? r.game, round, at: r.created_at, info: { winner: r.winner, cards: r.cards },
          bets: [{ user: who(r.user_id), stake: Number(r.stake), payout: Number(r.payout), at: r.created_at, detail: { bets: r.bets } }],
        });
      }

      // Ledger lines "<Game> • Round #<id>" for rounds without a casino_rounds row.
      const ledger = await selectAll<{ user_id: string; amount: number; kind: string; note: string; created_at: string }>(
        "ledger", `select=user_id,amount,kind,note,created_at&note=like.${encodeURIComponent(`* • Round #${round}`)}&order=created_at`);
      const legacy = new Map<string, RoundResult>();
      for (const l of ledger) {
        const g = Object.keys(CASINO).find((k) => l.note === `${CASINO[k]} • Round #${round}`);
        if (!g || !casinoGames.includes(g) || covered.has(`${g}:${l.user_id}`) || !seen(l.user_id)) continue;
        const key = `${g}:${l.user_id}`;
        const r = legacy.get(key) ?? { game: CASINO[g], round, at: l.created_at, info: {}, legacy: true, bets: [{ user: who(l.user_id), stake: 0, payout: 0, at: l.created_at, detail: {} }] };
        if (l.kind === "bet") r.bets[0].stake -= Number(l.amount);
        else r.bets[0].payout += Number(l.amount);
        legacy.set(key, r);
      }
      results.push(...legacy.values());
    }

    return Response.json({ results });
  } catch (e) {
    console.warn("round lookup failed:", e);
    return Response.json({ error: "Could not look up the round" }, { status: 500 });
  }
}
