-- 106: Stock Market — cash-outs and closes pay the real price; a 91% return comes from a 9% fee.
--
-- On "fair" the market dealt 60% of positions a zero payout (cash-out or close, whatever the price), so players saw
-- "Cashed out … 0" and got back ~23% of their stakes. Now "fair" never forces: each position is paid what it is worth
-- at that moment (UP stake × P, DOWN stake × (2 − P)), less the platform fee, set to 9% (Admin → Game Config, the
-- "Platform fee %" of Stock Market). The price path is a fair random walk, so the return is 100% − fee = 91% however
-- players time their cash-outs. Admin force_win / force_loss (player, agent, game, global) work as before.

update app_settings set value = jsonb_set(coalesce(value, '{}'), '{stock-market}', coalesce(value -> 'stock-market', '{}') || '{"rake": 9}')
where key = 'games';

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

  -- Blackjack on "fair" plays to a fixed 91% return: 9.3% of hands are dealt against the player (force_loss, which
  -- returns ~8% of the stake), the rest come straight from the shuffled shoe (99.47% with basic strategy under
  -- these rules), never force_win. Admin settings that force a player, an agent's players, the game or everything still win above.
  if gid = 'blackjack' and base_mode = 'fair' then
    if random() < 0.093 then return 'force_loss'; end if;
    return 'fair';
  end if;

  -- Dragon Tiger and Andar Bahar on "fair" play to a 91% return straight from the shuffled cards: most rounds are
  -- dealt as they come, and only a small share (6.5% / 9%) are dealt against the player's bet, so the result no
  -- longer follows the bet (before, 60% of rounds were dealt against it and 30% for it — players saw "whatever I back,
  -- the other side comes"). Natural returns: Dragon / Tiger 97.1% (a tie gives back half), Andar / Bahar 100%.
  -- Admin settings that force a player, an agent's players, the game or everything still win above.
  -- Stock Market on "fair": every position is paid at the price it is cashed out or closed at. The market is a fair
  -- random walk (worth 100% on average), so the house's 9% comes from the platform fee on payouts (Game Config).
  if gid = 'stock-market' and base_mode = 'fair' then return 'fair'; end if;

  if gid in ('dragon-tiger', 'andar-bahar') and base_mode = 'fair' then
    if random() < (case when gid = 'dragon-tiger' then 0.065 else 0.09 end) then return 'force_loss'; end if;
    return 'fair';
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
