-- 041: A game won on the board is always paid.
-- Before: under Force Loss, game_payout refused every win for games played in the browser (Ludo, Carrom, Chess, Poker,
-- Teen Patti vs computer) — the player saw "You won" and got "Game outcome resulted in loss" instead of the coins.
-- Now the payout follows the board in every mode; the stake caps from 017 still apply. Win / Loss Control is unchanged
-- for server-run games (Aviator, Roulette, Plinko, Blackjack, ...), where the server decides the result itself.
-- Safe to run more than once. Run it in the Supabase SQL Editor.

create or replace function public.game_payout(amount bigint, p_note text, p_kind text default 'win') returns bigint
language plpgsql security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  bal bigint;
  g text := public.game_key(p_note);
  open bigint;
  cap bigint;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if amount <= 0 or p_kind not in ('win', 'refund') then raise exception 'Invalid payout'; end if;

  perform 1 from game_stakes where user_id = me.id and game = g and not settled for update;
  select coalesce(sum(s.amount), 0) into open from game_stakes s
    where s.user_id = me.id and s.game = g and not s.settled and s.created_at > now() - interval '3 hours';
  cap := case when p_kind = 'refund' then open else floor(open * public.game_max_mult(g)) end;
  if open = 0 or amount > cap then raise exception 'Payout rejected'; end if;
  update game_stakes set settled = true where user_id = me.id and game = g and not settled;
  update wallets set coins = coins + amount, updated_at = now() where user_id = me.id returning coins into bal;
  insert into ledger (user_id, amount, balance_after, kind, note) values (me.id, amount, bal, p_kind, p_note);
  return bal;
end;
$$;
