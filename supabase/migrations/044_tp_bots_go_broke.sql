-- Teen Patti bots stop buying back in. A bot sits down with a big stack sized to the boot, bets only from it,
-- packs when it can't cover a chaal or side show, and leaves at the next hand once it's below 4 boots.

CREATE OR REPLACE FUNCTION public.tp_start_hand(t tp_tables)
 RETURNS tp_tables
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  s jsonb := '[]';
  x jsonb;
  q jsonb;
  bal bigint;
  names text[];
  d jsonb := public.new_deck();
  i int;
  k int := 0;
  playing int := 0;
  eligible int;
  first_seat int;
  private boolean := t.code is not null;
begin
  for x in select * from jsonb_array_elements(t.seats) loop
    if (x ->> 'bot')::boolean then
      if not private and (x ->> 'bal')::bigint >= t.boot * 4 and random() > 0.12 then s := s || jsonb_build_array(x); end if;
    elsif not coalesce((x ->> 'left')::boolean, false) and (x ->> 'ping')::timestamptz > now() - interval '60 seconds' then
      s := s || jsonb_build_array(x);
    end if;
  end loop;
  for q in select * from jsonb_array_elements(t.queue) loop
    if jsonb_array_length(s) >= 6 then
      select coalesce(max(i2) - 1, -1) into i from jsonb_array_elements(s) with ordinality y(v, i2) where (v ->> 'bot')::boolean;
      exit when i < 0;
      s := s - i;
    end if;
    s := s || jsonb_build_array(q || jsonb_build_object('bot', false, 'ping', now()));
  end loop;
  t.queue := '[]';
  if not private then
    while jsonb_array_length(s) < 6 loop
      select coalesce(array_agg(v ->> 'name'), '{}') into names from jsonb_array_elements(s) v;
      -- A new bot sits down with a stack sized to the boot; it never tops up, so it can go broke and leave.
      x := public.make_bot(names);
      s := s || jsonb_build_array(x || jsonb_build_object('bal', greatest((x ->> 'bal')::bigint, (t.boot * (40 + random() * random() * 400))::bigint / 10 * 10)));
    end loop;
  end if;

  select count(*) into eligible from jsonb_array_elements(s) v
    where not (v ->> 'bot')::boolean and (select coins from wallets where user_id = (v ->> 'uid')::uuid) >= t.boot;
  delete from tp_hands where table_id = t.id;
  if eligible = 0 or (private and eligible < 2) then
    -- Nobody (or, at a private table, not enough friends) can play: wait without collecting anything.
    t.seats := (select coalesce(jsonb_agg(v || jsonb_build_object('playing', false, 'packed', false, 'seen', false,
                  'action', case when not (v ->> 'bot')::boolean and (select coins from wallets where user_id = (v ->> 'uid')::uuid) < t.boot then 'Not enough coins' end) order by n), '[]')
                from jsonb_array_elements(s) with ordinality z(v, n));
    t.members := public.tp_members(t.seats, t.queue);
    t.status := 'waiting';
    t.next_hand_at := null;
    t.turn := null;
    t.pending := null;
    return t;
  end if;

  for i in 0 .. jsonb_array_length(s) - 1 loop
    x := s -> i;
    if (x ->> 'bot')::boolean then
      x := x || jsonb_build_object('bal', (x ->> 'bal')::bigint - t.boot, 'playing', true, 'action', null);
    else
      bal := public.wallet_move((x ->> 'uid')::uuid, -t.boot, 'bet', 'Teen Patti • Boot ' || t.boot);
      if bal is null then
        x := x || jsonb_build_object('playing', false, 'action', 'Not enough coins');
      else
        x := x || jsonb_build_object('bal', bal, 'playing', true, 'action', null);
      end if;
    end if;
    x := x || jsonb_build_object('packed', false, 'seen', false);
    if (x ->> 'playing')::boolean then
      insert into tp_hands (table_id, seat, cards) values (t.id, i, jsonb_build_array(d -> k, d -> (k + 1), d -> (k + 2)));
      k := k + 3;
      playing := playing + 1;
    end if;
    s := jsonb_set(s, array[i::text], x);
  end loop;

  t.seats := s;
  t.members := public.tp_members(s, t.queue);
  t.result := null;
  t.pending := null;
  t.hand_no := t.hand_no + 1;
  t.status := 'playing';
  t.pot := t.boot * playing;
  t.stake := t.boot;
  t.round := 1;
  t.next_hand_at := null;
  first_seat := (t.hand_no - 1) % jsonb_array_length(s);
  while not (s -> first_seat ->> 'playing')::boolean loop first_seat := (first_seat + 1) % jsonb_array_length(s); end loop;
  return public.tp_set_turn(t, first_seat);
