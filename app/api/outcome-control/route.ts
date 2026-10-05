import {
  insertRow,
  rpc,
  selectOne,
  upsertRow,
  userFromToken,
} from "../../lib/server/supabaseAdmin";

// GET  /api/outcome-control — Super Admin reads outcome control state.
// POST /api/outcome-control — Super Admin updates global, game-wise, or per-player win/loss command.

interface ProfileRow {
  id: string;
  role: string;
  name: string;
  code: string;
  phone: string | null;
  status: string;
}

interface OutcomeControlData {
  global_mode: "fair" | "force_win" | "force_loss";
  games: Record<string, "fair" | "force_win" | "force_loss">;
  players: Record<string, "fair" | "force_win" | "force_loss">;
}

export async function GET(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const actor = token ? await userFromToken(token) : null;
  if (!actor) return Response.json({ error: "Please sign in again" }, { status: 401 });

  const profile = await selectOne<ProfileRow>("profiles", `id=eq.${actor.id}`);
  if (!profile || profile.role !== "superadmin") {
    return Response.json({ error: "Only Super Admin can access win/loss controls" }, { status: 403 });
  }

  // 1. Fetch outcome_control setting
  let ctrl: OutcomeControlData = { global_mode: "fair", games: {}, players: {} };
  try {
    const row = await selectOne<{ key: string; value: OutcomeControlData }>("app_settings", "key=eq.outcome_control");
    if (row?.value) {
      ctrl = {
        global_mode: row.value.global_mode || "fair",
        games: row.value.games || {},
        players: row.value.players || {},
      };
    }
  } catch (err) {
    console.error("Error reading outcome_control:", err);
  }

  // 2. Fetch game settings
  let games: Record<string, unknown> = {};
  try {
    const row = await selectOne<{ key: string; value: Record<string, unknown> }>("app_settings", "key=eq.games");
    if (row?.value) games = row.value;
  } catch (err) {
    console.error("Error reading games setting:", err);
  }

  // 3. Resolve targeted players info
  const playerIds = Object.keys(ctrl.players || {});
  const playersInfo: Record<string, { name: string; code: string; phone: string | null; mode: string }> = {};
  for (const pid of playerIds) {
    try {
      const p = await selectOne<ProfileRow>("profiles", `id=eq.${pid}`);
      if (p) {
        playersInfo[pid] = {
          name: p.name,
          code: p.code,
          phone: p.phone,
          mode: ctrl.players[pid],
        };
      }
    } catch {}
  }

  return Response.json({
    success: true,
    outcome_control: ctrl,
    games,
    players_info: playersInfo,
  });
}

export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  const actor = token ? await userFromToken(token) : null;
  if (!actor) return Response.json({ error: "Please sign in again" }, { status: 401 });

  const profile = await selectOne<ProfileRow>("profiles", `id=eq.${actor.id}`);
  if (!profile || profile.role !== "superadmin") {
    return Response.json({ error: "Only Super Admin can change win/loss controls" }, { status: 403 });
  }

  const b = await req.json().catch(() => null);
  const globalMode = b?.global_mode as "fair" | "force_win" | "force_loss" | undefined;
  const game = b?.game as string | undefined;
  const gameMode = b?.game_mode as "fair" | "force_win" | "force_loss" | undefined;
  const playerId = b?.player_id as string | undefined;
  const playerMode = b?.player_mode as "fair" | "force_win" | "force_loss" | undefined;
  const clearPlayerId = b?.clear_player_id as string | undefined;

  // Try RPC first
  try {
    const res = await rpc<OutcomeControlData>("set_outcome_control", {
      p_global_mode: globalMode ?? null,
      p_game: game ?? null,
      p_game_mode: gameMode ?? null,
      p_player: playerId ?? null,
      p_player_mode: playerMode ?? null,
      p_clear_player: clearPlayerId ?? null,
    });
    if (res) return Response.json({ success: true, outcome_control: res });
  } catch (rpcErr) {
    // If RPC not present in DB, fallback to direct app_settings write
    console.warn("set_outcome_control RPC fallback:", rpcErr);
  }

  // Fallback: Read current outcome_control and update directly
  let ctrl: OutcomeControlData = { global_mode: "fair", games: {}, players: {} };
  const existing = await selectOne<{ key: string; value: OutcomeControlData }>("app_settings", "key=eq.outcome_control");
  if (existing?.value) {
    ctrl = {
      global_mode: existing.value.global_mode || "fair",
      games: { ...(existing.value.games || {}) },
      players: { ...(existing.value.players || {}) },
    };
  }

  const beforeStr = JSON.stringify(ctrl);

  if (globalMode && ["fair", "force_win", "force_loss"].includes(globalMode)) {
    ctrl.global_mode = globalMode;
  }

  if (game && gameMode && ["fair", "force_win", "force_loss"].includes(gameMode)) {
    ctrl.games[game] = gameMode;
    // Also sync to app_settings.games
    try {
      const gRow = await selectOne<{ key: string; value: Record<string, Record<string, unknown>> }>("app_settings", "key=eq.games");
      const currentGames = gRow?.value || {};
      currentGames[game] = { ...(currentGames[game] || {}), outcome_mode: gameMode };
      await upsertRow("app_settings", { key: "games", value: currentGames });
    } catch (gErr) {
      console.warn("Could not sync to games app_settings:", gErr);
    }
  }

  if (playerId && playerMode && ["fair", "force_win", "force_loss"].includes(playerMode)) {
    ctrl.players[playerId] = playerMode;
  }

  if (clearPlayerId) {
    delete ctrl.players[clearPlayerId];
  }

  // Upsert outcome_control
  await upsertRow("app_settings", { key: "outcome_control", value: ctrl });

  // Insert audit log
  try {
    await insertRow("audit_log", {
      actor_id: actor.id,
      actor_name: profile.name || "Super Admin",
      action: "Game Outcome Control Changed",
      before: beforeStr,
      after: JSON.stringify(ctrl),
    });
  } catch (auditErr) {
    console.warn("Audit log insert failed:", auditErr);
  }

  return Response.json({ success: true, outcome_control: ctrl });
}
