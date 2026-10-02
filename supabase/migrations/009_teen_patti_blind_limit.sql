-- 009: Teen Patti blind limit. Run after 008 in the Supabase SQL Editor. Safe to run more than once.
--
-- A player may play at most 4 blind chaals in a hand (setting games → teen-patti → blind_limit, default 4).
-- When their turn comes after that, the server opens their cards (Seen is compulsory) and they continue at the
-- Seen rate (chaal = 2 × stake). Applies to players and bots. The count is per hand.

update public.app_settings set value = jsonb_set(value, '{teen-patti,blind_limit}', '4', true)
  where key = 'games' and value -> 'teen-patti' ->> 'blind_limit' is null;

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
    delay := case when r < 0.45 then 0.8 + random() * 1.7 when r < 0.85 then 2.5 + random() * 2.5 when r < 0.98 then least(5 + random() * 4, secs - 1) else secs end;
    t.bot_acts_at := now() + make_interval(secs => delay);
  else
    t.bot_acts_at := null;
  end if;
  return t;
end;
$$;

create or replace function public.tp_apply(t public.tp_tables, seat int, action text) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare seen boolean := (t.seats -> seat ->> 'seen')::boolean; amt bigint;
begin
  if action in ('pack', 'timeout') then
    t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('packed', true, 'action', case action when 'pack' then 'Pack' else 'Timed out' end));
  else
    if action = 'raise' then t.stake := least(t.stake * 2, t.boot * 128); end if; -- chaal limit: blind stake ≤ boot × 128
    amt := case when seen then t.stake * 2 else t.stake end;
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
$$;

create or replace function public.tp_view(t public.tp_tables) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me int; mine jsonb; other jsonb; ss jsonb := t.last_sideshow;
begin
  select i - 1 into me from jsonb_array_elements(t.seats) with ordinality x(v, i) where v ->> 'uid' = auth.uid()::text;
  if me is not null and ((t.seats -> me ->> 'seen')::boolean or t.status = 'done') then
    select cards into mine from tp_hands where table_id = t.id and seat = me;
  end if;
  -- After an accepted side show, the two players see each other's cards.
  if ss is not null and (ss ->> 'hand_no')::int = t.hand_no and me in ((ss ->> 'from')::int, (ss ->> 'to')::int) then
    select cards into other from tp_hands where table_id = t.id
      and seat = case when me = (ss ->> 'from')::int then (ss ->> 'to')::int else (ss ->> 'from')::int end;
  end if;
  return jsonb_build_object(
    'id', t.id, 'boot', t.boot, 'code', t.code, 'status', t.status, 'hand_no', t.hand_no, 'pot', t.pot, 'stake', t.stake,
    'round', t.round, 'turn', t.turn, 'turn_ends', t.turn_ends, 'next_hand_at', t.next_hand_at, 'result', t.result, 'seats', t.seats,
    'pending', t.pending, 'queued', exists (select 1 from jsonb_array_elements(t.queue) q where q ->> 'uid' = auth.uid()::text),
    'me', me, 'my_cards', mine, 'my_hand', case when mine is not null then public.tp_hand_name(public.tp_score(mine)) end,
    'sideshow', case when other is not null then jsonb_build_object('seat', case when me = (ss ->> 'from')::int then (ss ->> 'to')::int else (ss ->> 'from')::int end,
                     'cards', other, 'hand', public.tp_hand_name(public.tp_score(other)), 'lost', (ss ->> 'loser')::int = me) end,
    'due_at', case when t.status = 'playing' and t.pending is not null then least(coalesce((t.pending ->> 'bot_at')::timestamptz, (t.pending ->> 'ends')::timestamptz), (t.pending ->> 'ends')::timestamptz)
                   when t.status = 'playing' then least(coalesce(t.bot_acts_at, t.turn_ends), t.turn_ends) else t.next_hand_at end,
    'turn_secs', coalesce((public.game_cfg('teen-patti') ->> 'turn')::int, 15),
    'blind_limit', coalesce((public.game_cfg('teen-patti') ->> 'blind_limit')::int, 4),
    'server_now', now());
end;
$$;

revoke execute on function public.tp_set_turn(public.tp_tables, int) from public, anon, authenticated;
revoke execute on function public.tp_apply(public.tp_tables, int, text) from public, anon, authenticated;
revoke execute on function public.tp_view(public.tp_tables) from public, anon, authenticated;
