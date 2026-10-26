-- 093: Rummy Points — 0.25 and 0.50 coins per point; 100 per point retired. 13 and 21 cards alike.
--
-- A point can now be worth a quarter or half coin, so rm_tables.stake becomes numeric (whole-number tables are
-- unchanged: 1 stays 1). rm_join / rm_join_base / rm_valid_stake take the stake as numeric; the private-table
-- functions keep whole coins. Points ladder: 0.25, 0.5, 1, 2, 5, 10, 20, 50. Coins stay whole: a loser pays
-- round(points x value), the winner floor(total x value, less the fee); buy-ins (80 or 120 points x value) are
-- whole for every value on the ladder.
--
-- Safe to run more than once.

begin;

alter table public.rm_tables alter column stake type numeric using stake::numeric;

drop function if exists public.rm_join(text, bigint, int, text, int, uuid);
drop function if exists public.rm_join_base(text, bigint, int, text, int, uuid);
drop function if exists public.rm_valid_stake(text, bigint, int);

create or replace function public.rm_valid_stake(p_mode text, p_stake numeric, p_deals int) returns boolean
language sql immutable as $$
  select case when p_mode = 'points' then p_stake in (0.25, 0.5, 1, 2, 5, 10, 20, 50)
              when p_mode in ('pool101', 'pool201') then p_stake in (10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000)
              when p_mode = 'deals' then p_stake in (10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000) and p_deals in (2, 3)
              else false end;
$$;

