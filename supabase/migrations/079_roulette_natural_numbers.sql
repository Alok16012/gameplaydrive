-- 079: Roulette — a losing spin lands on a natural-looking number, not on 0 every time.
--
-- roulette_spin() under force_loss scanned 0..36 for the number that paid the player least and stopped at the
-- first one that paid nothing. 0 is checked first and hardly anyone bets on it, so nearly every losing spin landed
-- on 0: in the week to 2026-10-24, 35 of 153 spins (23%) were 0, and 30 of the 87 losing spins. Players notice.
--
-- Now the number is drawn at random from all the numbers that make the player lose on balance (payout below the
-- stake), so 0 comes up about as often as any other number; under force_win, at random from the numbers that make
-- them win on balance. Only when no such number exists (every number covered) does it fall back to the single
-- least / most paying one. The wallet, ledger and history logic is unchanged.
--
-- Safe to run more than once.

begin;

-- The number a spin lands on, for a set of bets and an outcome mode. Pure: the same inputs give the same set of
-- candidates; the pick among them is random.
create or replace function public.rl_pick(p_bets jsonb, p_mode text) returns int
language plpgsql volatile set search_path = public as $$
declare
  stake bigint := 0; b jsonb; cand_n int; cand_pay bigint; pays bigint[] := '{}';
  wanted int[] := '{}'; best int := 0; best_pay bigint;
begin
  for b in select * from jsonb_array_elements(p_bets) loop stake := stake + (b ->> 'v')::bigint; end loop;
  for cand_n in 0 .. 36 loop
    cand_pay := 0;
    for b in select * from jsonb_array_elements(p_bets) loop
      cand_pay := cand_pay + (b ->> 'v')::bigint * coalesce(public.rl_pay(b ->> 'side', cand_n), 0);
    end loop;
    pays := pays || cand_pay;
  end loop;

  if p_mode = 'force_loss' then
    -- Every number that leaves the player down: the least-paying number only when nothing leaves them down.
    best_pay := null;
    for cand_n in 0 .. 36 loop
      if pays[cand_n + 1] < stake then wanted := wanted || cand_n; end if;
      if best_pay is null or pays[cand_n + 1] < best_pay then best_pay := pays[cand_n + 1]; best := cand_n; end if;
    end loop;
  elsif p_mode = 'force_win' then
    best_pay := null;
    for cand_n in 0 .. 36 loop
      if pays[cand_n + 1] > stake then wanted := wanted || cand_n; end if;
      if best_pay is null or pays[cand_n + 1] > best_pay then best_pay := pays[cand_n + 1]; best := cand_n; end if;
    end loop;
  else
    return floor(random() * 37)::int;
  end if;

  if coalesce(array_length(wanted, 1), 0) = 0 then return best; end if;
  -- 0 is one losing number among many, but a losing set is short (the player's bets cover a lot), so 0 would still
  -- come up a few times more often than on a real wheel. Keep it in the draw only now and then.
  if array_length(wanted, 1) > 1 and 0 = any (wanted) and random() < 0.7 then wanted := array_remove(wanted, 0); end if;
  return wanted[1 + floor(random() * array_length(wanted, 1))::int];
end;
$$;

create or replace function public.roulette_spin(p_bets jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  b jsonb; stake bigint := 0; ret bigint := 0; n int; bal bigint; spin_id bigint;
  mode text;
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

  insert into rl_spins (user_id, num, stake, payout) values (me.id, n, stake, ret) returning id into spin_id;
  bal := public.wallet_move(me.id, -stake, 'bet', 'Roulette • Spin #' || spin_id);
  if bal is null then raise exception 'Not enough coins'; end if;
  if ret > 0 then bal := public.wallet_move(me.id, ret, 'win', 'Roulette • Spin #' || spin_id || ' • ' || n); end if;
  return jsonb_build_object('id', spin_id, 'number', n, 'stake', stake, 'payout', ret, 'balance', bal, 'history', public.rl_history());
end;
$$;

revoke execute on function public.rl_pick(jsonb, text) from public, anon, authenticated;
revoke execute on function public.roulette_spin(jsonb) from public, anon;
grant execute on function public.roulette_spin(jsonb) to authenticated;

commit;
