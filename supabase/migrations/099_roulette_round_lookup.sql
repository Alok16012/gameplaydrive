-- Roulette: keep the "Round #" the table shows (and the bets), so the admin Round Lookup can find a spin by it.
-- The round number is the client's (like casino_round's p_round); it was never sent, so the lookup found nothing.
-- Ledger notes now read "Roulette • Round #<round> • Spin #<id>" (and "… • <number>" on a win), so Bet History
-- joins the stake and the win of one spin by its round. Spins before this can be found by their Spin # (rl_spins.id).

alter table rl_spins add column if not exists round text;
alter table rl_spins add column if not exists bets jsonb; -- what was bet, for the lookup
create index if not exists rl_spins_round_idx on rl_spins (round);

drop function if exists public.roulette_spin(jsonb);

create or replace function public.roulette_spin(p_bets jsonb, p_round text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  me profiles := public.current_profile();
  b jsonb; stake bigint := 0; ret bigint := 0; n int; bal bigint; spin_id bigint;
  mode text; rnd text := nullif(left(regexp_replace(coalesce(p_round, ''), '[^0-9]', '', 'g'), 12), '');
  tag text;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if jsonb_typeof(p_bets) <> 'array' or jsonb_array_length(p_bets) = 0 then raise exception 'Place a bet first'; end if;
  for b in select * from jsonb_array_elements(p_bets) loop
    if public.rl_pay(b ->> 'side', 0) is null or coalesce((b ->> 'v')::bigint, 0) <= 0 then raise exception 'Invalid bet'; end if;
    stake := stake + (b ->> 'v')::bigint;
  end loop;
  if stake > 100000 then raise exception 'Max 100,000 coins per spin'; end if;

  mode := public.get_outcome_mode(me.id, 'roulette');
  n := public.rl_pick(p_bets, mode);

  for b in select * from jsonb_array_elements(p_bets) loop
    if public.rl_pay(b ->> 'side', n) > 0 then
      ret := ret + (b ->> 'v')::bigint * public.rl_pay(b ->> 'side', n);
    end if;
  end loop;

  insert into rl_spins (user_id, num, stake, payout, round, bets) values (me.id, n, stake, ret, rnd, p_bets) returning id into spin_id;
  tag := 'Roulette • ' || coalesce('Round #' || rnd || ' • ', '') || 'Spin #' || spin_id;
  bal := public.wallet_move(me.id, -stake, 'bet', tag);
  if bal is null then raise exception 'Not enough coins'; end if;
  if ret > 0 then bal := public.wallet_move(me.id, ret, 'win', tag || ' • ' || n); end if;
  return jsonb_build_object('id', spin_id, 'number', n, 'stake', stake, 'payout', ret, 'balance', bal, 'history', public.rl_history());
end;
$function$;

revoke all on function public.roulette_spin(jsonb, text) from public, anon;
grant execute on function public.roulette_spin(jsonb, text) to authenticated;
notify pgrst, 'reload schema';
