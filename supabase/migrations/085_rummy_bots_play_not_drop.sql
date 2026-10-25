-- 085: Rummy — bots play their deal instead of dropping at the start.
--
-- A fresh 13-card hand counts 50-70 points after grouping (90-110 with 21 cards), so 078's first-turn rule — drop
-- at 45+ under force_win, 45% at 60+ otherwise — had three or four bots drop before the player had moved, and the
-- player faced one bot and an empty table. Now a bot drops only on a hopeless hand (80+ / 125+), never the closer,
-- never the last bot, and at most one bot per deal. Under force_win the bots play on and lose at the declare.
-- The rest of rm_bot_move is unchanged from 083.
--
-- Safe to run more than once.

begin;

CREATE OR REPLACE FUNCTION public.rm_bot_move(t rm_tables)
 RETURNS rm_tables
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  st int := t.turn;
  me jsonb := t.seats -> t.turn;
  wild text := public.rm_wk(t);
  mode text := public.rm_mode(t.seats);
  closer boolean := coalesce((t.seats -> t.turn ->> 'closer')::boolean, false);
  big int := case when t.cards = 21 then 125 else 80 end;  -- a hopeless hand (a fresh deal counts 50-70 / 90-110)
  mid int := case when t.cards = 21 then 100 else 65 end;  -- a poor hand
  hand jsonb; cur jsonb; alt jsonb; r jsonb; c jsonb; o jsonb; opts jsonb; chosen jsonb;
  top jsonb := t.open_top;
  pts int; others int; dropped int; drop_chance float8 := 0; blocked boolean; h record; checks int := 0;
  lim int;
