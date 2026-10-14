-- Khelobaazi: migrations 035, 036, 037 and 038 in one go.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to run more than once.


-- ================================================================ 035_ludo_real_rules.sql
-- 035: Ludo with friends — play by the real rules, and a game left behind is over when you come back.
--   • Three 6s *in a row* lose the turn: any other number breaks the run (before, a 6, 6, then a capture bonus
--     roll and another 6 counted as three).
--   • When the table plays a turn for someone (their 20 s ran out), it picks a token the way a player would:
--     a capture, then getting a token home, then bringing a new token out on a 6, getting out of reach / onto a
--     safe square, and only then the token that is furthest along. Before, it always pushed the furthest token,
--     so on a 6 the one token already out kept moving and the others never left the yard.
--   • A game nobody was at: if everyone closed the app, the turns that ran out since are played one after another
--     on their own 20 s clocks when anyone comes back. Three missed turns put a player out (029), so a game left for
--     hours is finished by then (the last player in wins the pot) instead of carrying on where it stopped.
-- Safe to run more than once. Run after 029_ludo_three_misses.sql.

-- Is square a (absolute track index) one an opponent of seat s could land on with their next roll?
create or replace function public.ld_threat(t public.ld_tables, s int, a int) returns boolean language sql immutable as $$
  select a >= 0 and not public.ld_safe(a) and exists (
    select 1
    from generate_series(0, jsonb_array_length(t.seats) - 1) q, generate_series(0, 3) j,
      lateral (select (t.seats -> q ->> 'colour')::int c, (t.seats -> q -> 'tokens' ->> j)::int p) x,
      lateral (select (a - public.ld_abs(x.c, x.p) + 52) % 52 gap) g
    where q <> s and not coalesce((t.seats -> q ->> 'left')::boolean, false)
      and x.p between 0 and 50 and g.gap between 1 and 6 and x.p + g.gap <= 50);
$$;

-- Is there an opponent of seat s on square a that landing there would capture?
create or replace function public.ld_hit(t public.ld_tables, s int, a int) returns boolean language sql immutable as $$
  select a >= 0 and not public.ld_safe(a) and exists (
    select 1
    from generate_series(0, jsonb_array_length(t.seats) - 1) q, generate_series(0, 3) j
    where q <> s and not coalesce((t.seats -> q ->> 'left')::boolean, false)
      and public.ld_abs((t.seats -> q ->> 'colour')::int, (t.seats -> q -> 'tokens' ->> j)::int) = a);
$$;

-- The move a sensible player makes for the player to move (see the notes at the top).
create or replace function public.ld_best(t public.ld_tables) returns int language plpgsql volatile as $$
declare s int := t.turn; c int := (t.seats -> t.turn ->> 'colour')::int; d int := t.dice;
        i int; p int; to_p int; a int; sc numeric; best int; best_sc numeric := -1e9; out_n int;
begin
  select count(*) into out_n from jsonb_array_elements_text(t.seats -> s -> 'tokens') x where x::int between 0 and 55;
  foreach i in array public.ld_movable(t, s, d) loop
    p := (t.seats -> s -> 'tokens' ->> i)::int;
    to_p := case when p = -1 then 0 else p + d end;
    a := public.ld_abs(c, to_p);
    sc := to_p / 10.0 + random() * 8;
    if public.ld_hit(t, s, a) then sc := sc + 100; end if;
    if to_p = 56 then sc := sc + 80; end if;
    if p = -1 then sc := sc + 60 - 10 * out_n; end if;
    if to_p between 51 and 55 then sc := sc + 30; end if;
    if a >= 0 and public.ld_safe(a) then sc := sc + 15; end if;
    if p between 0 and 50 and public.ld_threat(t, s, public.ld_abs(c, p)) and not public.ld_threat(t, s, a) then sc := sc + 40; end if;
    if public.ld_threat(t, s, a) then sc := sc - 45; end if;
    if sc > best_sc then best_sc := sc; best := i; end if;
  end loop;
  return best;
end;
$$;

