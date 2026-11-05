-- 119: RTP for every game. The Super Admin's RTP (Game Config / Admin → RTP) now also drives the games played against
-- the house bots or the computer — Teen Patti, Poker, Rummy 13 / 21, Ludo, Chess: on "fair", the share of hands dealt
-- the player's way is RTP ÷ (2 × (1 − fee)) (a won hand returns roughly the other side's stake less the fee), the rest
-- go the bots' way. Before, that share was fixed: 50% for the card games, 30% (+10% natural) for Ludo and Chess.
-- set_game_settings accepts "rtp" for these games too. Default stays 91%.

begin;

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

  -- Games played against the house bots (Teen Patti, Poker, Rummy) or the computer (Ludo, Chess) on "fair": the
  -- share of hands dealt the player's way follows the RTP the Super Admin set (Game Config / RTP, migration 119).
  -- A won hand returns about 2 × (1 − fee) per coin staked (the other side's stake less the platform fee), so the
  -- win share is RTP ÷ (2 × (1 − fee)): 91% at a 5% fee → 47.9% of hands; 91% at 10% → 50.6%. The rest are dealt
  -- the bots' way. Rate overrides in outcome_control still win when set.
  if base_mode = 'fair' and gid in ('teen-patti', 'poker', 'rummy', 'rummy21', 'rummy-21', 'ludo', 'chess')
     and not (ctrl is not null and (ctrl -> 'rates' -> 'fair') is not null) then
    declare
      fee float8 := least(25, greatest(0, coalesce((public.game_cfg(case when gid in ('rummy21', 'rummy-21') then 'rummy' else gid end) ->> 'rake')::float8,
                                                  case when gid in ('teen-patti', 'poker') then 5 else 10 end)));
      pw float8 := public.house_rtp(case when gid in ('rummy21', 'rummy-21') then 'rummy' else gid end) / 100.0 / (2 * (1 - fee / 100.0));
    begin
      pw := least(0.95, greatest(0.05, pw));
      fair_win := pw;
      fair_loss := 1 - pw;
    end;
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
      if p_game not in ('dragon-tiger', 'andar-bahar', 'lucky-7', 'aviator', 'roulette', 'plinko', 'blackjack', 'teen-patti', 'rummy', 'poker', 'ludo', 'chess') then continue; end if;
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