end;
$function$;

CREATE OR REPLACE FUNCTION public.tp_pay(t tp_tables, seat integer, amt bigint)
 RETURNS tp_tables
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare x jsonb := t.seats -> seat; bal bigint;
begin
  if (x ->> 'bot')::boolean then
    -- Bots never buy back in: they bet from the stack they sat down with (callers pack them first if it can't cover).
    t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('bal', (x ->> 'bal')::bigint - amt));
  else
    bal := public.wallet_move((x ->> 'uid')::uuid, -amt, 'bet', 'Teen Patti • Hand #' || t.hand_no);
    if bal is null then raise exception 'Not enough coins'; end if;
    t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('bal', bal));
  end if;
  t.pot := t.pot + amt;
  return t;
end;
$function$;

CREATE OR REPLACE FUNCTION public.tp_apply(t tp_tables, seat integer, action text)
 RETURNS tp_tables
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare seen boolean := (t.seats -> seat ->> 'seen')::boolean; amt bigint; stake bigint;
begin
  if action in ('pack', 'timeout') then
    t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('packed', true, 'action', case action when 'pack' then 'Pack' else 'Timed out' end));
  else
    stake := case when action = 'raise' then least(t.stake * 2, t.boot * 128) else t.stake end; -- chaal limit: blind stake ≤ boot × 128
    amt := case when seen then stake * 2 else stake end;
    if (t.seats -> seat ->> 'bot')::boolean and (t.seats -> seat ->> 'bal')::bigint < amt then
      -- A bot that can't cover the bet from its own stack packs; when it's too short it leaves at the next hand.
      t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('packed', true, 'action', 'Pack'));
      return public.tp_pass(t, seat);
    end if;
    t.stake := stake;
    t := public.tp_pay(t, seat, amt);
    if not seen then
      t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('blinds_hand', t.hand_no,
        'blinds', case when coalesce((t.seats -> seat ->> 'blinds_hand')::int, -1) = t.hand_no then coalesce((t.seats -> seat ->> 'blinds')::int, 0) + 1 else 1 end));
    end if;
    t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('action',
      case action when 'show' then 'Show' when 'raise' then 'Raise ' || amt else (case when seen then 'Chaal ' else 'Blind ' end) || amt end));
    if action = 'show' then
      if array_length(public.tp_active(t.seats), 1) = 1 then return public.tp_finish(t, (public.tp_active(t.seats))[1], 'Everyone else packed', false); end if;
      return public.tp_showdown(t);
    end if;
  end if;
  return public.tp_pass(t, seat);
end;
$function$;

CREATE OR REPLACE FUNCTION public.tp_request_sideshow(t tp_tables, seat integer)
 RETURNS tp_tables
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare prev int := public.tp_prev_active(t, seat);
begin
  if not (t.seats -> seat ->> 'seen')::boolean then raise exception 'See your cards before asking for a side show'; end if;
  if array_length(public.tp_active(t.seats), 1) < 3 then raise exception 'Side show needs three or more players; use Show'; end if;
  if prev is null or not (t.seats -> prev ->> 'seen')::boolean then raise exception 'The previous player must be Seen for a side show'; end if;
  if (t.seats -> seat ->> 'bot')::boolean and (t.seats -> seat ->> 'bal')::bigint < t.stake * 2 then
    return public.tp_apply(t, seat, 'chaal'); -- can't afford the side show: tp_apply packs it
  end if;
  t := public.tp_pay(t, seat, t.stake * 2);
  t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('action', 'Side show?'));
  t.pending := jsonb_build_object('from', seat, 'to', prev, 'ends', now() + interval '10 seconds',
    'bot_at', case when (t.seats -> prev ->> 'bot')::boolean then now() + make_interval(secs => 1.5 + random() * 3) end);
  t.turn_ends := now() + interval '10 seconds';
  t.bot_acts_at := null;
  return t;
end;
$function$;

revoke execute on function public.tp_start_hand(public.tp_tables) from public, anon, authenticated;
revoke execute on function public.tp_pay(public.tp_tables, int, bigint) from public, anon, authenticated;
revoke execute on function public.tp_apply(public.tp_tables, int, text) from public, anon, authenticated;
