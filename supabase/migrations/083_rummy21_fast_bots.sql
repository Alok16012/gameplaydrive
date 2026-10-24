-- 083: 21 Card Rummy — bot and draw logic within the 8-second statement limit.
--
-- 075's helpers (rm_after_draw, rm_pick_card, rm_safe_card, rm_pull_from_bots) and the bot's discard loop evaluate
-- the whole hand once per candidate card. With 13 cards that is 70-250 ms a move; with 21 cards rm_best is ~25 ms a
-- call and the helpers nest, so a bot move took up to 14 s and a player's draw up to 46 s. Supabase cancels any
-- player request after 8 s, so the poll that was supposed to play the bot's turn died every time and the table
-- hung on "Ayaan62 • 0". With 21 cards a hand is now graded once with the new card in it; the cards left over
-- (deadwood) are the only discards worth trying, and the exact check runs just for those. 13-card play is
-- unchanged. Measured locally (21 cards): bot move and player draw well under a second.
--
-- Safe to run more than once.

begin;

-- The cards of a graded hand (rm_best output) that are not in a valid meld: deadwood, highest points first.
create or replace function public.rm_deadwood(graded jsonb, wild text) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_agg(c order by public.rm_pts(c, wild) desc), '[]')
  from jsonb_array_elements(graded -> 'groups') g, jsonb_array_elements(g) c
  where public.rm_classify(g, wild) not in ('pure', 'impure', 'set', 'tunnela');
$$;

-- The best a hand can do after taking `card` and throwing its best discard: {valid, points}. 13 cards: every
-- discard is tried. 21 cards: the hand is graded once with the card in it; if at most two cards are left over,
-- discarding one of them is the only way to a valid hand, so just those are tried exactly; otherwise the hand can't
-- be completed by one discard and its points are estimated from the grading.
create or replace function public.rm_after_draw(hand jsonb, card jsonb, wild text) returns jsonb
language plpgsql immutable as $$
declare h jsonb := hand || jsonb_build_array(card); c jsonb; r jsonb; best jsonb; graded jsonb; dead jsonb; cands jsonb;
begin
  if jsonb_array_length(hand) < 20 then
    for c in select * from jsonb_array_elements(h) loop
      r := public.rm_best(public.rm_minus(h, jsonb_build_array(c)), wild);
      if best is null or ((r ->> 'valid')::boolean and not (best ->> 'valid')::boolean)
         or ((r ->> 'valid')::boolean = (best ->> 'valid')::boolean and (r ->> 'points')::int < (best ->> 'points')::int) then
        best := r;
      end if;
    end loop;
    return jsonb_build_object('valid', coalesce((best ->> 'valid')::boolean, false), 'points', coalesce((best ->> 'points')::int, 999));
  end if;

  graded := public.rm_best(h, wild);
  dead := public.rm_deadwood(graded, wild);
  if jsonb_array_length(dead) > 2 then
    -- Can't be completed with one discard: throw the highest loose card, the rest stays as points.
    return jsonb_build_object('valid', false, 'points', greatest(0, (graded ->> 'points')::int - public.rm_pts(dead -> 0, wild)));
  end if;
  -- Try the loose cards (or, with none loose, the drawn card and the highest card) as the discard, exactly.
  cands := case when jsonb_array_length(dead) > 0 then dead
                else jsonb_build_array(card) || (select coalesce(jsonb_agg(x), '[]') from (select x from jsonb_array_elements(h) x where x <> card order by public.rm_pts(x, wild) desc limit 1) z) end;
  for c in select * from jsonb_array_elements(cands) loop
    r := public.rm_best(public.rm_minus(h, jsonb_build_array(c)), wild);
    if best is null or ((r ->> 'valid')::boolean and not (best ->> 'valid')::boolean)
       or ((r ->> 'valid')::boolean = (best ->> 'valid')::boolean and (r ->> 'points')::int < (best ->> 'points')::int) then
      best := r;
    end if;
  end loop;
  return jsonb_build_object('valid', coalesce((best ->> 'valid')::boolean, false), 'points', coalesce((best ->> 'points')::int, 999));
end;
$$;

