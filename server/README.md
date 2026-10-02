# GameHub game server

Realtime WebSocket server for GameHub. Tables live **in memory** here, each with its own timers, so a bot's
move, a turn timing out, or another player's action reaches everyone at the table in well under a second —
no polling, no per-move database round trip. Logins and coins stay in Supabase: this server only verifies a
player's Supabase access token, then moves their coins through `wallet_move` (same ledger/audit trail as the
rest of the app).

Games on this server so far: **Teen Patti** (`src/teenpatti.ts`). More move over one at a time; each gets its
own engine file alongside it, following the same pattern (an in-memory table class, a `Clock` interface so the
engine can be tested with virtual time, a `Wallet` interface so it can be tested without hitting Supabase).

## Running locally

```bash
npm install
cp ../.env.local .env   # or set SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY yourself
npm run dev             # ts-node-style watch mode
```

`npm test` runs the engine tests on a virtual clock (`test/run.ts`) — thousands of simulated hands in seconds,
no network needed. Run these after any change to an engine file.

## Environment variables

| Var | Where it comes from |
|---|---|
| `SUPABASE_URL` | Same value as the app's `NEXT_PUBLIC_SUPABASE_URL` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API. **Never** expose this to a browser. |
| `PORT` | Set by Railway automatically |

The app needs the matching public URLs so it can connect:

```
NEXT_PUBLIC_GAME_SERVER_WS=wss://<your-railway-domain>/ws
NEXT_PUBLIC_GAME_SERVER_HTTP=https://<your-railway-domain>
```

## Deploying (Railway CLI)

This project is linked to a Railway project (`railway status` to check). To deploy a change:

```bash
cd server
railway up --service game-server --detach
```

Region is pinned to Singapore (`asia-southeast1-eqsg3a`) for latency to Indian players — see
`railway.json`'s `multiRegionConfig`, or re-pin with:

```bash
railway service scale --service game-server southeast-asia=1 sfo=0
```

`/health` returns `{ ok, tables, players }` — Railway's health check polls this. `/lobby` returns real player
counts per table (`{"teen-patti": {"10": 3, ...}}`), used by the app's lobby screens; it needs no auth.

## Shutdown behaviour

On `SIGTERM` (Railway redeploys/restarts the service), the server refunds the boot/stakes of any hand that
can't finish, tells connected clients it's restarting, and waits (up to 8s) for those refunds to reach
Supabase before exiting — so a deploy never costs a player coins mid-hand. Clients reconnect and resume their
seat automatically (seats are keyed by account, not by connection).