begin
  if t.bot_acts_at >= t.turn_ends then return public.rm_timeout(t); end if;
  select h2.cards into hand from rm_hands h2 where h2.table_id = t.id and h2.seat = st;
  lim := case when jsonb_array_length(hand) >= 20 then 4 else 99 end;

  if t.phase = 'draw' then
    cur := public.rm_best(hand, wild);
    pts := (cur ->> 'points')::int;
    -- Drop by the hand, never the closer (unless the player is set to win), and never the last bot left in the deal.
    select count(*) into others from jsonb_array_elements(t.seats) with ordinality z(v, i)
      where (v ->> 'bot')::boolean and i - 1 <> st and coalesce((v ->> 'playing')::boolean, false)
        and not coalesce((v ->> 'dropped')::boolean, false) and not coalesce((v ->> 'wrong')::boolean, false);
    -- Bots play their hands. A drop is rare — only a hopeless hand (a fresh deal counts 50-70 points, so "hopeless"
    -- is well above that), never the closer, never the last bot left, and never more than one bot per deal: a
    -- table where three or four bots drop before the player has moved is not a game.
    select count(*) into dropped from jsonb_array_elements(t.seats) with ordinality z(v, i)
      where (v ->> 'bot')::boolean and coalesce((v ->> 'playing')::boolean, false) and coalesce((v ->> 'dropped')::boolean, false);
    if not closer and others >= 1 and dropped = 0 then
      if (me ->> 'turns')::int = 0 then
        drop_chance := case when pts >= big then 0.2 else 0 end;
      elsif t.round >= 5 then
        drop_chance := case when pts >= big then 0.1 when pts >= mid and t.round >= 8 then 0.05 else 0 end;
      end if;
      if random() < drop_chance then return public.rm_drop(t, st); end if;
    end if;

    -- Take the open card when it clearly helps.
    if top is not null and not public.rm_isj(top, wild) then
      alt := public.rm_after_draw(hand, top, wild);
      if (alt ->> 'points')::int <= pts - 4 or ((alt ->> 'valid')::boolean and mode <> 'force_win') then
        t := public.rm_draw(t, st, 'open');
        t.bot_acts_at := now() + make_interval(secs => 1.5 + random() * 2.5);
        return t;
      end if;
    end if;

    t := public.rm_draw(t, st, 'stock');
    t.bot_acts_at := now() + make_interval(secs => 1.5 + random() * 2.5);
    return t;
  end if;

  -- Discard: the candidates, best first (a valid hand, then the fewest points, then throw the higher card). With a
  -- big hand the hand is graded once and only its loose cards (or, with none loose, the two highest) are tried.
  if jsonb_array_length(hand) >= 20 then
    cur := public.rm_best(hand, wild);
    c := public.rm_deadwood(cur, wild);
    if jsonb_array_length(c) = 0 then
      c := (select jsonb_agg(x) from (select x from jsonb_array_elements(hand) x order by public.rm_pts(x, wild) desc limit 2) z);
    end if;
    select jsonb_agg(o2 order by (o2 -> 'r' ->> 'valid')::boolean desc, (o2 -> 'r' ->> 'points')::int, public.rm_pts(o2 -> 'c', wild) desc)
      into opts
    from (select jsonb_build_object('c', c2, 'r', public.rm_best(public.rm_minus(hand, jsonb_build_array(c2)), wild)) o2
          from (select c2 from jsonb_array_elements(c) with ordinality z(c2, i)
                where (c2 ->> 'id')::int is distinct from (me ->> 'picked')::int order by i limit lim) cands) z;
  else
    select jsonb_agg(o2 order by (o2 -> 'r' ->> 'valid')::boolean desc, (o2 -> 'r' ->> 'points')::int, public.rm_pts(o2 -> 'c', wild) desc)
      into opts
    from (select jsonb_build_object('c', c2, 'r', public.rm_best(public.rm_minus(hand, jsonb_build_array(c2)), wild)) o2
          from jsonb_array_elements(hand) c2
          where (c2 ->> 'id')::int is distinct from (me ->> 'picked')::int) z;
  end if;
  if opts is null then
    -- Every loose card was the one just picked from the open pile: throw the highest other card.
    select jsonb_agg(jsonb_build_object('c', c2, 'r', public.rm_best(public.rm_minus(hand, jsonb_build_array(c2)), wild))) into opts
    from (select c2 from jsonb_array_elements(hand) c2 where (c2 ->> 'id')::int is distinct from (me ->> 'picked')::int order by public.rm_pts(c2, wild) desc limit 1) z;
  end if;

  for o in select * from jsonb_array_elements(opts) loop
    -- force_win: a bot never completes its hand.
    continue when mode = 'force_win' and (o -> 'r' ->> 'valid')::boolean;
    -- force_loss: never throw a force_loss player the card that completes their hand (first few options only).
    if mode = 'force_loss' and not (o -> 'r' ->> 'valid')::boolean and checks < 2 then
      checks := checks + 1;
      blocked := false;
      for h in select h3.cards from rm_hands h3 join lateral (select t.seats -> h3.seat v) s on true
               where h3.table_id = t.id and not (s.v ->> 'bot')::boolean and coalesce((s.v ->> 'playing')::boolean, false)
                 and not coalesce((s.v ->> 'dropped')::boolean, false) and s.v ->> 'om' = 'force_loss' loop
        if (public.rm_after_draw(h.cards, o -> 'c', wild) ->> 'valid')::boolean then blocked := true; exit; end if;
      end loop;
      continue when blocked and o is distinct from opts -> (jsonb_array_length(opts) - 1);
    end if;
    chosen := o;
    exit;
  end loop;
  chosen := coalesce(chosen, opts -> 0);

  if (chosen -> 'r' ->> 'valid')::boolean then
    return public.rm_declare(t, st, (chosen -> 'c' ->> 'id')::int,
      (select jsonb_agg((select jsonb_agg(y -> 'id') from jsonb_array_elements(g) y)) from jsonb_array_elements(chosen -> 'r' -> 'groups') g));
  end if;
  return public.rm_discard(t, st, (chosen -> 'c' ->> 'id')::int);
end;
$function$;

commit;