CREATE OR REPLACE FUNCTION public.rm_join_base(p_mode text, p_stake numeric, p_deals integer DEFAULT 0, p_code text DEFAULT NULL::text, p_cards integer DEFAULT 13, p_avoid uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare me profiles := public.current_profile(); t rm_tables; who jsonb; emo text; need bigint;
begin
  if me.id is null or me.role <> 'player' then raise exception 'Only active players can join tables'; end if;
  perform pg_advisory_xact_lock(hashtext('table-join:' || me.id::text));
  if not coalesce((public.game_cfg('rummy') ->> 'enabled')::boolean, true) then raise exception 'Rummy is closed for maintenance'; end if;
  if p_code is not null then
    select * into t from rm_tables where code = upper(trim(p_code));
    if not found then raise exception 'No table with that code'; end if;
    p_mode := t.mode; p_stake := t.stake; p_deals := t.deals; p_cards := t.cards;
  else
    if p_cards not in (13, 21) then raise exception 'Invalid table'; end if;
    if p_mode <> 'deals' then p_deals := 0; end if;
    if not public.rm_valid_stake(p_mode, p_stake, p_deals) then raise exception 'Invalid table'; end if;
  end if;
  need := case when p_mode = 'points' then (case when p_cards = 21 then 120 else 80 end) * p_stake else p_stake end;
  if (select coins from wallets where user_id = me.id) < need then raise exception 'Not enough coins (you need %)', need; end if;
  perform public.check_bet_room(me.id, need);

  select * into t from rm_tables where me.id = any (members) and (p_avoid is null or id <> p_avoid) and mode = p_mode and stake = p_stake and deals = p_deals and cards = p_cards
    and (p_code is null and code is null or code = upper(trim(p_code))) limit 1 for update;
  if found then
    t.seats := (select coalesce(jsonb_agg(case when v ->> 'uid' = me.id::text then v || jsonb_build_object('left', false, 'ping', now()) else v end order by i), '[]')
                from jsonb_array_elements(t.seats) with ordinality x(v, i));
    if t.status = 'waiting' and t.next_at is null then t.next_at := now() + public.rm_join_wait(t); end if;
    perform public.rm_save(t);
    return t.id;
  end if;
  update rm_tables set seats = (select coalesce(jsonb_agg(case when v ->> 'uid' = me.id::text then v || '{"left": true}' else v end order by i), '[]') from jsonb_array_elements(seats) with ordinality x(v, i)),
                       queue = (select coalesce(jsonb_agg(q), '[]') from jsonb_array_elements(queue) q where q ->> 'uid' <> me.id::text)
    where me.id = any (members);
  update rm_tables set members = public.rm_members(seats, queue) where me.id = any (members);

  emo := (array['🧑🏽','👩🏽','👨🏻','👩🏾','🧑🏻','👨🏾'])[1 + abs(hashtext(me.id::text)) % 6];
  who := jsonb_build_object('uid', me.id, 'name', me.name, 'emoji', emo, 'bot', false, 'bal', (select coins from wallets where user_id = me.id), 'ping', now());

  if p_code is not null then
    select * into t from rm_tables where code = upper(trim(p_code)) for update;
    if (select count(*) from jsonb_array_elements(t.seats) v where not coalesce((v ->> 'left')::boolean, false)) + jsonb_array_length(t.queue) >= 6 then
      raise exception 'This table is full';
    end if;
  else
    select * into t from rm_tables tt
      where tt.mode = p_mode and tt.stake = p_stake and tt.deals = p_deals and tt.cards = p_cards and tt.code is null
        and (p_avoid is null or tt.id <> p_avoid)
        and (select count(*) from jsonb_array_elements(tt.seats) v where not (v ->> 'bot')::boolean and not coalesce((v ->> 'left')::boolean, false))
            + jsonb_array_length(tt.queue) < 6
        and tt.updated_at > now() - interval '5 minutes'
      order by (select count(*) from jsonb_array_elements(tt.seats) v where not (v ->> 'bot')::boolean and not coalesce((v ->> 'left')::boolean, false)) desc
      limit 1 for update skip locked;
    if not found then
      insert into rm_tables (mode, stake, deals, cards, queue, members, next_at) values (p_mode, p_stake, p_deals, p_cards, jsonb_build_array(who), array[me.id], now() + interval '3 seconds')
        returning * into t;
      return t.id;
    end if;
  end if;
  t.queue := t.queue || jsonb_build_array(who);
  if t.status = 'waiting' then t.next_at := now() + public.rm_join_wait(t); end if;
  perform public.rm_save(t);
  return t.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.rm_join(p_mode text, p_stake numeric, p_deals integer DEFAULT 0, p_code text DEFAULT NULL::text, p_cards integer DEFAULT 13, p_avoid uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t rm_tables;
begin
  begin
    for t in select * from rm_tables where auth.uid() = any (members) and status = 'playing' and turn_ends < now() - public.rm_away_limit() for update skip locked loop
      t := public.rm_abandon(t);
      perform public.rm_save(t);
    end loop;
    perform public.rm_sweep(5);
  exception when others then
    null; -- housekeeping must never stop a join
  end;
  return public.rm_join_base(p_mode, p_stake, p_deals, p_code, p_cards, p_avoid);
end;
$function$;

CREATE OR REPLACE FUNCTION public.rm_end_deal(t rm_tables, winner integer)
 RETURNS rm_tables
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  n int := jsonb_array_length(t.seats);
  wild text := public.rm_wk(t);
  rake numeric := coalesce((public.game_cfg('rummy') ->> 'rake')::numeric, 10);
  limit_pts int := case t.mode when 'pool101' then 101 when 'pool201' then 201 end;
  x jsonb; h record; pts int; own jsonb; best jsonb; grouped jsonb;
  total_pts int := 0; win bigint; bal bigint; loss bigint;
  rows jsonb := '[]'; hands jsonb := '{}';
  left_in int; champ int; top bigint;
  i int;
  cap int := case when t.cards = 21 then 120 else 80 end;
begin
  -- The person who declared or was determined as winner IS the winner.
  for i in 0 .. n - 1 loop
    x := t.seats -> i;
    continue when not coalesce((x ->> 'playing')::boolean, false);
    select * into h from rm_hands where table_id = t.id and seat = i;
    best := public.rm_best(h.cards, wild);
    grouped := best -> 'groups';
    if i = winner then
      pts := 0;
      if h.groups is not null then grouped := (select jsonb_agg((select jsonb_agg(c) from jsonb_array_elements(h.cards) c where (c ->> 'id')::int in (select (y #>> '{}')::int from jsonb_array_elements(g) y))) from jsonb_array_elements(h.groups) g); end if;
    elsif (x ->> 'wrong')::boolean then pts := cap;
    elsif (x ->> 'dropped')::boolean then pts := public.rm_drop_pts(t.mode, (x ->> 'middle')::boolean);
    elsif t.cards = 21 and ((public.rm_alike(h.cards)) ->> 'dub')::int >= 7 then
      pts := 0;
      t.seats := public.rm_seat_set(t.seats, i, '{"maaf": true}');
    else
      pts := (best ->> 'points')::int;
      if h.groups is not null then
        own := (select jsonb_agg((select jsonb_agg(c) from jsonb_array_elements(h.cards) c where (c ->> 'id')::int in (select (y #>> '{}')::int from jsonb_array_elements(g) y))) from jsonb_array_elements(h.groups) g);
        if (select count(*) from jsonb_array_elements(h.groups) g, jsonb_array_elements(g) y) = jsonb_array_length(h.cards)
           and (select count(*) from jsonb_array_elements(own) g, jsonb_array_elements(g) c) = jsonb_array_length(h.cards)
           and (public.rm_score_groups(own, wild) ->> 'points')::int < pts then
          pts := (public.rm_score_groups(own, wild) ->> 'points')::int;
          grouped := own;
        end if;
      end if;
    end if;
    pts := least(pts, cap);
    total_pts := total_pts + pts;
    t.seats := public.rm_seat_set(t.seats, i, jsonb_build_object('deal_pts', pts));
    hands := hands || jsonb_build_object(i::text, grouped);
  end loop;

  if t.mode = 'points' then
    win := floor(total_pts * t.stake * (1 - rake / 100.0));
    for i in 0 .. n - 1 loop
      x := t.seats -> i;
      continue when not coalesce((x ->> 'playing')::boolean, false);
      loss := case when i = winner then 0 else round((x ->> 'deal_pts')::int * t.stake) end; -- whole coins (a point may be worth 0.25)
      if (x ->> 'bot')::boolean then
        t.seats := public.rm_seat_set(t.seats, i, jsonb_build_object('bal', (x ->> 'bal')::bigint - loss + case when i = winner then win else 0 end));
      else
        bal := public.wallet_move((x ->> 'uid')::uuid, (x ->> 'held')::bigint - loss, 'refund', rm_label(t) || ' • Buy-in returned');
        if i = winner and win > 0 then
          bal := public.wallet_move((x ->> 'uid')::uuid, win, 'win', rm_label(t) || ' • Deal won');
        end if;
        t.seats := public.rm_seat_set(t.seats, i, jsonb_build_object('bal', bal, 'held', 0));
      end if;
    end loop;
    t.match_over := true;
    champ := winner;
  elsif limit_pts is not null then
    for i in 0 .. n - 1 loop
      x := t.seats -> i;
      continue when not coalesce((x ->> 'playing')::boolean, false);
      t.seats := public.rm_seat_set(t.seats, i, jsonb_build_object('score', (x ->> 'score')::int + (x ->> 'deal_pts')::int,
                   'out', (x ->> 'score')::int + (x ->> 'deal_pts')::int >= limit_pts or coalesce((x ->> 'left')::boolean, false)));
    end loop;
    select count(*) into left_in from jsonb_array_elements(t.seats) v where coalesce((v ->> 'in_match')::boolean, false) and not coalesce((v ->> 'out')::boolean, false);
    if left_in <= 1 then
      select i2 - 1 into champ from jsonb_array_elements(t.seats) with ordinality y(v, i2)
        where coalesce((v ->> 'in_match')::boolean, false) and not coalesce((v ->> 'out')::boolean, false) limit 1;
      champ := coalesce(champ, winner);
      t.match_over := true;
    end if;
  else
    for i in 0 .. n - 1 loop
      x := t.seats -> i;
      continue when not coalesce((x ->> 'playing')::boolean, false);
      t.seats := public.rm_seat_set(t.seats, i, jsonb_build_object('score', (x ->> 'score')::int - (x ->> 'deal_pts')::int + case when i = winner then total_pts else 0 end));
    end loop;
    if t.deal_no >= t.deals then
      select max((v ->> 'score')::bigint) into top from jsonb_array_elements(t.seats) v where coalesce((v ->> 'in_match')::boolean, false) and not coalesce((v ->> 'left')::boolean, false);
      select i2 - 1 into champ from jsonb_array_elements(t.seats) with ordinality y(v, i2)
        where coalesce((v ->> 'in_match')::boolean, false) and not coalesce((v ->> 'left')::boolean, false) and (v ->> 'score')::bigint = top
        order by (i2 - 1 = winner) desc limit 1;
      champ := coalesce(champ, winner);
      t.match_over := true;
    end if;
  end if;

  -- Pool / Deals prize to the match winner
  if t.mode <> 'points' and t.match_over then
    x := t.seats -> champ;
    if (x ->> 'bot')::boolean then
      t.seats := public.rm_seat_set(t.seats, champ, jsonb_build_object('bal', (x ->> 'bal')::bigint + t.prize));
    else
      bal := public.wallet_move((x ->> 'uid')::uuid, t.prize, 'win', rm_label(t) || ' • Match won');
      t.seats := public.rm_seat_set(t.seats, champ, jsonb_build_object('bal', bal));
    end if;
  end if;

  for i in 0 .. n - 1 loop
    x := t.seats -> i;
    continue when not coalesce((x ->> 'playing')::boolean, false) and not coalesce((x ->> 'in_match')::boolean, false);
    rows := rows || jsonb_build_array(jsonb_build_object(
      'seat', i, 'name', x ->> 'name', 'bot', (x ->> 'bot')::boolean, 'uid', x ->> 'uid',
      'pts', case when coalesce((x ->> 'playing')::boolean, false) then (x ->> 'deal_pts')::int end,
      'score', (x ->> 'score')::int,
      'note', case when i = winner then 'Declared' when coalesce((x ->> 'maaf')::boolean, false) then 'Game maaf (7 doubles)' when not coalesce((x ->> 'playing')::boolean, false) then 'Out'
                   when (x ->> 'wrong')::boolean then 'Wrong show' when (x ->> 'dropped')::boolean then case when (x ->> 'middle')::boolean then 'Middle drop' else 'Drop' end
                   else 'Lost' end,
      'out', coalesce((x ->> 'out')::boolean, false),
      'coins', case when t.mode = 'points' and coalesce((x ->> 'playing')::boolean, false) then
                 case when i = winner then floor(total_pts * t.stake * (1 - rake / 100.0)) else -round((x ->> 'deal_pts')::int * t.stake) end end,
      'hand', hands -> i::text));
  end loop;
  t.result := jsonb_build_object('winner', winner, 'winner_name', t.seats -> winner ->> 'name', 'rows', rows, 'match_over', t.match_over,
    'champion', champ, 'champion_name', case when champ is not null then t.seats -> champ ->> 'name' end,
    'prize', case when t.mode = 'points' then floor(total_pts * t.stake * (1 - rake / 100.0)) else t.prize end,
    'deal_no', t.deal_no, 'wild', t.wild, 'rake', rake);
  t.status := 'dealdone';
  t.turn := null;
  t.phase := null;
  t.turn_ends := null;
  t.bot_acts_at := null;
  t.next_at := now() + interval '10 seconds';
  return t;
end;
$function$;

revoke execute on function public.rm_join_base(text, numeric, int, text, int, uuid) from public, anon, authenticated;
revoke execute on function public.rm_join(text, numeric, int, text, int, uuid) from public, anon;
grant execute on function public.rm_join(text, numeric, int, text, int, uuid) to authenticated;
revoke execute on function public.rm_valid_stake(text, numeric, int) from public, anon;
grant execute on function public.rm_valid_stake(text, numeric, int) to authenticated;

commit;
