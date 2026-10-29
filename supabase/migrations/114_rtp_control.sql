-- 114: RTP per house game, set by the Super Admin in Game Config ("rtp", 70–99%). On "fair", Blackjack, Dragon Tiger,
-- Andar Bahar, Lucky 7, Roulette and Plinko deal a share of rounds against the player's bet — just enough to bring the
-- game's natural return down to the target — and Aviator draws its crash point from a curve with that return.
-- Stock Market's RTP is 100 − its platform fee (already in Game Config). Defaults keep today's 91% (Aviator 93%).
--
-- Before this Roulette, Lucky 7, Plinko and every Aviator bet fell through to the old "fair" mix (60% of rounds against
-- the bet, 30% for it): Roulette paid back 178% over the last 30 days (a straight-up bet won 30% of spins at 36x) and
-- Aviator pulled the shared round down for 60% of bets (86.6%, not the 93% of its curve).
--
-- Per-player / agent / game / global Win-Loss settings still come first, unchanged.

begin;

/** The Super Admin's RTP for a house game, in percent (Game Config → RTP), or the game's default. */
create or replace function public.house_rtp(p_game text)
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $$
  select least(99, greatest(70, coalesce(
    nullif(public.game_cfg(p_game) ->> 'rtp', '')::numeric,
    case p_game when 'aviator' then 93 else 91 end)));
$$;

/** "fair" or "force_loss" for one round of a house game whose natural return is p_natural % and whose losing
 *  (force_loss) round returns p_loss %: force_loss just often enough that the game returns house_rtp(p_game). */
create or replace function public.rtp_mode(p_game text, p_natural numeric, p_loss numeric)
returns text
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare t numeric := public.house_rtp(p_game);
begin
  if p_natural <= t or p_natural <= p_loss then return 'fair'; end if;
  if random() < least(1, (p_natural - t) / (p_natural - p_loss)) then return 'force_loss'; end if;
  return 'fair';
end;
$$;
revoke all on function public.rtp_mode(text, numeric, numeric) from public, anon, authenticated;

-- Aviator: the chance a round reaches multiplier M is RTP / M, so every cash-out target returns the RTP on average.
create or replace function public.av_crash_point() returns numeric
language plpgsql volatile set search_path = public, extensions as $$
declare u float8; t float8 := public.house_rtp('aviator');
begin
  u := ('x' || encode(extensions.gen_random_bytes(6), 'hex'))::bit(48)::bigint / 281474976710656.0; -- 48 random bits
  return least(500, greatest(1.00, floor(t / (1 - u)) / 100.0));
end;
$$;
revoke execute on function public.av_crash_point() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_outcome_mode(p_user_id uuid, p_game text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- Table games against the house bots (Teen Patti, Poker, Rummy): "fair" is a coin toss — half the hands the player
  -- is dealt the winning hand, half the hands a bot is — and "force win" favours the player as strongly as "force
  -- loss" favours the house. The admin's rate overrides below still apply when set.
  if gid in ('teen-patti', 'poker', 'rummy', 'rummy21', 'rummy-21') then
    fair_loss := 0.50;
    fair_win := 0.50;
    strict_win := 0.85;
  end if;
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

  -- House games on "fair" play to the RTP the Super Admin sets in Game Config (house_rtp): most rounds are dealt
  -- straight from the cards / wheel, and a share (rtp_mode) is dealt against the player's bet — just enough to bring
  -- the game's natural return down to the target. Natural returns on the main bets: Blackjack 99.47% (basic
  -- strategy; a force_loss hand returns ~8%), Dragon / Tiger 97.06% (a tie gives back half; ~4%), Andar / Bahar 100%,
  -- Lucky 7 92.31%, Roulette 97.5% (zero once in forty spins). Plinko works out its own board in plinko_drop; Aviator
  -- takes the RTP in its crash curve (av_crash_point); Stock Market is a fair random walk and its RTP is
  -- 100 − the platform fee. Admin settings that force a player, an agent's players, the game or everything still
  -- win above.
  if base_mode = 'fair' then
    case gid
      when 'blackjack' then return public.rtp_mode(gid, 99.47, 8);
      when 'dragon-tiger' then return public.rtp_mode(gid, 97.06, 4);
      when 'andar-bahar' then return public.rtp_mode(gid, 100, 0);
      when 'lucky-7' then return public.rtp_mode(gid, 92.31, 0);
      when 'roulette' then return public.rtp_mode(gid, 97.5, 0);
      when 'plinko', 'aviator', 'stock-market' then return 'fair';
      else null;
    end case;
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
$function$;

