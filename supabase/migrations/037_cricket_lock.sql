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
