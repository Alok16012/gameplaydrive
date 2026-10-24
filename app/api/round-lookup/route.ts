import { selectAll, selectOne, userFromToken } from "../../lib/server/supabaseAdmin";

// GET /api/round-lookup?round=88245&game=all — everything bet on one round, by the ID the game shows:
//   Aviator / Stock Market: the round (crash point / close) and every bet in it;
//   Dragon Tiger / Andar Bahar / Lucky 7: each player's round with their bets, the cards, the winner and the payout
//   (casino_rounds, migration 062). Those Round IDs are counted per player, so one ID can match several players'
//   rounds. Older rounds without a casino_rounds row fall back to their ledger lines (stake and payout only);
//   Teen Patti / Poker: "Hand #N" — every table that has played a hand N, with each player's stake and payout
//     (tp2_ledger / pk_ledger) and, for the table's current hand, how it ended;
//   Rummy: the table id shown at the top ("#999DFEFC6D", the first characters of the table id) — the seats and the
//     last deal's result;
//   Ludo: the table code ("P-ABCDEF" or "ABCDEF") — the seats, the pot and the winner.
// The Super Admin sees every player; anyone else only their own downline.

type Profile = { id: string; parent_id: string | null; role: string; code: string; name: string; username: string | null };

const CASINO: Record<string, string> = { "dragon-tiger": "Dragon Tiger", "andar-bahar": "Andar Bahar", "lucky-7": "Lucky 7" };
const GAMES = ["aviator", "stockmarket", ...Object.keys(CASINO), "teen-patti", "poker", "rummy", "ludo"];
const short = (id: string) => id.replace(/-/g, "").slice(0, 10).toUpperCase();

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
  // Round IDs are numbers; Rummy table ids are hex; Ludo codes are letters and digits (with or without "P-").
  const raw = (params.get("round") ?? "").trim().replace(/^#/, "").replace(/^P-/i, "").replace(/[^0-9a-zA-Z]/g, "");
  const round = raw.replace(/[^0-9]/g, "");
  const numeric = raw !== "" && raw === round;
  const game = params.get("game") ?? "all";
  if (!raw) return Response.json({ error: "Enter a Round ID" }, { status: 400 });
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

    if (want("aviator") && numeric) {
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

    if (want("stockmarket") && numeric) {
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

    // Teen Patti and Poker: "Hand #N" on every table that has played a hand N (humans only — bots aren't in the ledger).
    for (const [g, label, ledgerTable, tableTable] of [["teen-patti", "Teen Patti", "tp2_ledger", "tp2_tables"], ["poker", "Poker", "pk_ledger", "pk_tables"]] as const) {
      if (!want(g) || !numeric) continue;
      const lines = await selectAll<{ table_id: string; hand_id: string; user_id: string; kind: string; amount: number; created_at: string }>(
        ledgerTable, `select=table_id,hand_id,user_id,kind,amount,created_at&hand_id=like.${encodeURIComponent(`*:${round}`)}&order=created_at`).catch(() => []);
      if (!lines.length) continue;
      const tableIds = [...new Set(lines.map((l) => l.table_id))];
      const tables = await selectAll<{ id: string; boot: number; code: string | null; hand_no: number; hand: { handNo?: number; settlement?: { reason: string; winners: { playerId: string; amount: number }[]; reveal?: string[]; rake?: number } | null; players?: Record<string, { name: string; bot: boolean }> } | null }>(
        tableTable, `select=id,boot,code,hand_no,hand&id=in.(${tableIds.join(",")})`).catch(() => []);
      const byTable = new Map(tables.map((t) => [t.id, t]));
      for (const tid of tableIds) {
        const mine = lines.filter((l) => l.table_id === tid && seen(l.user_id));
        if (!mine.length) continue;
        const t = byTable.get(tid);
        const per = new Map<string, RoundBet>();
        for (const l of mine) {
          const b = per.get(l.user_id) ?? { user: who(l.user_id), stake: 0, payout: 0, at: l.created_at, detail: { kinds: [] as string[] } };
          if (Number(l.amount) < 0) b.stake -= Number(l.amount); else b.payout += Number(l.amount);
          (b.detail.kinds as string[]).push(l.kind);
          per.set(l.user_id, b);
        }
        const h = t?.hand && Number(t.hand.handNo) === Number(round) ? t.hand : null;
        const names = h?.players ?? {};
        results.push({
          game: label, round: `Hand #${round}`, at: mine[0].created_at,
          info: {
            table: short(tid), boot: t ? Number(t.boot) : null, privateCode: t?.code ?? null,
            reason: h?.settlement?.reason ?? null,
            winners: h?.settlement?.winners.map((w) => `${names[w.playerId]?.name ?? "Player"}${names[w.playerId]?.bot ? " (bot)" : ""} ${w.amount}`) ?? null,
            latest: !!h,
          },
          bets: [...per.values()],
        });
      }
    }

    // Rummy: the table id shown at the top of the screen (the first characters of the table's id).
    if (want("rummy") && /^[0-9a-fA-F]{4,32}$/.test(raw)) {
      const prefix = raw.toLowerCase();
      const tables = await selectAll<{ id: string; mode: string; stake: number; cards: number; deals: number; code: string | null; match_no: number; deal_no: number; updated_at: string; status: string; result: { winner_name?: string; prize?: number; rows?: { name: string; bot: boolean; uid?: string; pts: number | null; score: number; note: string; coins: number | null }[]; deal_no?: number } | null; seats: { uid?: string; name: string; bot: boolean }[] }>(
        "rm_tables", "select=id,mode,stake,cards,deals,code,match_no,deal_no,updated_at,status,result,seats&order=updated_at.desc&limit=2000").catch(() => []);
      for (const t of tables.filter((x) => x.id.replace(/-/g, "").startsWith(prefix))) {
        const humans = (t.seats ?? []).filter((x) => !x.bot && x.uid && seen(x.uid));
        if (!humans.length) continue;
        const rows = t.result?.rows ?? [];
        results.push({
          game: t.cards === 21 ? "21 Card Rummy" : "Rummy", round: short(t.id), at: t.updated_at,
          info: {
            mode: t.mode, stake: Number(t.stake), privateCode: t.code, matchNo: t.match_no, dealNo: t.deal_no, status: t.status,
            winner: t.result?.winner_name ?? null, prize: t.result?.prize ?? null,
            table: rows.map((r) => `${r.name}${r.bot ? " (bot)" : ""}: ${r.note}${r.pts !== null && r.pts !== undefined ? ` • ${r.pts} pts` : ""}`),
          },
          bets: humans.map((x) => {
            const r = rows.find((y) => y.uid === x.uid);
            return { user: who(x.uid!), stake: r && r.coins !== null && r.coins < 0 ? -r.coins : 0, payout: r && r.coins !== null && r.coins > 0 ? r.coins : 0, at: t.updated_at, detail: { note: r?.note ?? "At the table", pts: r?.pts ?? null, score: r?.score ?? null } };
          }),
        });
      }
    }

    // Ludo: the table code.
    if (want("ludo") && /^[0-9a-zA-Z]{3,12}$/.test(raw)) {
      const tables = await selectAll<{ id: string; code: string; entry: number; max_players: number; status: string; seats: { uid?: string; name: string; left?: boolean }[]; winner: number | null; pot: number; prize: number; created_at?: string; updated_at?: string }>(
        "ld_tables", `select=*&code=eq.${encodeURIComponent(raw.toUpperCase())}`).catch(() => []);
      for (const t of tables) {
        const seats = t.seats ?? [];
        const humans = seats.filter((x) => x.uid && seen(x.uid));
        if (!humans.length) continue;
        const winner = t.winner !== null && t.winner !== undefined ? seats[t.winner] : null;
        results.push({
          game: "Ludo", round: t.code, at: t.updated_at ?? t.created_at ?? null,
          info: { entry: Number(t.entry), players: t.max_players, status: t.status, pot: Number(t.pot), prize: Number(t.prize), winner: winner?.name ?? null },
          bets: humans.map((x) => ({ user: who(x.uid!), stake: Number(t.entry), payout: winner && winner.uid === x.uid ? Number(t.prize) : 0, at: t.updated_at ?? t.created_at ?? "", detail: { left: !!x.left, won: !!winner && winner.uid === x.uid } })),
        });
      }
    }

    const casinoGames = numeric ? Object.keys(CASINO).filter(want) : [];
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

      // Ledger lines for rounds without a casino_rounds row (before 062, and 21-24 Oct 2026 when 073 had dropped the
      // insert). Notes look like "<Game> • Round #<id>" (062), "<Game> • <id> • Win" (073) or
      // "<Game> • Round #<id> • Bet" (080).
      const ledger = await selectAll<{ user_id: string; amount: number; kind: string; note: string; created_at: string }>(
        "ledger", `select=user_id,amount,kind,note,created_at&note=like.${encodeURIComponent(`*${round}*`)}&order=created_at`);
      const legacy = new Map<string, RoundResult>();
      const noteGame = (note: string) => Object.keys(CASINO).find((k) => new RegExp(`^${CASINO[k]} • (Round #)?${round}( • |$)`).test(note));
      for (const l of ledger) {
        const g = noteGame(l.note);
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
