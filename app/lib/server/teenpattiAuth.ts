import { rpc, selectOne, userFromToken } from "./supabaseAdmin";
import { TableError } from "./teenpatti";

// Shared by the Teen Patti routes: who is calling, and the player row behind them.

export interface Player { playerId: string; name: string; emoji: string }

const EMOJI = ["🧑🏽", "👩🏽", "👨🏻", "👩🏾", "🧑🏻", "👨🏾"];
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

const playerCache = new Map<string, { player: Player; exp: number }>();

export async function playerFromRequest(req: Request): Promise<Player> {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) throw new TableError("Please sign in again", 401);
  const now = Date.now();
  const cached = playerCache.get(token);
  if (cached && cached.exp > now) return cached.player;

  const actor = await userFromToken(token);
  if (!actor) throw new TableError("Please sign in again", 401);
  const p = await selectOne<{ id: string; name: string; role: string; status: string }>("profiles", `select=id,name,role,status&id=eq.${actor.id}`);
  if (!p || p.role !== "player" || p.status !== "active") throw new TableError("Only active players can sit at a table", 403);
  const player: Player = { playerId: p.id, name: p.name, emoji: EMOJI[hash(p.id) % EMOJI.length] };
  playerCache.set(token, { player, exp: now + 15000 });
  return player;
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
