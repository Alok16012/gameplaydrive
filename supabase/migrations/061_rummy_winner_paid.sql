-- 061: a rummy winner is always paid unless Win / Loss Control really says Force Loss.
-- 049 asked get_outcome_mode() three separate times while settling a deal. That function is random — it says
-- force_loss about 60% of the time even in plain "fair" mode — so most winners were not paid, while the result
-- screen still showed "+coins"; the three answers could also disagree with each other.
-- Now rm_force_loss() decides once per deal:
--   * account (or its agent / admin) set to Force Loss by name → always force loss;
--   * set to Force Win or Fair by name → never;
--   * otherwise Rummy's game setting, then the global setting: Force Loss → force loss at the configured rate
--     (85% by default, as before); Fair / Force Win → never.
-- The result screen shows 0 coins for a win that was not paid.
-- Safe to run more than once. Run after 049 (and 058) in the Supabase SQL Editor.

create or replace function public.rm_force_loss(p_uid uuid) returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare
  ctrl jsonb;
  m text;
  rate float8 := 0.85;
begin
  if p_uid is null then return false; end if;
  select value into ctrl from app_settings where key = 'outcome_control';

  -- 1. Set by name on the account or the nearest account above it (same lookup as get_outcome_mode).
  if ctrl is not null then
    with recursive up as (
      select id, parent_id, 1 as depth from profiles where id = p_uid
      union all
      select p.id, p.parent_id, up.depth + 1 from profiles p join up on p.id = up.parent_id
    )
    select coalesce(ctrl -> 'players' ->> up.id::text, ctrl -> 'agents' ->> up.id::text,
                    ctrl -> 'admins' ->> up.id::text, ctrl -> 'accounts' ->> up.id::text)
      into m
    from up
    where coalesce(ctrl -> 'players' ->> up.id::text, ctrl -> 'agents' ->> up.id::text,
                   ctrl -> 'admins' ->> up.id::text, ctrl -> 'accounts' ->> up.id::text) in ('force_win', 'force_loss', 'fair')
    order by depth asc
    limit 1;
    if m = 'force_loss' then return true; end if;
    if m = 'force_win' then return false; end if;
  end if;

  -- 2. Rummy's own setting, then the global one.
  m := null;
  if ctrl is not null and ctrl -> 'games' ->> 'rummy' in ('force_win', 'force_loss') then m := ctrl -> 'games' ->> 'rummy'; end if;
  if m is null and public.game_cfg('rummy') ->> 'outcome_mode' in ('force_win', 'force_loss') then m := public.game_cfg('rummy') ->> 'outcome_mode'; end if;
  if m is null and ctrl is not null and ctrl ->> 'global_mode' in ('force_win', 'force_loss') then m := ctrl ->> 'global_mode'; end if;
  if m is distinct from 'force_loss' then return false; end if;

  if ctrl is not null and (ctrl -> 'rates' -> 'force_loss' ? 'loss') then
    rate := (ctrl -> 'rates' -> 'force_loss' ->> 'loss')::float8 / 100.0;
  end if;
  return random() < rate;
end;
$$;
revoke execute on function public.rm_force_loss(uuid) from public, anon, authenticated;

create or replace function public.rm_end_deal(t public.rm_tables, winner int) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
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
  bot_seat int;
  win_fl boolean := false; -- the declared winner is a human on Force Loss (decided once per deal)
begin
  -- Force Loss: the deal goes to a bot at the table instead (with no bot, the win is simply not paid).
  if not (t.seats -> winner ->> 'bot')::boolean then
    win_fl := public.rm_force_loss((t.seats -> winner ->> 'uid')::uuid);
    if win_fl then
      select (i2 - 1) into bot_seat from jsonb_array_elements(t.seats) with ordinality y(v, i2) where (v ->> 'bot')::boolean limit 1;
      if bot_seat is not null then
        winner := bot_seat;
      end if;
    end if;
  end if;

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
      loss := case when i = winner then 0 else (x ->> 'deal_pts')::int * t.stake end;
      if (x ->> 'bot')::boolean then
        t.seats := public.rm_seat_set(t.seats, i, jsonb_build_object('bal', (x ->> 'bal')::bigint - loss + case when i = winner then win else 0 end));
      else
        bal := public.wallet_move((x ->> 'uid')::uuid, (x ->> 'held')::bigint - loss, 'refund', rm_label(t) || ' • Buy-in returned');
        if i = winner and win > 0 then
          if not win_fl then
            bal := public.wallet_move((x ->> 'uid')::uuid, win, 'win', rm_label(t) || ' • Deal won');
          end if;
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

  -- Pool / Deals prize to the match winner.
  if t.mode <> 'points' and t.match_over then
    x := t.seats -> champ;
    if (x ->> 'bot')::boolean then
      t.seats := public.rm_seat_set(t.seats, champ, jsonb_build_object('bal', (x ->> 'bal')::bigint + t.prize));
    else
      if not (case when champ = winner then win_fl else public.rm_force_loss((x ->> 'uid')::uuid) end) then
        bal := public.wallet_move((x ->> 'uid')::uuid, t.prize, 'win', rm_label(t) || ' • Match won');
        t.seats := public.rm_seat_set(t.seats, champ, jsonb_build_object('bal', bal));
      end if;
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
                 case when i = winner then (case when win_fl and not (x ->> 'bot')::boolean then 0 else floor(total_pts * t.stake * (1 - rake / 100.0)) end) else -((x ->> 'deal_pts')::int * t.stake) end end,
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
$$;