CREATE OR REPLACE FUNCTION public.plinko_drop(p_amount bigint, p_rows integer, p_risk text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  nat numeric := 0; lw numeric := 0; lret numeric := 0;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if mults is null then raise exception 'Invalid board'; end if;
  max_bet := public.plinko_max_bet(p_rows, p_risk);
  if p_amount < 10 or p_amount > max_bet then raise exception 'Bet between 10 and % coins on this board', max_bet; end if;

  mode := public.get_outcome_mode(me.id, 'plinko');
  -- On "fair" the board plays to the Super Admin's RTP: its natural return and what a losing drop pays back.
  if mode = 'fair' then
    for k in 0 .. p_rows loop
      if k > 0 then c := c * (p_rows - k + 1) / k; end if;
      nat := nat + c * mults[k + 1];
      if mults[k + 1] < 1 then lw := lw + c; lret := lret + c * mults[k + 1]; end if;
    end loop;
    mode := public.rtp_mode('plinko', 100 * nat / (2::numeric ^ p_rows), case when lw > 0 then 100 * lret / lw else 0 end);
    c := 1;
  end if;
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
$function$;

CREATE OR REPLACE FUNCTION public.set_game_settings(p_game text, p_cfg jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare old jsonb := public.game_cfg(p_game); new jsonb := public.game_cfg(p_game); k text; v jsonb; n numeric;
        games text[] := array['teen-patti','rummy','andar-bahar','dragon-tiger','lucky-7','aviator','roulette','plinko','blackjack','poker','ludo','carrom','chess','stock-market','cricket'];
begin
  if not public.is_superadmin() then raise exception 'Only the Super Admin can change game settings'; end if;
  if not (p_game = any (games)) then raise exception 'Unknown game'; end if;
  for k, v in select * from jsonb_each(coalesce(p_cfg, '{}')) loop
    if k = 'enabled' then
      if jsonb_typeof(v) <> 'boolean' then raise exception 'enabled must be true or false'; end if;
      new := new || jsonb_build_object(k, v);
    elsif k in ('min_bet', 'max_bet') then
      if v = 'null'::jsonb or v = '""'::jsonb then new := new - k; continue; end if;
      n := (v #>> '{}')::numeric;
      if n < 1 or n > 1000000 or n <> floor(n) then raise exception 'Bets must be whole coins from 1 to 1,000,000'; end if;
      new := new || jsonb_build_object(k, n::bigint);
    elsif k = 'rake' then
      n := (v #>> '{}')::numeric;
      if n < 0 or n > 25 then raise exception 'Platform fee must be between 0 and 25%%'; end if;
      new := new || jsonb_build_object(k, n);
    elsif k = 'turn' then
      if p_game not in ('teen-patti', 'rummy', 'poker') then continue; end if;
      n := (v #>> '{}')::numeric;
      if n < 10 or n > 90 then raise exception 'Turn time must be between 10 and 90 seconds'; end if;
      new := new || jsonb_build_object(k, n::int);
    elsif k = 'blind_limit' then
      if p_game <> 'teen-patti' then continue; end if;
      n := (v #>> '{}')::numeric;
      if n < 1 or n > 10 then raise exception 'Blind limit must be between 1 and 10'; end if;
      new := new || jsonb_build_object(k, n::int);
    elsif k = 'bot_speed' then
      if p_game not in ('ludo', 'carrom', 'chess', 'poker') then continue; end if;
      if v #>> '{}' not in ('slow', 'normal', 'fast') then raise exception 'Bot speed must be slow, normal or fast'; end if;
      new := new || jsonb_build_object(k, v #>> '{}');
    elsif k = 'rtp' then
      if p_game not in ('dragon-tiger', 'andar-bahar', 'lucky-7', 'aviator', 'roulette', 'plinko', 'blackjack') then continue; end if;
      if v = 'null'::jsonb or v = '""'::jsonb then new := new - k; continue; end if;
      n := (v #>> '{}')::numeric;
      if n < 70 or n > 99 then raise exception 'RTP must be between 70%% and 99%%'; end if;
      new := new || jsonb_build_object(k, round(n, 1));
    elsif k = 'outcome_mode' then
      if v #>> '{}' not in ('fair', 'force_win', 'force_loss') then raise exception 'outcome_mode must be fair, force_win or force_loss'; end if;
      new := new || jsonb_build_object(k, v #>> '{}');
    else
      raise exception 'Unknown setting %', k;
    end if;
  end loop;
  if (new ->> 'min_bet') is not null and (new ->> 'max_bet') is not null and (new ->> 'min_bet')::bigint > (new ->> 'max_bet')::bigint then
    raise exception 'Minimum bet can''t be above the maximum';
  end if;
  insert into app_settings (key, value) values ('games', '{}') on conflict (key) do nothing;
  update app_settings set value = jsonb_set(coalesce(value, '{}'), array[p_game], new) where key = 'games';
  perform public.write_audit('Game settings • ' || p_game, old::text, new::text);
  return new;
end;
$function$;

commit;
notify pgrst, 'reload schema';