create or replace function public.rm_pick_card(hand jsonb, stock jsonb, wild text, n int, allow_valid boolean) returns int
language plpgsql immutable as $$
declare cur int := (public.rm_best(hand, wild) ->> 'points')::int; i int; r jsonb; best_i int; best jsonb;
  lim int := least(n, case when jsonb_array_length(hand) >= 20 then 6 else n end);
begin
  for i in 0 .. least(lim, jsonb_array_length(stock)) - 1 loop
    r := public.rm_after_draw(hand, stock -> i, wild);
    continue when (r ->> 'valid')::boolean and not allow_valid;
    if best is null or ((r ->> 'valid')::boolean and not (best ->> 'valid')::boolean)
       or ((r ->> 'valid')::boolean = (best ->> 'valid')::boolean and (r ->> 'points')::int < (best ->> 'points')::int) then
      best := r; best_i := i;
    end if;
  end loop;
  if best is null or (not (best ->> 'valid')::boolean and (best ->> 'points')::int >= cur) then return null; end if;
  return best_i;
end;
$$;

create or replace function public.rm_safe_card(hand jsonb, stock jsonb, wild text) returns int
language plpgsql immutable as $$
declare i int; lim int := case when jsonb_array_length(hand) >= 20 then 5 else 8 end;
begin
  for i in 0 .. least(lim, jsonb_array_length(stock)) - 1 loop
    if not (public.rm_after_draw(hand, stock -> i, wild) ->> 'valid')::boolean then return i; end if;
  end loop;
  return 0;
end;
$$;

create or replace function public.rm_pull_from_bots(t public.rm_tables, seat int, v_stock jsonb, wild text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_hand jsonb; cur int; h record; c jsonb; r jsonb; best jsonb; best_c jsonb; best_seat int; tried int := 0;
  ranks text[] := array['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  lim int;
begin
  if jsonb_array_length(v_stock) = 0 then return v_stock; end if;
  select h2.cards into v_hand from rm_hands h2 where h2.table_id = t.id and h2.seat = rm_pull_from_bots.seat;
  cur := (public.rm_best(v_hand, wild) ->> 'points')::int;
  lim := case when jsonb_array_length(v_hand) >= 20 then 12 else 40 end;
  for h in select h3.seat, h3.cards from rm_hands h3
           where h3.table_id = t.id and h3.seat <> rm_pull_from_bots.seat and coalesce((t.seats -> h3.seat ->> 'bot')::boolean, false)
             and coalesce((t.seats -> h3.seat ->> 'playing')::boolean, false) loop
    for c in select c2 from jsonb_array_elements(h.cards) c2
             where public.rm_isj(c2, wild) or exists (
               select 1 from jsonb_array_elements(v_hand) x
               where x ->> 'r' = c2 ->> 'r'
                  or (x ->> 's' = c2 ->> 's' and abs(array_position(ranks, x ->> 'r') - array_position(ranks, c2 ->> 'r')) in (1, 2, 11, 12))) loop
      exit when tried >= lim;
      tried := tried + 1;
      r := public.rm_after_draw(v_hand, c, wild);
      if best is null or ((r ->> 'valid')::boolean and not (best ->> 'valid')::boolean)
         or ((r ->> 'valid')::boolean = (best ->> 'valid')::boolean and (r ->> 'points')::int < (best ->> 'points')::int) then
        best := r; best_c := c; best_seat := h.seat;
      end if;
    end loop;
    exit when tried >= lim;
  end loop;
  if best is null or (not (best ->> 'valid')::boolean and (best ->> 'points')::int >= cur) then return v_stock; end if;
  update rm_hands set cards = public.rm_minus(cards, jsonb_build_array(best_c)) || jsonb_build_array(v_stock -> 0)
    where table_id = t.id and rm_hands.seat = best_seat;
  return jsonb_set(v_stock, '{0}', best_c);
end;
$$;

create or replace function public.rm_bot_move(t public.rm_tables) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
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
  pts int; others int; drop_chance float8 := 0; blocked boolean; h record; checks int := 0;
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
$$;

revoke execute on function public.rm_deadwood(jsonb, text), public.rm_after_draw(jsonb, jsonb, text), public.rm_pick_card(jsonb, jsonb, text, int, boolean),
  public.rm_safe_card(jsonb, jsonb, text), public.rm_pull_from_bots(public.rm_tables, int, jsonb, text), public.rm_bot_move(public.rm_tables)
  from public, anon, authenticated;

commit;
