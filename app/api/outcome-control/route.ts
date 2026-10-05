import {
  insertRow,
  rpc,
  selectOne,
  upsertRow,
  userFromToken,
} from "../../lib/server/supabaseAdmin";

// GET  /api/outcome-control — Super Admin reads outcome control state.
// POST /api/outcome-control — Super Admin updates global, game-wise, or target account (Player/Agent/Admin) win/loss command.

interface ProfileRow {
  id: string;
  role: string;
  name: string;
  code: string;
  phone: string | null;
  username: string | null;
  status: string;
  parent_id: string | null;
}

interface OutcomeControlData {
  global_mode: "fair" | "force_win" | "force_loss";
  games: Record<string, "fair" | "force_win" | "force_loss">;
  players: Record<string, "fair" | "force_win" | "force_loss">;
  agents?: Record<string, "fair" | "force_win" | "force_loss">;
  admins?: Record<string, "fair" | "force_win" | "force_loss">;
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
  let ctrl: OutcomeControlData = { global_mode: "fair", games: {}, players: {}, agents: {}, admins: {} };
  try {
    const row = await selectOne<{ key: string; value: OutcomeControlData }>("app_settings", "key=eq.outcome_control");
    if (row?.value) {
      ctrl = {
        global_mode: row.value.global_mode || "fair",
        games: row.value.games || {},
        players: row.value.players || {},
        agents: row.value.agents || {},
        admins: row.value.admins || {},
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

  // 3. Resolve targeted accounts info (players, agents, admins)
  const allTargetIds = new Set([
    ...Object.keys(ctrl.players || {}),
    ...Object.keys(ctrl.agents || {}),
    ...Object.keys(ctrl.admins || {}),
  ]);

  const targetsInfo: Record<string, { name: string; code: string; phone: string | null; username: string | null; role: string; mode: string }> = {};
  for (const tid of allTargetIds) {
    try {
      const p = await selectOne<ProfileRow>("profiles", `id=eq.${tid}`);
      if (p) {
        const mode = ctrl.players[tid] || ctrl.agents?.[tid] || ctrl.admins?.[tid] || "fair";
        targetsInfo[tid] = {
          name: p.name,
          code: p.code,
          phone: p.phone,
          username: p.username,
          role: p.role,
          mode,
        };
      }
    } catch {}
  }

  return Response.json({
    success: true,
    outcome_control: ctrl,
    games,
    targets_info: targetsInfo,
    players_info: targetsInfo, // backwards compatible
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
  const targetId = (b?.account_id || b?.player_id) as string | undefined;
  const targetMode = (b?.account_mode || b?.player_mode) as "fair" | "force_win" | "force_loss" | undefined;
  const targetRole = b?.role as "player" | "agent" | "admin" | undefined;
  const clearId = (b?.clear_account_id || b?.clear_player_id) as string | undefined;

  // Try RPC first
  try {
    const res = await rpc<OutcomeControlData>("set_outcome_control", {
      p_global_mode: globalMode ?? null,
      p_game: game ?? null,
      p_game_mode: gameMode ?? null,
      p_account: targetId ?? null,
      p_account_mode: targetMode ?? null,
      p_clear_account: clearId ?? null,
      p_role: targetRole ? (targetRole === "player" ? "players" : targetRole === "agent" ? "agents" : "admins") : null,
    });
    if (res) return Response.json({ success: true, outcome_control: res });
  } catch (rpcErr) {
    console.warn("set_outcome_control RPC fallback:", rpcErr);
  }

  // Fallback: Read current outcome_control and update directly
  let ctrl: OutcomeControlData = { global_mode: "fair", games: {}, players: {}, agents: {}, admins: {} };
  const existing = await selectOne<{ key: string; value: OutcomeControlData }>("app_settings", "key=eq.outcome_control");
  if (existing?.value) {
    ctrl = {
      global_mode: existing.value.global_mode || "fair",
      games: { ...(existing.value.games || {}) },
      players: { ...(existing.value.players || {}) },
      agents: { ...(existing.value.agents || {}) },
      admins: { ...(existing.value.admins || {}) },
    };
  }

  const beforeStr = JSON.stringify(ctrl);

  if (globalMode && ["fair", "force_win", "force_loss"].includes(globalMode)) {
    ctrl.global_mode = globalMode;
  }

  if (game && gameMode && ["fair", "force_win", "force_loss"].includes(gameMode)) {
    ctrl.games[game] = gameMode;
    try {
      const gRow = await selectOne<{ key: string; value: Record<string, Record<string, unknown>> }>("app_settings", "key=eq.games");
      const currentGames = gRow?.value || {};
      currentGames[game] = { ...(currentGames[game] || {}), outcome_mode: gameMode };
      await upsertRow("app_settings", { key: "games", value: currentGames });
    } catch (gErr) {
      console.warn("Could not sync to games app_settings:", gErr);
    }
  }

  if (targetId && targetMode && ["fair", "force_win", "force_loss"].includes(targetMode)) {
    // Determine bucket by targetRole or lookup profile
    let bucket: "players" | "agents" | "admins" = "players";
    if (targetRole === "agent") bucket = "agents";
    else if (targetRole === "admin") bucket = "admins";
    else {
      const targetProf = await selectOne<ProfileRow>("profiles", `id=eq.${targetId}`);
      if (targetProf?.role === "agent") bucket = "agents";
      else if (targetProf?.role === "admin") bucket = "admins";
    }

    if (!ctrl[bucket]) ctrl[bucket] = {};
    ctrl[bucket]![targetId] = targetMode;
  }

  if (clearId) {
    delete ctrl.players[clearId];
    if (ctrl.agents) delete ctrl.agents[clearId];
    if (ctrl.admins) delete ctrl.admins[clearId];
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
