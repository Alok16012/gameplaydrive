# Classic Teen Patti — house rules

These are the exact rules the engine in this folder implements (`evaluator.ts`, `engine.ts`, `table.ts`).
They are this application's rules, not poker's and not any other Teen Patti variant.

## Setup
- 2–6 players, one 52-card deck, no jokers. Ranks 2–10, J 11, Q 12, K 13, A 14. Suits never rank.
- Every participant pays the same **boot** before the deal; only players who can afford it take part;
  boot and deal are one atomic step; a hand needs at least two participants.
- Everyone starts **blind**. First turn: the seat clockwise after the dealer. The dealer button moves to the
  next occupied seat each hand. A player who joins mid-hand waits for the next one.

## Hand ranking (strongest first)
1. **Trail** — three of a kind. AAA > KKK > … > 222.
2. **Pure sequence** — three consecutive ranks, same suit.
3. **Sequence** — three consecutive ranks, mixed suits.
4. **Color** — same suit, not a sequence. Compare highest, then middle, then lowest card.
5. **Pair** — compare the pair rank, then the third card.
6. **High card** — compare highest, middle, lowest.

Sequence order (pure and mixed alike):
**AKQ > A23 > KQJ > QJ10 > J109 > 1098 > 987 > 876 > 765 > 654 > 543 > 432.**
Ace is high only in AKQ and low only in A23 — KA2 is not a sequence (same suit: a Color).

A stronger category beats every hand of a weaker one. Equal ranks tie regardless of suit; who loses a tied show
is a game rule (below), not a card rule.

## Betting
- The table keeps a **base stake**, starting at the boot.
- Blind: **min** = base, **double** = 2 × base. After a blind bet, base = the amount paid.
- Seen: **min** = 2 × base, **double** = 4 × base. After a seen bet, base = the amount paid ÷ 2.
- Every bet is a full fresh payment (no "matching"). Pack and See never change the base.
- A double that would push the base above the table maximum is refused; the minimum is always allowed.
- No all-in, side pots or partial bets: if you can't afford an action it is refused and nothing changes. You may
  spend your exact remaining balance. A zero balance does not fold you — you can still win.

## See, pack, show, side show
- **See cards** only on your own turn, and only after at least **1 blind chaal** (table setting `minBlind`); it
  doesn't end the turn or add time. Once seen, always seen. After **3 blind chaals** (`blindLimit`, from
  Admin → Game Config) a player is seen automatically when their next turn comes.
- **Pack** only on your turn. Packed players' money stays in the pot and their cards stay private.
  If one player is left, they win at once with no fee and no reveal.
- **Show** — exactly two players left, on your turn:
  blind vs blind: fee = base; blind vs seen: fee = base; seen vs seen: fee = 2 × base;
  **seen vs blind: not allowed.** Better hand takes the pot; **equal hands: the requester loses**. Both hands are
  revealed; the fee does not change the base.
- **Side show** — three or more left, you are seen, and the previous bettor is still in and seen: fee = 2 × base,
  paid once, kept whatever happens. The previous bettor may accept or reject (10 s, timeout = reject).
  Accept: the weaker hand packs, **equal: the requester packs**; only the two of them learn the result, nobody sees
  cards. Play continues clockwise after the requester.

## Limits
- **Pot cap**: once the pot reaches it (a full bet, show fee or side-show fee is never trimmed), every player
  still in shows at once — no fee, strongest hand wins, equal hands split the pot, odd chips go one each
  clockwise after the dealer. A side-show fee that reaches the cap goes straight to this showdown; a show fee
  still settles as a paid show.
- **Max turn actions** (optional): bets, side-show requests and packs count; see-cards and side-show answers don't.

## Leaving, timers, disconnects
- Turn timeout → auto-pack. Side-show answer timeout → auto-reject. Deadlines run on server time and never reset
  when you reconnect; a late action is refused after the timeout is applied.
- Losing the connection does not fold you. Leaving the table mid-hand packs you at once and refunds nothing.
- Leaving during a pending side show: if you asked or were asked, the request is cancelled (fee kept); if fewer
  than three remain it is cancelled too; otherwise it stays pending.

## Money
- No rake in this version: every chip paid in is paid out to the winner(s).
- A voided hand refunds each player exactly what they paid in, exactly once.
