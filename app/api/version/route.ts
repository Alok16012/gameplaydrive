// GET /api/version — the build this server is running (see app/lib/autoUpdate.ts).
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ build: process.env.NEXT_PUBLIC_BUILD_ID ?? "dev" }, { headers: { "Cache-Control": "no-store" } });
}
