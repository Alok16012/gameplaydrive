-- 025: Computer players take their time like people do (Rummy and the Supabase Teen Patti tables).
--   • Teen Patti: a few quick calls (1.5–3 s), mostly 3–7 s, sometimes a long think (7–12 s).
--   • Rummy: 2–9 s before picking a card (sometimes up to ~16 s), then 2–6 s before discarding.
--   • Teen Patti bots short of chips buy back in before betting, so the balance on show always covers the chaal.
-- (The Railway game server got the same Teen Patti changes in server/src.)
-- Safe to run more than once. Run it in the Supabase SQL Editor.

create or replace function public.tp_set_turn(t public.tp_tables, seat int) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare r float := random(); secs int := coalesce((public.game_cfg('teen-patti') ->> 'turn')::int, 15); delay float;
begin
  t.turn := seat;
  t.turn_ends := now() + make_interval(secs => secs);
  -- Blind limit: after this many blind chaals in a hand, the player must play Seen — their cards are opened now.
  if not coalesce((t.seats -> seat ->> 'seen')::boolean, false)
     and coalesce((t.seats -> seat ->> 'blinds_hand')::int, -1) = t.hand_no
     and coalesce((t.seats -> seat ->> 'blinds')::int, 0) >= coalesce((public.game_cfg('teen-patti') ->> 'blind_limit')::int, 4) then
    t.seats := public.tp_seat_set(t.seats, seat, '{"seen": true, "action": "Blind limit • Seen"}');
  end if;
  if (t.seats -> seat ->> 'bot')::boolean then
    delay := case when r < 0.2 then 1.5 + random() * 1.5 when r < 0.72 then 3 + random() * 4 when r < 0.98 then least(7 + random() * 5, secs - 1) else secs end;
    t.bot_acts_at := now() + make_interval(secs => delay);
  else
    t.bot_acts_at := null;
  end if;
  return t;
end;
$$;

create or replace function public.tp_pay(t public.tp_tables, seat int, amt bigint) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare x jsonb := t.seats -> seat; bal bigint;
begin
  if (x ->> 'bot')::boolean then
    -- A bot short of chips buys back in first, so its balance on show always covers what it bets.
    t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('bal',
      greatest((x ->> 'bal')::bigint, case when (x ->> 'bal')::bigint < amt * 4 then (t.boot * (60 + random() * random() * 400))::bigint / 10 * 10 + amt else 0 end) - amt));
  else
    bal := public.wallet_move((x ->> 'uid')::uuid, -amt, 'bet', 'Teen Patti • Hand #' || t.hand_no);
    if bal is null then raise exception 'Not enough coins'; end if;
    t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('bal', bal));
  end if;
  t.pot := t.pot + amt;
  return t;
end;
$$;

create or replace function public.rm_set_turn(t public.rm_tables, seat int) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare secs int := coalesce((public.game_cfg('rummy') ->> 'turn')::int, 30); r float := random();
begin
  t.turn := seat;
  t.phase := 'draw';
  t.turn_ends := now() + make_interval(secs => secs);
  t.seats := public.rm_seat_set(t.seats, seat, '{"picked": null}');
  if (t.seats -> seat ->> 'bot')::boolean then
    t.bot_acts_at := now() + make_interval(secs => case when r < 0.2 then 2 + random() * 2 when r < 0.75 then 4 + random() * 5 when r < 0.98 then least(9 + random() * 7, secs - 2) else secs end);
  else
    t.bot_acts_at := null;
  end if;
  return t;
end;
$$;

create or replace function public.rm_bot_move(t public.rm_tables) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  st int := t.turn;
  wild text := public.rm_wk(t);
  hand jsonb;
  cur jsonb; alt jsonb; best jsonb; c jsonb; bestc jsonb; r jsonb;
  top jsonb := t.open_top;
begin
  if t.bot_acts_at >= t.turn_ends then return public.rm_timeout(t); end if;
  select h.cards into hand from rm_hands h where h.table_id = t.id and h.seat = st;
  if t.phase = 'draw' then
    cur := public.rm_best(hand, wild);
    -- Weak opening hands sometimes drop; very poor hands later sometimes middle-drop.
    if (t.seats -> st ->> 'turns')::int = 0 and (cur ->> 'points')::int >= (case when t.cards = 21 then 105 else 70 end) and random() < 0.25 then return public.rm_drop(t, st); end if;
    if t.round >= 5 and (cur ->> 'points')::int >= (case when t.cards = 21 then 112 else 75 end) and random() < 0.08 then return public.rm_drop(t, st); end if;
    -- Take the open card only if it clearly improves the hand.
    if top is not null and not public.rm_isj(top, wild) then
      alt := null;
      for c in select * from jsonb_array_elements(hand) loop
        r := public.rm_best(public.rm_minus(hand || jsonb_build_array(top), jsonb_build_array(c)), wild);
        if alt is null or (r ->> 'points')::int < (alt ->> 'points')::int then alt := r; end if;
      end loop;
      if (alt ->> 'points')::int <= (cur ->> 'points')::int - 4 then
        t := public.rm_draw(t, st, 'open');
        t.bot_acts_at := now() + make_interval(secs => 2 + random() * 4);
        return t;
      end if;
    end if;
    t := public.rm_draw(t, st, 'stock');
    t.bot_acts_at := now() + make_interval(secs => 2 + random() * 4);
    return t;
  end if;
  -- Discard the card that leaves the best hand; declare if that hand is valid.
  for c in select * from jsonb_array_elements(hand) loop
    continue when (c ->> 'id')::int = (t.seats -> st ->> 'picked')::int;
    r := public.rm_best(public.rm_minus(hand, jsonb_build_array(c)), wild);
    if best is null or (r ->> 'valid')::boolean and not (best ->> 'valid')::boolean
       or ((r ->> 'valid')::boolean = (best ->> 'valid')::boolean and ((r ->> 'points')::int < (best ->> 'points')::int
           or ((r ->> 'points')::int = (best ->> 'points')::int and public.rm_pts(c, wild) > public.rm_pts(bestc, wild)))) then
      best := r; bestc := c;
    end if;
  end loop;
  if (best ->> 'valid')::boolean then
    return public.rm_declare(t, st, (bestc ->> 'id')::int,
      (select jsonb_agg((select jsonb_agg(y -> 'id') from jsonb_array_elements(g) y)) from jsonb_array_elements(best -> 'groups') g));
  end if;
  return public.rm_discard(t, st, (bestc ->> 'id')::int);
end;
$$;
