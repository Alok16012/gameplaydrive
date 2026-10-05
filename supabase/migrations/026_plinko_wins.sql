-- 026: Plinko pays are winnings. Whatever a ball pays back (even a 0.5x slot) is booked as 'win' — it was
-- booked as 'refund' when it paid less than the stake, so it showed under Refunds. Reports already count
-- 'win' and 'refund' together as payouts, so totals don't change. Earlier Plinko rows are relabelled too.
-- Safe to run more than once. Run it in the Supabase SQL Editor.

create or replace function public.plinko_drop(p_amount bigint, p_rows int, p_risk text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  mults numeric[] := public.plinko_table(p_rows, p_risk);
  path int[] := '{}'; slot int := 0; step int; m numeric; pay bigint; bal bigint; note text;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if mults is null then raise exception 'Invalid board'; end if;
  if p_amount < 10 or p_amount > 10000 then raise exception 'Bet between 10 and 10,000 coins'; end if;
  for i in 1 .. p_rows loop
    step := case when random() < 0.5 then 0 else 1 end;
    path := path || step;
    slot := slot + step;
  end loop;
  m := mults[slot + 1];
  pay := floor(p_amount * m);
  note := 'Plinko • ' || p_rows || ' rows • ' || p_risk || ' • ' || m || 'x';
  bal := public.wallet_move(me.id, -p_amount, 'bet', note);
  if bal is null then raise exception 'Not enough coins'; end if;
  if pay > 0 then bal := public.wallet_move(me.id, pay, 'win', note); end if;
  return jsonb_build_object('path', to_jsonb(path), 'slot', slot, 'mult', m, 'payout', pay, 'balance', bal);
end;
$$;

update public.ledger set kind = 'win' where kind = 'refund' and note like 'Plinko •%';
