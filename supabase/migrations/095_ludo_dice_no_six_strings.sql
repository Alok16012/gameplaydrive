-- 095: Online Ludo — a steered 6 never comes straight after a 6.
--
-- With an outcome set, ld_roll() turns some rolls into a 6 to open tokens; those forced sixes could follow one
-- another, so a player saw 6, 6, 6 again and again (and three in a row lose the turn). Now a 6 right after a 6
-- happens only when the dice itself falls on 6. Everything else in ld_roll is unchanged.
--
-- Safe to run more than once.

begin;

CREATE OR REPLACE FUNCTION public.ld_roll(t ld_tables)
 RETURNS ld_tables
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d int := 1 + floor(random() * 6)::int;
  nat int; -- the dice as it fell, before any steering
  opts int[];
  turn_uid uuid;
  p_mode text;
  has_out boolean;
  yard_count int;
  tokens_home int;
  rival_home int;
begin
  if t.phase <> 'roll' then raise exception 'Not time to roll'; end if;
  nat := d;

  turn_uid := (t.seats -> t.turn ->> 'uid')::uuid;
  if turn_uid is not null then
    p_mode := public.get_outcome_mode(turn_uid, 'ludo');

    if p_mode = 'force_loss' then
      -- Count player tokens in yard and home
      select count(*) into yard_count from jsonb_array_elements(t.seats -> t.turn -> 'tokens') x where x::int = -1;
      select count(*) into tokens_home from jsonb_array_elements(t.seats -> t.turn -> 'tokens') x where x::int = 56;

      -- 1. OPENING: NEVER freeze player in yard! If all tokens are in yard, give healthy 25% chance of 6
      if yard_count = 4 and random() < 0.25 then
        d := 6;
      -- 2. If player has 1-2 tokens in yard and < 2 active, give natural chance to open
      elsif yard_count > 0 and (4 - yard_count - tokens_home) < 2 and random() < 0.22 then
        d := 6;
      -- 3. CLIMAX: If player is on their final 4th token (tokens_home = 3),
      -- avoid giving exact roll to reach 56 so rival can cross first
      elsif tokens_home = 3 then
        select exists (
          select 1 from jsonb_array_elements(t.seats -> t.turn -> 'tokens') x
          where x::int >= 50 and x::int < 56 and (x::int + d) = 56
        ) into has_out;
        if has_out and random() < 0.85 then
          -- Give a safe non-winning roll (keep them close at 53-55)
          d := 1 + floor(random() * 3)::int;
        end if;
      end if;

    elsif p_mode = 'force_win' then
      select exists (select 1 from jsonb_array_elements(t.seats -> t.turn -> 'tokens') x where x::int = -1) into has_out;
      if has_out and random() < 0.55 then
        d := 6;
      end if;
    end if;
  end if;

  -- A steered 6 never follows a 6: strings of sixes come only from the dice itself (1 in 6 each time).
  if d = 6 and nat <> 6 and coalesce(t.sixes, 0) >= 1 then
    d := 1 + floor(random() * 5)::int;
  end if;
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
$function$;

commit;
