-- 077: Outcome odds for the table games (Teen Patti, Poker, Rummy).
--
-- get_outcome_mode() decides, per hand, whether a player is dealt to lose, to win, or at random. Its defaults were
-- written for the casino games: "fair" = 60% force_loss / 30% force_win / 10% random, and "force win" only 50% win.
-- For the bot table games the owner wants: fair = an even 50/50, force loss = the house wins (85%), force win = the
-- player wins (85%). A player or game targeted directly by the admin still gets 100% as before.
-- Casino, Ludo, cricket etc. keep their previous odds. The admin's outcome_control.rates overrides still apply.
--
-- Safe to run more than once.

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

commit;
