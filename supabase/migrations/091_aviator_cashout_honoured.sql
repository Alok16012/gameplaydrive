-- 091: Aviator — every cash-out is honoured; the house edge lives in the crash point, not in refusing the tap.
--
-- 047 refused a force_loss player's cash-out outright ("Too late — the plane flew away at 1.58x") while the plane
-- was still visibly climbing on their screen, and never paid their auto cash-out even when the plane passed it.
-- Players saw two things: a tap that did nothing, and the crash point announced before the crash. Both go.
-- av_bet() already pulls the round's crash down (1.30x-1.85x, or just under the player's auto target) when a
-- force_loss player bets, so such a player still loses unless they cash out very early — and that is the one
-- thing a crash game must always let them do. Cash-outs pay the multiplier at the moment the request lands,
-- never above the crash; auto cash-outs that the plane reached are paid at settlement.
--
-- Safe to run more than once.

begin;

create or replace function public.av_cashout(p_slot int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  r av_rounds;
  b av_bets;
  m numeric;
  pay bigint;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  select * into r from av_rounds order by id desc limit 1;
  if r.id is null or now() < r.starts_at then raise exception 'The plane has not taken off yet'; end if;
  if now() >= r.crash_at then raise exception 'Too late — the plane flew away at %x', r.crash; end if;

  select * into b from av_bets where round_id = r.id and user_id = me.id and slot = p_slot for update;
  if b.id is null then raise exception 'No bet to cash out'; end if;
  if b.cash_mult is not null then raise exception 'Already cashed out'; end if;

  m := floor(exp(0.1 * extract(epoch from (now() - r.starts_at))) * 100) / 100;
  if b.auto is not null and m >= b.auto then m := b.auto; end if;
  m := least(m, r.crash);
  pay := floor(b.amount * m);
  update av_bets set cash_mult = m, payout = pay where id = b.id;
  perform public.wallet_move(me.id, pay, 'win', 'Aviator • Round #' || r.id || ' • ' || to_char(m, 'FM9990.00') || 'x');
  return public.av_state();
end;
$$;

create or replace function public.av_settle() returns void
language plpgsql security definer set search_path = public as $$
declare
  r av_rounds;
  b av_bets;
begin
  for r in select * from av_rounds where not settled and crash_at <= now() order by id for update skip locked loop
    for b in select * from av_bets where round_id = r.id and cash_mult is null and auto is not null and auto <= r.crash for update loop
      update av_bets set cash_mult = b.auto, payout = floor(b.amount * b.auto) where id = b.id;
      perform public.wallet_move(b.user_id, floor(b.amount * b.auto)::bigint, 'win', 'Aviator • Round #' || r.id || ' • auto ' || to_char(b.auto, 'FM9990.00') || 'x');
    end loop;
    update av_rounds set settled = true where id = r.id;
  end loop;
end;
$$;

revoke execute on function public.av_cashout(int) from public, anon;
grant execute on function public.av_cashout(int) to authenticated;
revoke execute on function public.av_settle() from public, anon, authenticated;

commit;
