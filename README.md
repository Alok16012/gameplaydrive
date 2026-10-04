# GameHub — Unified Multiplayer Gaming Hub (demo)

Client demo built from the *Unified Multiplayer Gaming Hub PRD v3.0*: 14 games, 1 account, 1 wallet.

| Route | App |
|---|---|
| `/` | Player app (mobile, capped at 430px): splash → OTP login → home, games, lobbies, game tables, wallet, profile |
| `/admin` | Role-based console (responsive) for Super Admin, Admin and Agent |

Built with Next.js 16, React 19, Tailwind 4, Poppins and lucide icons. All game art is CSS/emoji, so there are no image assets.

> **Virtual coins only.** Coins have no cash value and can't be bought or withdrawn. Accounts, wallets, the coin ledger, bots and the audit log live in Supabase.

## Tables & bots

Every table deals by itself: a short countdown when you sit down, then the result shows and the next game (or next deal in Pool/Deals Rummy) starts automatically — there is no "Play Again". Opponents are drawn from `app/lib/botpool.ts` and always carry a **BOT** label: with auto-generate on, every table gets fresh names and avatars, and some seats change between games. Super Admin manages this in **/admin → Bots** (auto-generate switch, custom bots, bulk generate).

## Roles

| Role | Signs in | Can create | Sees |
|---|---|---|---|
| Super Admin | `/admin` | Admins, agents, players + creates coins | Everything: dashboard, network, bots, game config, audit |
| Admin | `/admin` | Agents, players | Own agents and their players, network, audit |
| Agent | `/admin` | Players | Own players, audit |
| Player | `/` with mobile + password | — | Plays games |

There is no self sign-up. Freezing an account blocks its sign-in and all coin/game actions.

## What's playable

- **Dragon Tiger, Andar Bahar, Lucky 7**: 15 s betting timer, chips, undo/rebet/double, deal, payouts (Tie 8:1 with 50% refund, Exactly 7 = 11:1), and the last 20 results.
- **Teen Patti** (server): blind/seen, chaal, raise, pack, show, side show, pot limit, auto-pack on timeout. After you pack, the rest of the table plays on until someone wins.
- **Poker (Hold'em)**: pre-flop → flop → turn → river → showdown, with best-5-of-7 evaluation.
- **13 Card Rummy** (server): Points, Pool 101, Pool 201 and Deals (best of 2/3); 30 s per move; sort, group, drop, declare; per-deal scoreboard with the winning hand.
- **Ludo**: 4 players, 52-step track + home column, safe squares, captures, 6 bonus roll, three-sixes rule. Tokens walk square by square with a hop; the dice tumbles before it lands.
- **Carrom**: real physics (friction, rebounds, collisions, pockets). Slide the striker, drag back and release to shoot. White vs the bot's black: own coin +1 and shoot again, queen +2, striker in a pocket is a foul (−1); first to 5.
- **Roulette** (server): European single-zero wheel; numbers ×36, dozens/columns ×3, red/black, even/odd, 1-18/19-36 ×2; undo/clear/rebet/double and your last 20 numbers.
- **Blackjack** (server): six decks shuffled per hand, dealer stands on all 17s, blackjack pays 3:2, hit/stand/double/split (one split; split aces get one card). An unfinished hand resumes when you return.
- **Plinko** (server): 8/12/16 rows × low/medium/high risk, ~99% return on every board, several balls in the air at once.
- **Private tables**: the creator picks any amount — Teen Patti boot 1-10,000; Rummy 1-100 per point (Points) or 10-10,000 entry (Pool/Deals).
- **Chess**: full rules (legal moves only, check, checkmate, stalemate, castling, en passant, promotion) against a computer that searches a few moves ahead — it captures loose pieces and goes for mate. 10-minute clocks; a draw refunds the entry.
- **Wallet**: one virtual-coin balance from Supabase and the full coin history (received, bets, winnings, refunds). "Get Coins" points players to their agent.
- **Account**: game history (from the coin ledger), responsible gaming limits and self-exclusion, help/FAQ, settings.

## Setup

1. **Database:** in Supabase → SQL Editor, run [`supabase/migrations/001_init.sql`](supabase/migrations/001_init.sql), then [`002_game_server.sql`](supabase/migrations/002_game_server.sql), then [`003_teen_patti_rummy.sql`](supabase/migrations/003_teen_patti_rummy.sql) and every later file in `supabase/migrations/` in number order (004 … 014), once each. A brand-new project can run [`supabase/setup_all.sql`](supabase/setup_all.sql) instead.
2. **Auth settings:** Supabase → Authentication → Sign In / Providers → turn **off** "Allow new users to sign up" (accounts are only created from the admin console).
3. **Env vars:** copy `.env.example` to `.env.local` and fill in the project URL, anon key and service-role key. On Netlify add the same three under Site configuration → Environment variables. The service-role key is server-only.
4. **First login:** create the Super Admin once:
   ```bash
   node --env-file=.env.local scripts/create-superadmin.mjs <username> <password> "<Full name>"
   ```
5. Run it:
   ```bash
   npm install
   npm run dev
   ```
   Player app: http://localhost:3000 • Admin console: http://localhost:3000/admin

## Game server (Supabase)

Games that run on the server — the database shuffles, deals, times turns, plays the bots and moves coins:

| Game | How |
|---|---|
| Teen Patti | Shared multiplayer tables in `tp_tables`: blind/seen, chaal, raise, pack, show, side show, pot limit. Real players at the same boot sit together; labelled bots fill the rest. Private tables by invite code (friends only, no bots). |
| 13 Card Rummy | `rm_tables`: Points, Pool 101, Pool 201, Deals ×2/×3. Two decks + wild joker, 30 s turns, drop/middle drop, server-validated declarations, wrong-show penalty, losers scored by the better of their own arrangement and the server's best grouping. Bots play honestly (they can only declare a truly valid hand). Private tables by invite code. |
| Dragon Tiger, Andar Bahar, Lucky 7 | `casino_round()` deals and settles each round you bet on. |
| Roulette, Plinko | `roulette_spin()` / `plinko_drop()` draw the number / every bounce and pay out in one call (migration 012). |
| Blackjack | `bj_hands`: `bj_deal()`, `bj_act()` (hit/stand/double/split), `bj_state()`. The shoe and the dealer's hole card never leave the database until the hand is over (migration 012). |

Each player only ever receives their own cards. Clients follow tables through Supabase Realtime and call `tp_tick()` / `rm_tick()` when a deadline passes (turn timeout, bot move, next deal). Platform fee, turn time and on/off per game are set by the Super Admin in **Admin → Game Config**.

Still on-device practice (payouts capped server-side at 100× recent stakes): Poker, Ludo, Chess, Carrom. Moving to a dedicated Node server (e.g. Railway) later keeps the same tables and rules.

## Coins & accounts

- **Super Admin** is the only account that can create coins. Admins and agents can only pass on coins they hold, and can take coins back from their own downline.
- Staff sign in with username + password; players sign in with their mobile number + the password their agent set.
- Every account only sees itself and its downline (Postgres row-level security); every change is written to `audit_log`.

## Where things live

- `app/components/GameHubApp.tsx`: app shell, navigation stack, bottom nav
- `app/components/screens/`: Auth (splash/login), Main (home/games/lobby), WalletScreens, Account
- `app/components/games/`: Casino, CardTable (Teen Patti/Poker), Rummy, Board (Ludo/Chess/Carrom)
- `app/lib/store.tsx`: in-memory wallet + ledger; `app/lib/hands.ts`: hand evaluators; `app/lib/data.ts`: demo data
- `app/admin/AdminApp.tsx`: admin console
