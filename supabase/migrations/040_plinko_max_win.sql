-- 040: Plinko can no longer pay a fortune from one ball.
--
-- Before: any board took bets up to 10,000, so 16 rows / high (1000x) could pay 1 crore per ball, and a 1,000 bet
-- paid 10 lakh. Force Win also aimed at every slot above 1x, edges included, so under Force Win 1000x came up about
-- once every 6,900 balls and the board returned about 4x what was staked.
-- Now:
--   • one ball pays at most 1,00,000 coins. Each board's max bet is 1,00,000 ÷ its best multiplier (16 rows / high:
--     100 coins, 12 rows / high: 588, ...), never above 10,000, so the multipliers shown are still what is paid;
--   • Force Win only aims at slots paying more than 1x and at most 10x.
-- Fair mode odds are unchanged. Safe to run more than once. Run it in the Supabase SQL Editor.

create or replace function public.plinko_max_bet(p_rows int, p_risk text) returns bigint
language sql stable set search_path = public as $$
  select least(10000, floor(100000 / (select max(m) from unnest(public.plinko_table(p_rows, p_risk)) m)))::bigint;
$$;

create or replace function public.plinko_drop(p_amount bigint, p_rows int, p_risk text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  mults numeric[] := public.plinko_table(p_rows, p_risk);
  max_bet bigint;
  path int[] := '{}'; slot int := 0; step int; m numeric; pay bigint; bal bigint; note text;
  mode text;
  target_slot int;
  steps_remaining int;
  needed_ones int;
  w numeric[]; total numeric := 0; r numeric; c numeric := 1; k int;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if mults is null then raise exception 'Invalid board'; end if;
  max_bet := public.plinko_max_bet(p_rows, p_risk);
  if p_amount < 10 or p_amount > max_bet then raise exception 'Bet between 10 and % coins on this board', max_bet; end if;

  mode := public.get_outcome_mode(me.id, 'plinko');
  target_slot := null;
  if mode in ('force_loss', 'force_win') then
    -- Weight each eligible slot by C(rows, k), the chance a free-falling ball lands there.
    w := array_fill(0::numeric, array[p_rows + 1]);
    for k in 0 .. p_rows loop
      if k > 0 then c := c * (p_rows - k + 1) / k; end if;
      if (mode = 'force_loss' and mults[k + 1] < 1) or (mode = 'force_win' and mults[k + 1] > 1 and mults[k + 1] <= 10) then
        w[k + 1] := c;
        total := total + c;
      end if;
    end loop;
    if total > 0 then
      r := random() * total;
      for k in 0 .. p_rows loop
        r := r - w[k + 1];
        if w[k + 1] > 0 and r < 0 then target_slot := k; exit; end if;
      end loop;
    end if;
  end if;

  if target_slot is not null then
    needed_ones := target_slot;
    for i in 1 .. p_rows loop
      steps_remaining := p_rows - i + 1;
      if needed_ones >= steps_remaining then
        step := 1;
      elsif needed_ones <= 0 then
        step := 0;
      else
        step := case when random() < (needed_ones::float / steps_remaining::float) then 1 else 0 end;
      end if;
      needed_ones := needed_ones - step;
      path := path || step;
      slot := slot + step;
    end loop;
  else
    for i in 1 .. p_rows loop
      step := case when random() < 0.5 then 0 else 1 end;
      path := path || step;
      slot := slot + step;
    end loop;
  end if;

  m := mults[slot + 1];
  pay := least(floor(p_amount * m), 100000);
  note := 'Plinko • ' || p_rows || ' rows • ' || p_risk || ' • ' || m || 'x';
  bal := public.wallet_move(me.id, -p_amount, 'bet', note);
  if bal is null then raise exception 'Not enough coins'; end if;
  if pay > 0 then bal := public.wallet_move(me.id, pay, case when pay >= p_amount then 'win' else 'refund' end, note); end if;
  return jsonb_build_object('path', to_jsonb(path), 'slot', slot, 'mult', m, 'payout', pay, 'balance', bal);
end;
$$;
