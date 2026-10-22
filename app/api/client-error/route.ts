import { selectOne, upsertRow, userIdFromToken } from "../../lib/server/supabaseAdmin";

// POST /api/client-error { message, stack, route, build } — a screen crashed in the app (ScreenBoundary in
// app/components/ui.tsx). The last 100 reports are kept in app_settings.client_errors so a crash on a player's phone
// can be read from the server. No sign-in needed (a crash can happen before one), so the body is capped and nothing
// in it is trusted.

interface Report { at: string; message: string; stack: string; route: string; build: string; ua: string; user: string | null }

export async function POST(req: Request) {
  try {
    const b = (await req.json().catch(() => null)) ?? {};
    const str = (v: unknown, n: number) => String(v ?? "").slice(0, n);
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
    const user = token ? await userIdFromToken(token).catch(() => null) : null;
    const report: Report = {
      at: new Date().toISOString(), message: str(b.message, 500), stack: str(b.stack, 4000), route: str(b.route, 200),
      build: str(b.build, 40), ua: str(req.headers.get("user-agent"), 300), user,
    };
    const row = await selectOne<{ key: string; value: Report[] }>("app_settings", "key=eq.client_errors").catch(() => null);
    const list = Array.isArray(row?.value) ? row!.value : [];
    await upsertRow("app_settings", { key: "client_errors", value: [report, ...list].slice(0, 100) });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false });
  }
}
