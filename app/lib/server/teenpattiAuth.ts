import { rpc, selectOne, userIdFromToken } from "./supabaseAdmin";
import { TableError } from "./teenpatti";

// Shared by the Teen Patti routes: who is calling, and the player row behind them.

export interface Player { playerId: string; name: string; emoji: string }

const EMOJI = ["🧑🏽", "👩🏽", "👨🏻", "👩🏾", "🧑🏻", "👨🏾"];
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Profiles by user id, briefly cached: every poll would otherwise look the player up again. */
const playerCache = new Map<string, { player: Player; exp: number }>();

async function profileOf(id: string): Promise<Player> {
  const now = Date.now();
  const cached = playerCache.get(id);
  if (cached && cached.exp > now) return cached.player;
  const p = await selectOne<{ id: string; name: string; role: string; status: string }>("profiles", `select=id,name,role,status&id=eq.${id}`);
  if (!p || p.role !== "player" || p.status !== "active") throw new TableError("Only active players can sit at a table", 403);
  const player: Player = { playerId: p.id, name: p.name, emoji: EMOJI[hash(p.id) % EMOJI.length] };
  playerCache.set(id, { player, exp: now + 20000 });
  return player;
}

async function userIdOf(req: Request): Promise<string> {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) throw new TableError("Please sign in again", 401);
  const id = await userIdFromToken(token);
  if (!id) throw new TableError("Please sign in again", 401);
  return id;
}

export async function playerFromRequest(req: Request): Promise<Player> {
  return profileOf(await userIdOf(req));
}

/**
 * Who is calling, fast: the user id comes from the token (checked locally, no network), and the profile check runs
 * in the background as `allowed` — pass it to the table call, which awaits it before it commits or answers, so the
 * lookup overlaps with loading the table instead of adding a round trip in front of it.
 */
export async function callerFromRequest(req: Request): Promise<{ playerId: string; allowed: Promise<Player> }> {
  const playerId = await userIdOf(req);
  const allowed = profileOf(playerId);
  allowed.catch(() => {}); // awaited later; don't report it as unhandled meanwhile
  return { playerId, allowed };
}

/** Admin controls: the game must be open, the boot within its limits, and the player's daily room must allow it. */
export async function checkCanPlay(playerId: string, boot: number) {
  try {
    await rpc("game_guard", { g: "teen-patti", amount: boot, check_size: true });
    await rpc("check_bet_room", { p_uid: playerId, amount: boot });
  } catch (e) {
    throw new TableError(e instanceof Error ? e.message.replace(/^.*?: /, "") : "Teen Patti is not available right now", 400);
  }
}

export function fail(e: unknown) {
  if (e instanceof TableError) return Response.json({ error: e.message }, { status: e.status });
  console.error("teenpatti:", e);
  return Response.json({ error: "Something went wrong" }, { status: 500 });
}

export async function body<T>(req: Request): Promise<T> {
  return ((await req.json().catch(() => null)) ?? {}) as T;
}

/** Server-Timing header, so the browser's network panel shows where the time went. */
export function serverTiming(t: { load?: number; commit?: number; tries?: number }, start: number) {
  const parts = [`total;dur=${Date.now() - start}`];
  if (t.load !== undefined) parts.push(`load;dur=${t.load}`);
  if (t.commit !== undefined) parts.push(`commit;dur=${t.commit}`);
  if (t.tries && t.tries > 1) parts.push(`retry;desc="${t.tries} tries"`);
  return parts.join(", ");
}
