-- 078: Rummy — when the player is set to win a deal, the bots cut their losses.
--
-- Under force_win (and the half of "fair" deals that go the player's way) every bot pays its hand into the
-- player's win. A bot dealt a bad hand (45+ points, sometimes 35+) now drops on its first turn for a flat 20
-- instead of playing on — the closer included. Decent hands play on and shrink their points, which is cheaper than
-- a drop. One bot always stays, so the player still has to make and declare a valid hand. Deals the house wins are
-- unchanged: the closer plays to its declare and the player pays their full hand.
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
  big int := case when t.cards = 21 then 95 else 60 end;   -- a bad hand
  mid int := case when t.cards = 21 then 75 else 45 end;   -- a poor hand
  hand jsonb; cur jsonb; alt jsonb; r jsonb; c jsonb; o jsonb; opts jsonb; chosen jsonb;
  top jsonb := t.open_top;
  pts int; others int; drop_chance float8 := 0; blocked boolean; h record;
begin
  if t.bot_acts_at >= t.turn_ends then return public.rm_timeout(t); end if;
  select h2.cards into hand from rm_hands h2 where h2.table_id = t.id and h2.seat = st;

  if t.phase = 'draw' then
    cur := public.rm_best(hand, wild);
    pts := (cur ->> 'points')::int;
    -- Drop by the hand, never the closer, and never the last bot left in the deal.
    select count(*) into others from jsonb_array_elements(t.seats) with ordinality z(v, i)
      where (v ->> 'bot')::boolean and i - 1 <> st and coalesce((v ->> 'playing')::boolean, false)
        and not coalesce((v ->> 'dropped')::boolean, false) and not coalesce((v ->> 'wrong')::boolean, false);
    if (not closer or mode = 'force_win') and others >= 1 then
      if mode = 'force_win' then
        -- The player is set to win this deal, so every bot pays its hand at the end. A first-turn drop costs a flat
        -- 20 points, so it only pays when the hand is bad enough that playing on would cost more: a bot dealt 45+
        -- points drops at once, a 35+ hand usually does; a decent hand plays on and shrinks its points instead. A
        -- middle drop (40) is never worth it. One bot always stays, so the player still has to declare to collect.
        drop_chance := case when (me ->> 'turns')::int > 0 then 0 when pts >= 45 then 1 when pts >= 35 then 0.6 else 0 end;
      elsif (me ->> 'turns')::int = 0 then
        drop_chance := case when pts >= big then 0.45 when pts >= mid then 0.12 else 0 end;
      elsif t.round >= 4 then
        drop_chance := case when pts >= big then 0.15 when pts >= mid and t.round >= 7 then 0.08 else 0 end;
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

  -- Discard: every option, best first (a valid hand, then the fewest points, then throw the higher card).
  select jsonb_agg(o2 order by (o2 -> 'r' ->> 'valid')::boolean desc, (o2 -> 'r' ->> 'points')::int, public.rm_pts(o2 -> 'c', wild) desc)
    into opts
  from (select jsonb_build_object('c', c2, 'r', public.rm_best(public.rm_minus(hand, jsonb_build_array(c2)), wild)) o2
        from jsonb_array_elements(hand) c2
        where (c2 ->> 'id')::int is distinct from (me ->> 'picked')::int) z;

  for o in select * from jsonb_array_elements(opts) loop
    -- force_win: a bot never completes its hand.
    continue when mode = 'force_win' and (o -> 'r' ->> 'valid')::boolean;
    -- force_loss: never throw a force_loss player the card that completes their hand (first few options only).
    if mode = 'force_loss' and not (o -> 'r' ->> 'valid')::boolean then
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
