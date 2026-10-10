-- Plinko under Win / Loss Control no longer sends every ball to the same slot.
-- force_loss used to aim every ball at the exact centre slot and force_win at slot 1 / rows-1, so a run of drops
-- all landed in one place. Now the target is drawn from every losing slot (pays < 1x) or every winning slot
-- (pays > 1x), weighted by how often a real ball reaches it (binomial), and the path to it stays random.
-- Fair mode is unchanged.

create or replace function public.plinko_drop(p_amount bigint, p_rows int, p_risk text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  mults numeric[] := public.plinko_table(p_rows, p_risk);
  path int[] := '{}'; slot int := 0; step int; m numeric; pay bigint; bal bigint; note text;
  mode text;
  target_slot int;
  steps_remaining int;
  needed_ones int;
  w numeric[]; total numeric := 0; r numeric; c numeric := 1; k int;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if mults is null then raise exception 'Invalid board'; end if;
  if p_amount < 10 or p_amount > 10000 then raise exception 'Bet between 10 and 10,000 coins'; end if;

  mode := public.get_outcome_mode(me.id, 'plinko');
  target_slot := null;
  if mode in ('force_loss', 'force_win') then
    -- Weight each eligible slot by C(rows, k), the chance a free-falling ball lands there.
    w := array_fill(0::numeric, array[p_rows + 1]);
    for k in 0 .. p_rows loop
      if k > 0 then c := c * (p_rows - k + 1) / k; end if;
      if (mode = 'force_loss' and mults[k + 1] < 1) or (mode = 'force_win' and mults[k + 1] > 1) then
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
  pay := floor(p_amount * m);
  note := 'Plinko • ' || p_rows || ' rows • ' || p_risk || ' • ' || m || 'x';
  bal := public.wallet_move(me.id, -p_amount, 'bet', note);
  if bal is null then raise exception 'Not enough coins'; end if;
  if pay > 0 then bal := public.wallet_move(me.id, pay, case when pay >= p_amount then 'win' else 'refund' end, note); end if;
  return jsonb_build_object('path', to_jsonb(path), 'slot', slot, 'mult', m, 'payout', pay, 'balance', bal);
end;
$$;
