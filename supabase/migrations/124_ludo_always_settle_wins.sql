-- 124: Always settle wins on Ludo (and all board games).
--
-- Before: 050_ludo_outcome_control.sql added a `get_outcome_mode(me.id, game) = 'force_loss'` check inside
-- `game_payout` and `ld_finish`. After 119_rtp_all_games.sql, `get_outcome_mode(..., 'ludo')` returns 'force_loss'
-- ~52% of the time even when Ludo is set to 'fair', causing `game_payout` to reject legitimate wins with
-- 'Game outcome resulted in loss' and `ld_finish` to pay the wrong seat.
--
-- Outcome control for Ludo / Chess already tilts the dice during play (pickOutcomeDice / ld_roll). Once a player
-- wins on the board, `game_payout` and `ld_finish` must always pay out (subject to the stake caps from 017).

begin;

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

revoke execute on function public.game_payout(bigint, text, text) from public, anon;
grant execute on function public.game_payout(bigint, text, text) to authenticated;

create or replace function public.ld_finish(t public.ld_tables, w int) returns public.ld_tables
language plpgsql volatile security definer set search_path = public as $$
begin
  t.status := 'done'; t.winner := w; t.phase := null; t.turn_ends := null;
  t.prize := floor(t.pot * (1 - public.ld_fee()));
  if t.prize > 0 then
    perform public.wallet_move((t.seats -> w ->> 'uid')::uuid, t.prize, 'win', 'Ludo • Private ' || t.code);
  end if;
  return t;
end;
$$;

commit;
notify pgrst, 'reload schema';
