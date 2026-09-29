# GameHub — Unified Multiplayer Gaming Hub (demo)

Client demo built from the *Unified Multiplayer Gaming Hub PRD v3.0*: 9 games, 1 account, 1 wallet.

| Route | App |
|---|---|
| `/` | Player app (mobile, capped at 430px): splash → OTP login → home, games, lobbies, game tables, wallet, profile |
| `/admin` | Admin & Agency dashboard (responsive): KPIs, users, KYC queue, withdrawal approvals, game config, risk flags, audit log |

Built with Next.js 16, React 19, Tailwind 4, Poppins and lucide icons. All game art is CSS/emoji, so there are no image assets.

> **Demo build.** Everything uses sample data in `app/lib/data.ts` and lives in memory, so a refresh resets it. The OTP accepts any 6 digits, the admin login accepts any password, and payments are simulated. Opponents are bots, and all game logic runs in the browser. In production the server owns shuffles, rolls, timers and payouts (PRD §4). Dashed **Demo:** buttons skip ahead (fill number/OTP, arrange a winning Rummy hand, finish a Ludo game).

## What's playable

- **Dragon Tiger, Andar Bahar, Lucky 7**: 15 s betting timer, chips, undo/rebet/double, deal, payouts (Tie 8:1 with 50% refund, Exactly 7 = 11:1), and the last 20 results.
- **Teen Patti**: blind/seen, chaal, raise, pack, show, full hand ranking, pot limit, and auto-pack on timeout.
- **Poker (Hold'em)**: pre-flop → flop → turn → river → showdown, with best-5-of-7 evaluation.
- **13 Card Rummy**: 2 decks + wild joker, draw/discard, sort, group, drop, and declare validation (pure sequence / sequence / set).
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
