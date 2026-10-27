import { jiliCallback } from "../../../lib/server/jili";

// POST /api/jili/callback?k=<JILI_CALLBACK_KEY> — SoftAPI's settle notice after every JILI round (the URL, with its
// key, is only ever sent to SoftAPI inside the encrypted launch payload). Answers 200 quickly; a repeat of the same
// serial_number is counted once. An unexpected failure answers 500 so SoftAPI tries again.
export async function POST(req: Request) {
  const k = new URL(req.url).searchParams.get("k");
  if (!process.env.JILI_CALLBACK_KEY || k !== process.env.JILI_CALLBACK_KEY) return new Response("forbidden", { status: 403 });
  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; } catch { return new Response("bad request", { status: 400 }); }
  try {
    await jiliCallback(body);
    return new Response("OK");
  } catch (e) {
    console.error("jili callback failed:", e instanceof Error ? e.message : e, JSON.stringify(body).slice(0, 300));
    return new Response("error", { status: 500 });
  }
}
