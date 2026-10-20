-- 067: the old (Postgres) Teen Patti deals fair again.
-- The app now plays Classic Teen Patti on the new engine (migration 066), but phones that still run a cached
-- build keep hitting these functions. 048 made tp_start_hand hand a bot a "natural winning hand" (trail, flush,
-- high pair…) whenever get_outcome_mode() said force_loss — about 60% of hands even in fair mode — which is why
-- players kept seeing trails, and made bots never pack against those players. This restores the pre-048
-- versions: a plain shuffled deal (044) and the original bot (003). 065 already settles the hand honestly.
-- Safe to run more than once. Run after 065 in the Supabase SQL Editor.

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

create or replace function public.tp_bot_move(t public.tp_tables) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  seat int := t.turn;
  x jsonb := t.seats -> t.turn;
  sc int[];
  pack_p float;
  active int[] := public.tp_active(t.seats);
  prev int;
begin
  if t.bot_acts_at >= t.turn_ends then return public.tp_apply(t, seat, 'timeout'); end if;
  if not (x ->> 'seen')::boolean and random() < 0.35 then
    t.seats := public.tp_seat_set(t.seats, seat, '{"seen": true}');
  end if;
  pack_p := 0.08 + t.round * 0.04;
  if (t.seats -> seat ->> 'seen')::boolean then
    select public.tp_score(cards) into sc from tp_hands where table_id = t.id and tp_hands.seat = t.turn;
    pack_p := case when sc[1] >= 3 then pack_p * 0.2 when sc[1] = 2 then pack_p * 0.6 else pack_p * 1.6 end;
  end if;
  if random() < pack_p then return public.tp_apply(t, seat, 'pack'); end if;
  if array_length(active, 1) = 2 and t.round >= 3 and random() < 0.5 then return public.tp_apply(t, seat, 'show'); end if;
  if sc is not null and sc[1] >= 2 and array_length(active, 1) >= 3 and random() < 0.15 then
    prev := public.tp_prev_active(t, seat);
    if prev is not null and (t.seats -> prev ->> 'seen')::boolean then return public.tp_request_sideshow(t, seat); end if;
  end if;
  if sc is not null and sc[1] >= 4 and random() < 0.25 and t.stake < t.boot * 8 then return public.tp_apply(t, seat, 'raise'); end if;
  return public.tp_apply(t, seat, 'chaal');
end;
$$;

revoke execute on function public.tp_start_hand(public.tp_tables) from public, anon, authenticated;
revoke execute on function public.tp_bot_move(public.tp_tables) from public, anon, authenticated;