-- Roll for the player to move. No move possible or a third 6 in a row: the turn passes. A single possible move is made.
create or replace function public.ld_roll(t public.ld_tables) returns public.ld_tables language plpgsql volatile security definer set search_path = public as $$
declare d int := 1 + floor(random() * 6)::int; opts int[];
begin
  if t.phase <> 'roll' then raise exception 'Not time to roll'; end if;
  t.dice := d;
  if d = 6 then t.sixes := t.sixes + 1; else t.sixes := 0; end if;
  if t.sixes >= 3 then
    t.last := jsonb_build_object('kind', 'skip', 'seat', t.turn, 'dice', d, 'why', 'three sixes');
    return public.ld_next(t);
  end if;
  opts := public.ld_movable(t, t.turn, d);
  if cardinality(opts) = 0 then
    t.last := jsonb_build_object('kind', 'nomove', 'seat', t.turn, 'dice', d);
    return public.ld_next(t);
  end if;
  t.phase := 'move';
  t.last := jsonb_build_object('kind', 'roll', 'seat', t.turn, 'dice', d);
  t.turn_ends := greatest(t.turn_ends, now() + interval '10 seconds');
  if cardinality(opts) = 1 then return public.ld_move(t, opts[1]); end if;
  return t;
end;
$$;

-- Anyone at the table: run the clock and get the table. Each turn that ran out is played for that player, on the
-- clock it would have had — so after a long time away every missed turn is played, not just one.
create or replace function public.ld_tick(p_table uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare t ld_tables; guard int := 0; due timestamptz;
begin
  select * into t from ld_tables where id = p_table for update;
  if t.id is null or not (auth.uid() = any (t.members)) then raise exception 'Not your table'; end if;
  while t.status = 'playing' and t.turn_ends <= now() and guard < 60 loop
    due := t.turn_ends;
    t := public.ld_auto(t);
    if t.status = 'playing' and t.turn_ends is not null then t.turn_ends := least(t.turn_ends, due + interval '20 seconds'); end if;
    guard := guard + 1;
  end loop;
  if guard > 0 then perform public.ld_save(t); select * into t from ld_tables where id = p_table; end if;
  return public.ld_view(t);
end;
$$;

revoke execute on function public.ld_threat(public.ld_tables, int, int), public.ld_hit(public.ld_tables, int, int),
  public.ld_best(public.ld_tables), public.ld_roll(public.ld_tables) from public, anon, authenticated;
revoke execute on function public.ld_tick(uuid) from public, anon;
grant execute on function public.ld_tick(uuid) to authenticated;


-- ================================================================ 036_player_username.sql
-- 036: players can have an optional username (set by whoever creates or edits them in the Admin console). Players
-- still sign in with their mobile number; the username is only a handle. Staff usernames are unchanged (required,
-- used to sign in). Before this, editing a player always cleared their username.
-- Safe to run more than once. Run after 007. Run it in the Supabase SQL Editor.

create or replace function public.update_profile(
  p_actor uuid, p_target uuid, p_name text, p_phone text, p_username text, p_state text, p_password_reset boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  actor profiles;
  t profiles;
  who text;
  changes jsonb := '[]';
  ch jsonb;
begin
  select * into actor from profiles where id = p_actor and status = 'active';
  if actor.id is null then raise exception 'Your account is not active'; end if;
  select * into t from profiles where id = p_target;
  if t.id is null then raise exception 'Account not found'; end if;
  if t.id = actor.id or not (actor.role = 'superadmin' or public.is_ancestor(actor.id, t.id)) then
    raise exception 'You can only edit accounts in your own network';
  end if;

  p_name := trim(coalesce(p_name, ''));
  if p_name = '' then raise exception 'Enter a name'; end if;
  p_phone := nullif(trim(coalesce(p_phone, '')), '');
  if p_phone is not null and p_phone !~ '^[0-9]{10}$' then raise exception 'Enter a 10-digit mobile number'; end if;
  if t.role = 'player' and p_phone is null then raise exception 'Players need a mobile number to sign in'; end if;
  if t.role = 'player' then
    p_username := nullif(lower(trim(coalesce(p_username, ''))), '');
    if p_username is not null and p_username !~ '^[a-z0-9._]{3,}$' then raise exception 'Username: at least 3 letters, numbers, dots or underscores'; end if;
    p_state := nullif(trim(coalesce(p_state, '')), '');
  else
    p_username := lower(trim(coalesce(p_username, '')));
    if p_username !~ '^[a-z0-9._]{3,}$' then raise exception 'Username: at least 3 letters, numbers, dots or underscores'; end if;
    p_state := t.state;
  end if;
  if p_phone is distinct from t.phone and exists (select 1 from profiles where phone = p_phone and id <> t.id) then
    raise exception 'That mobile number is already used by another account';
  end if;
  if p_username is distinct from t.username and exists (select 1 from profiles where username = p_username and id <> t.id) then
    raise exception 'That username is taken';
  end if;

  if p_name <> t.name then changes := changes || jsonb_build_array(jsonb_build_array('Name', t.name, p_name)); end if;
  if p_phone is distinct from t.phone then changes := changes || jsonb_build_array(jsonb_build_array('Mobile', coalesce(t.phone, '—'), coalesce(p_phone, '—'))); end if;
  if p_username is distinct from t.username then changes := changes || jsonb_build_array(jsonb_build_array('Username', coalesce(t.username, '—'), coalesce(p_username, '—'))); end if;
  if p_state is distinct from t.state then changes := changes || jsonb_build_array(jsonb_build_array('State', coalesce(t.state, '—'), coalesce(p_state, '—'))); end if;
  if p_password_reset then changes := changes || jsonb_build_array(jsonb_build_array('Password', '••••', 'reset')); end if;

  update profiles set name = p_name, phone = p_phone, username = p_username, state = p_state where id = t.id;

  who := initcap(t.role::text) || ' ' || t.code;
  for ch in select * from jsonb_array_elements(changes) loop
    insert into audit_log (actor_id, actor_name, action, before, after)
      values (actor.id, coalesce(actor.username, actor.name), who || ' • ' || (ch ->> 0), ch ->> 1, ch ->> 2);
  end loop;

  return jsonb_build_object('old', to_jsonb(t), 'new', (select to_jsonb(p) from profiles p where p.id = t.id), 'changed', jsonb_array_length(changes));
end;
$$;

revoke execute on function public.update_profile(uuid, uuid, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.update_profile(uuid, uuid, text, text, text, text, boolean) to service_role;


-- ================================================================ 037_cricket_lock.sql
-- 037: the Super Admin can lock / unlock Cricket from Admin → Game Config, like every other game. A locked Cricket
-- takes no new bets (bets already placed still settle as normal). Safe to run more than once. Run after 033.

create or replace function public.set_game_settings(p_game text, p_cfg jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
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
      if p_game not in ('teen-patti', 'rummy') then continue; end if;
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
$$;

create or replace function public.place_sport_bet(
  p_sport text, p_event_id text, p_event_name text, p_market_type text, p_market_name text,
  p_runner_name text, p_bet_type text, p_odds numeric, p_line numeric, p_stake bigint
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  rate numeric;
  v_exposure bigint;
  v_profit bigint;
  bal bigint;
  new_id bigint;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if not coalesce((public.game_cfg('cricket') ->> 'enabled')::boolean, true) then raise exception 'Cricket is closed for maintenance'; end if;
  if p_stake is null or p_stake < 100 or p_stake > 500000 then raise exception 'Invalid stake'; end if;
  if p_bet_type not in ('BACK', 'LAY') then raise exception 'Invalid bet type'; end if;
  if p_market_type not in ('MATCH_ODDS', 'BOOKMAKER', 'FANCY', 'TIE', 'TOSS') then raise exception 'Invalid market'; end if;
  if coalesce(trim(p_event_id), '') = '' or coalesce(trim(p_market_name), '') = '' or coalesce(trim(p_runner_name), '') = '' then
    raise exception 'Invalid bet';
  end if;
  if p_market_type = 'FANCY' and p_line is null then raise exception 'Invalid fancy line'; end if;

  -- Bookmaker rates are quoted per 100 (e.g. 85 = 0.85 profit per coin); exchange odds are decimal.
  rate := case when p_market_type = 'BOOKMAKER' then p_odds / 100 else p_odds - 1 end;
  if rate is null or rate <= 0 or rate > 1000 then raise exception 'Invalid odds'; end if;

  if p_bet_type = 'BACK' then
    v_exposure := p_stake;
    v_profit := round(p_stake * rate);
  else
    v_exposure := round(p_stake * rate);
    v_profit := p_stake;
  end if;

  bal := public.wallet_move(me.id, -v_exposure, 'bet',
    upper(coalesce(p_sport, 'cricket')) || ': ' || p_event_name || ' • ' || p_runner_name
    || ' [' || p_bet_type || ' @ ' || p_odds || ' | Stake: ' || p_stake || ']');
  if bal is null then raise exception 'Not enough coins'; end if;

  insert into sport_bets (user_id, sport, event_id, event_name, market_type, market_name, runner_name, bet_type,
                          odds, line, stake, exposure, profit)
  values (me.id, coalesce(p_sport, 'cricket'), p_event_id, p_event_name, p_market_type, p_market_name, p_runner_name,
          p_bet_type, p_odds, p_line, p_stake, v_exposure, v_profit)
  returning id into new_id;

  return jsonb_build_object('id', new_id, 'balance', bal, 'exposure', v_exposure, 'profit', v_profit);
end;
$$;


-- ================================================================ 038_roulette_split_corner.sql
-- 038: Roulette split and corner bets.
--   s_A_B          split: two numbers side by side on the table (B = A + 1 in the same column, or B = A + 3)  → 18x
--   q_A_B_C_D      corner: four numbers that meet at a corner (A, A+1, A+3, A+4, A not in the top row)         → 9x
-- Returns include the stake (like a straight number paying 36x). Any other side is still refused as an invalid bet.
-- Safe to run more than once. Run after 012. Run it in the Supabase SQL Editor.

create or replace function public.rl_pay(p_side text, n int) returns int
language plpgsql immutable set search_path = public as $$
declare
  red boolean := n = any (array[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
  a int; b int;
begin
  if p_side ~ '^n_([0-9]|[12][0-9]|3[0-6])$' then return case when substr(p_side, 3)::int = n then 36 else 0 end; end if;
  if p_side ~ '^s_[0-9]{1,2}_[0-9]{1,2}$' then
    a := split_part(p_side, '_', 2)::int; b := split_part(p_side, '_', 3)::int;
    if a < 1 or b > 36 or not (b = a + 3 or (b = a + 1 and a % 3 <> 0)) then return null; end if;
    return case when n = a or n = b then 18 else 0 end;
  end if;
  if p_side ~ '^q_[0-9]{1,2}_[0-9]{1,2}_[0-9]{1,2}_[0-9]{1,2}$' then
    a := split_part(p_side, '_', 2)::int;
    if a < 1 or a > 32 or a % 3 = 0 or p_side <> format('q_%s_%s_%s_%s', a, a + 1, a + 3, a + 4) then return null; end if;
    return case when n in (a, a + 1, a + 3, a + 4) then 9 else 0 end;
  end if;
  return case p_side
    when 'red' then case when red then 2 else 0 end
    when 'black' then case when n > 0 and not red then 2 else 0 end
    when 'even' then case when n > 0 and n % 2 = 0 then 2 else 0 end
    when 'odd' then case when n % 2 = 1 then 2 else 0 end
    when 'low' then case when n between 1 and 18 then 2 else 0 end
    when 'high' then case when n between 19 and 36 then 2 else 0 end
    when 'd1' then case when n between 1 and 12 then 3 else 0 end
    when 'd2' then case when n between 13 and 24 then 3 else 0 end
    when 'd3' then case when n between 25 and 36 then 3 else 0 end
    when 'c1' then case when n > 0 and n % 3 = 1 then 3 else 0 end
    when 'c2' then case when n > 0 and n % 3 = 2 then 3 else 0 end
    when 'c3' then case when n > 0 and n % 3 = 0 then 3 else 0 end
  end;
end;
$$;

revoke execute on function public.rl_pay(text, int) from public, anon, authenticated;
