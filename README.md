# GameHub — Unified Multiplayer Gaming Hub (demo)

Client demo built from the *Unified Multiplayer Gaming Hub PRD v3.0*: 9 games, 1 account, 1 wallet.

| Route | App |
|---|---|
| `/` | Player app (mobile, capped at 430px): splash → OTP login → home, games, lobbies, game tables, wallet, profile |
| `/admin` | Role-based console (responsive) for Super Admin, Admin and Agent |

Built with Next.js 16, React 19, Tailwind 4, Poppins and lucide icons. All game art is CSS/emoji, so there are no image assets.

> **Demo build.** Everything uses sample data in `app/lib/data.ts` and lives in memory, so a refresh resets it. The OTP accepts any 6 digits, the admin login accepts any password, and payments are simulated. Opponents are bots, and all game logic runs in the browser. In production the server owns shuffles, rolls, timers and payouts (PRD §4). Dashed **Demo:** buttons skip ahead (fill number/OTP, arrange a winning Rummy hand, finish a Ludo game).

## Tables & bots

Every table deals by itself: a short countdown when you sit down, then the result shows and the next game (or next deal in Pool/Deals Rummy) starts automatically — there is no "Play Again". Opponents are drawn from `app/lib/botpool.ts`: with auto-generate on, every table gets fresh names and avatars, and some seats change between games. Super Admin manages this in **/admin → Bots** (auto-generate switch, custom bots, bulk generate).

## Roles

| Role | Signs in | Can create | Sees |
|---|---|---|---|
| Super Admin | `/admin` (`superadmin`) | Admins, agents, players | Everything: dashboard, network, KYC, withdrawals, game config, risk, audit |
| Admin | `/admin` (`admin`, `admin2`) | Agents, players | Own agents and their players, network, audit |
| Agent | `/admin` (`agent`, `agent2`, `agent3`) | Players | Own players |
| Player | `/` with mobile + OTP | — | Plays games |

Demo password for every staff account is `demo1234`. There is no self sign-up: a player can only sign in with a mobile number that an agent, admin or super admin registered (for example `9876543210`). Freezing an account blocks its sign-in. Accounts live in `app/lib/hierarchy.ts` and are saved in the browser's localStorage so `/admin` and `/` share them; Super Admin has **Reset demo data** in the sidebar.

## What's playable

- **Dragon Tiger, Andar Bahar, Lucky 7**: 15 s betting timer, chips, undo/rebet/double, deal, payouts (Tie 8:1 with 50% refund, Exactly 7 = 11:1), and the last 20 results.
- **Teen Patti**: blind/seen, chaal, raise, pack, show, side show, full hand ranking, pot limit, and auto-pack on timeout. After you pack, the rest of the table plays on until someone wins.
- **Poker (Hold'em)**: pre-flop → flop → turn → river → showdown, with best-5-of-7 evaluation.
- **13 Card Rummy**: Points, Pool 101, Pool 201 and Deals (best of 2/3) formats; 30 s per move for every player; 2 decks + wild joker, draw/discard, sort, group, drop, and declare validation (pure sequence / sequence / set); per-deal scoreboard.
- **Ludo**: 4 players, 52-step track + home column, safe squares, captures, 6 bonus roll, three-sixes rule.
- **Chess, Carrom**: preview boards.
- **Wallet**: Deposit / Winning / Bonus buckets. Debits use Bonus first (capped at 10%), then Deposit, then Winning. Withdrawals come from Winning only. Add Cash and Withdraw flows, full transaction ledger.
- **Account**: KYC, game history, responsible gaming limits and self-exclusion, help/FAQ, settings.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000 (use a phone-width window) and http://localhost:3000/admin.

## Where things live

- `app/components/GameHubApp.tsx`: app shell, navigation stack, bottom nav
- `app/components/screens/`: Auth (splash/login), Main (home/games/lobby), WalletScreens, Account
- `app/components/games/`: Casino, CardTable (Teen Patti/Poker), Rummy, Board (Ludo/Chess/Carrom)
- `app/lib/store.tsx`: in-memory wallet + ledger; `app/lib/hands.ts`: hand evaluators; `app/lib/data.ts`: demo data
- `app/admin/AdminApp.tsx`: admin console
