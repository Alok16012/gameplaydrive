-- 011: 21 Card Rummy on the same server engine as 13 Card Rummy.
--
--   • rm_tables.cards = 13 or 21. 21-card tables deal 21 cards each from three decks (wild joker as usual).
--   • A valid 21-card declare needs 3 pure sequences, with every other card in a valid set or sequence.
--     Without 3 pure sequences every card counts; points are capped at 120 (80 for 13 cards), and a wrong
--     show costs the full 120. Points tables hold 120 × the point value as the buy-in.
--   • Same modes as 13 cards (Points, Pool 101/201, Deals). Players only meet others at the same card count.
--   • rm_join / rm_create_private take p_cards (default 13, so 13-card calls are unchanged).
--   • lobby_counts keys 21-card tables as "mode:stake:deals:21".
-- Safe to run more than once. Run it in the Supabase SQL Editor.

alter table public.rm_tables add column if not exists cards int not null default 13;
do $$ begin
  alter table public.rm_tables add constraint rm_tables_cards_check check (cards in (13, 21));
exception when duplicate_object then null; end $$;

create or replace function public.rm_score_groups(groups jsonb, wild text) returns jsonb
language plpgsql immutable as $$
-- 13 cards: 1 pure + 1 more sequence, the rest in sets/sequences; up to 80 points.
-- 21 cards: 3 pure sequences, the rest in sets/sequences; up to 120 points. (The hand size picks the rules.)
declare g jsonb; k text; kinds text[] := '{}'; pure int := 0; seqs int := 0; invalid int := 0; cnt int := 0; pts int := 0; i int := 0;
        big boolean; cap int;
begin
  for g in select * from jsonb_array_elements(groups) loop
    k := public.rm_classify(g, wild);
    kinds := kinds || k;
    if k = 'pure' then pure := pure + 1; end if;
    if k in ('pure', 'impure') then seqs := seqs + 1; end if;
    if k = 'invalid' then invalid := invalid + 1; end if;
    cnt := cnt + jsonb_array_length(g);
  end loop;
  big := cnt >= 20;
  cap := case when big then 120 else 80 end;
  for g in select * from jsonb_array_elements(groups) loop
    i := i + 1;
    if big then
      if pure < 3 or kinds[i] = 'invalid' then
        pts := pts + (select coalesce(sum(public.rm_pts(c, wild)), 0) from jsonb_array_elements(g) c);
      end if;
    elsif pure = 0 or (seqs < 2 and kinds[i] <> 'pure') or (seqs >= 2 and kinds[i] = 'invalid') then
      pts := pts + (select coalesce(sum(public.rm_pts(c, wild)), 0) from jsonb_array_elements(g) c);
    end if;
  end loop;
  return jsonb_build_object('points', least(pts, cap),
    'valid', invalid = 0 and ((cnt = 13 and pure >= 1 and seqs >= 2) or (cnt = 21 and pure >= 3)));
end;
$$;

create or replace function public.rm_start(t public.rm_tables) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  s jsonb := '[]'; x jsonb; q jsonb; names text[]; i int; bal bigint; hold bigint;
  private boolean := t.code is not null;
  new_match boolean := t.mode = 'points' or t.match_over or t.match_no = 0
    -- A Pool/Deals match with no real player left in it is abandoned; start a fresh one.
    or not exists (select 1 from jsonb_array_elements(t.seats) v where not (v ->> 'bot')::boolean and coalesce((v ->> 'in_match')::boolean, false)
                   and not coalesce((v ->> 'out')::boolean, false) and not coalesce((v ->> 'left')::boolean, false));
  in_match int := 0; humans int := 0; eligible int;
  rake numeric := coalesce((public.game_cfg('rummy') ->> 'rake')::numeric, 10);
  d jsonb; k int := 0; hand jsonb; first_seat int; n int;
begin
  if new_match then
    for x in select * from jsonb_array_elements(t.seats) loop
      if (x ->> 'bot')::boolean then
        if not private and random() > 0.15 then s := s || jsonb_build_array(x); end if;
      elsif not coalesce((x ->> 'left')::boolean, false) and (x ->> 'ping')::timestamptz > now() - interval '90 seconds' then
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
        s := s || jsonb_build_array(public.make_bot(names));
      end loop;
    end if;
    hold := case when t.mode = 'points' then (case when t.cards = 21 then 120 else 80 end) * t.stake else t.stake end;
    select count(*) into eligible from jsonb_array_elements(s) v
      where not (v ->> 'bot')::boolean and (select coins from wallets where user_id = (v ->> 'uid')::uuid) >= hold;
    if eligible = 0 or (private and eligible < 2) then
      t.seats := (select coalesce(jsonb_agg(v || jsonb_build_object('in_match', false, 'playing', false,
                    'action', case when not (v ->> 'bot')::boolean and (select coins from wallets where user_id = (v ->> 'uid')::uuid) < hold then 'Not enough coins' end) order by nn), '[]')
                  from jsonb_array_elements(s) with ordinality z(v, nn));
      t.members := public.rm_members(t.seats, t.queue);
      t.status := 'waiting';
      t.next_at := null;
      t.turn := null;
      t.match_over := true;
      delete from rm_hands where table_id = t.id;
      return t;
    end if;
    for i in 0 .. jsonb_array_length(s) - 1 loop
      x := (s -> i) || '{"score": 0, "out": false}';
      if (x ->> 'bot')::boolean then
        x := x || jsonb_build_object('in_match', true, 'action', null);
      else
        bal := public.wallet_move((x ->> 'uid')::uuid, -hold, 'bet', rm_label(t) || case when t.mode = 'points' then ' • Buy-in (max loss)' else ' • Entry' end);
        if bal is null then x := x || jsonb_build_object('in_match', false, 'action', 'Not enough coins');
        else x := x || jsonb_build_object('in_match', true, 'bal', bal, 'action', null, 'held', hold); humans := humans + 1; end if;
      end if;
      if (x ->> 'in_match')::boolean then in_match := in_match + 1; end if;
      s := jsonb_set(s, array[i::text], x);
    end loop;
    t.seats := s;
    t.match_no := t.match_no + 1;
    t.deal_no := 0;
    t.match_over := false;
    t.prize := case when t.mode = 'points' then 0 else floor(t.stake * in_match * (1 - rake / 100.0)) end;
  end if;

  -- Deal: 13 cards each from two shuffled decks (21 cards each from three); next card sets the wild joker; one card starts the open pile.
  n := jsonb_array_length(t.seats);
  select jsonb_agg(c order by random()) into d from (
    select jsonb_build_object('id', (k2 - 1) * 52 + (row_number() over (partition by k2 order by cr, cs)) - 1, 'r', cr, 's', cs) c
    from generate_series(1, case when t.cards = 21 then 3 else 2 end) k2,
         unnest(array['A','2','3','4','5','6','7','8','9','10','J','Q','K']) cr,
         unnest(array['♠','♥','♦','♣']) cs) z;
  delete from rm_hands where table_id = t.id;
  for i in 0 .. n - 1 loop
    x := t.seats -> i;
    if coalesce((x ->> 'in_match')::boolean, false) and not coalesce((x ->> 'out')::boolean, false) then
      select jsonb_agg(d -> j) into hand from generate_series(k, k + t.cards - 1) j;
      insert into rm_hands (table_id, seat, cards) values (t.id, i, hand);
      k := k + t.cards;
      x := x || '{"playing": true, "dropped": false, "middle": false, "wrong": false, "turns": 0, "timeouts": 0, "picked": null, "action": null, "deal_pts": 0}';
    else
      x := x || '{"playing": false}';
    end if;
    t.seats := jsonb_set(t.seats, array[i::text], x);
  end loop;
  t.wild := d -> k;
  t.open_top := d -> (k + 1);
  insert into rm_private (table_id, stock, open) values (t.id, (select jsonb_agg(d -> j order by j) from generate_series(k + 2, jsonb_array_length(d) - 1) j), jsonb_build_array(d -> (k + 1)))
    on conflict (table_id) do update set stock = excluded.stock, open = excluded.open;
  t.stock_count := jsonb_array_length(d) - k - 2;
  t.deal_no := t.deal_no + 1;
  t.round := 1;
  t.status := 'playing';
  t.result := null;
  t.next_at := null;
  t.members := public.rm_members(t.seats, t.queue);
  first_seat := (t.match_no + t.deal_no) % n;
  while not ((t.seats -> first_seat ->> 'playing')::boolean) loop first_seat := (first_seat + 1) % n; end loop;
  return public.rm_set_turn(t, first_seat);
end;
$$;

create or replace function public.rm_end_deal(t public.rm_tables, winner int) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  n int := jsonb_array_length(t.seats);
  wild text := t.wild ->> 'r';
  rake numeric := coalesce((public.game_cfg('rummy') ->> 'rake')::numeric, 10);
  limit_pts int := case t.mode when 'pool101' then 101 when 'pool201' then 201 end;
  x jsonb; h record; pts int; own jsonb; best jsonb; grouped jsonb;
  total_pts int := 0; win bigint; bal bigint; loss bigint;
  rows jsonb := '[]'; hands jsonb := '{}';
  left_in int; champ int; top bigint;
  i int;
  cap int := case when t.cards = 21 then 120 else 80 end;
begin
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
    else
      pts := (best ->> 'points')::int;
      -- The player's own arrangement counts if it covers exactly their cards and scores better.
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
        if i = winner and win > 0 then bal := public.wallet_move((x ->> 'uid')::uuid, win, 'win', rm_label(t) || ' • Deal won'); end if;
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
      'note', case when i = winner then 'Declared' when not coalesce((x ->> 'playing')::boolean, false) then 'Out'
                   when (x ->> 'wrong')::boolean then 'Wrong show' when (x ->> 'dropped')::boolean then case when (x ->> 'middle')::boolean then 'Middle drop' else 'Drop' end
                   else 'Lost' end,
      'out', coalesce((x ->> 'out')::boolean, false),
      'coins', case when t.mode = 'points' and coalesce((x ->> 'playing')::boolean, false) then
                 case when i = winner then floor(total_pts * t.stake * (1 - rake / 100.0)) else -((x ->> 'deal_pts')::int * t.stake) end end,
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

create or replace function public.rm_declare(t public.rm_tables, seat int, card_id int, p_groups jsonb) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare cards jsonb; groups jsonb; sc jsonb; ids int[]; want int[];
begin
  if t.phase <> 'discard' then raise exception 'Draw a card before declaring'; end if;
  t := public.rm_throw(t, seat, card_id);
  select h.cards into cards from rm_hands h where h.table_id = t.id and h.seat = rm_declare.seat;
  select array_agg((y #>> '{}')::int order by (y #>> '{}')::int) into ids from jsonb_array_elements(coalesce(p_groups, '[]')) g, jsonb_array_elements(g) y;
  select array_agg((c ->> 'id')::int order by (c ->> 'id')::int) into want from jsonb_array_elements(cards) c;
  if ids is distinct from want then raise exception 'Your groups must contain exactly your % cards', t.cards; end if;
  groups := (select jsonb_agg((select jsonb_agg(c) from jsonb_array_elements(cards) c where (c ->> 'id')::int in (select (y #>> '{}')::int from jsonb_array_elements(g) y))) from jsonb_array_elements(p_groups) g);
  update rm_hands set groups = p_groups where table_id = t.id and rm_hands.seat = rm_declare.seat;
  sc := public.rm_score_groups(groups, t.wild ->> 'r');
  if (sc ->> 'valid')::boolean then
    t.seats := public.rm_seat_set(t.seats, seat, '{"action": "Declared!"}');
    return public.rm_end_deal(t, seat);
  end if;
  -- Wrong declaration: full points (80, or 120 with 21 cards) and out of this deal; the others play on.
  t.seats := public.rm_seat_set(t.seats, seat, '{"wrong": true, "action": "Wrong show"}');
  return public.rm_pass(t, seat);
end;
$$;

create or replace function public.rm_bot_move(t public.rm_tables) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  st int := t.turn;
  wild text := t.wild ->> 'r';
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
    if top is not null and top ->> 'r' <> wild then
      alt := null;
      for c in select * from jsonb_array_elements(hand) loop
        r := public.rm_best(public.rm_minus(hand || jsonb_build_array(top), jsonb_build_array(c)), wild);
        if alt is null or (r ->> 'points')::int < (alt ->> 'points')::int then alt := r; end if;
      end loop;
      if (alt ->> 'points')::int <= (cur ->> 'points')::int - 4 then
        t := public.rm_draw(t, st, 'open');
        t.bot_acts_at := now() + make_interval(secs => 1 + random() * 2.5);
        return t;
      end if;
    end if;
    t := public.rm_draw(t, st, 'stock');
    t.bot_acts_at := now() + make_interval(secs => 1 + random() * 2.5);
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

create or replace function public.rm_view(t public.rm_tables) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me int; my_cards jsonb; my_groups jsonb;
begin
  select i - 1 into me from jsonb_array_elements(t.seats) with ordinality x(v, i) where v ->> 'uid' = auth.uid()::text;
  if me is not null and t.status <> 'waiting' then
    select h.cards, h.groups into my_cards, my_groups from rm_hands h where h.table_id = t.id and h.seat = me;
  end if;
  return jsonb_build_object(
    'id', t.id, 'cards', t.cards, 'mode', t.mode, 'stake', t.stake, 'deals', t.deals, 'code', t.code, 'status', t.status, 'match_no', t.match_no,
    'deal_no', t.deal_no, 'round', t.round, 'turn', t.turn, 'phase', t.phase, 'turn_ends', t.turn_ends, 'next_at', t.next_at,
    'wild', t.wild, 'open_top', t.open_top, 'stock_count', t.stock_count, 'prize', t.prize, 'match_over', t.match_over,
    'result', t.result, 'seats', t.seats,
    'queued', exists (select 1 from jsonb_array_elements(t.queue) q where q ->> 'uid' = auth.uid()::text),
    'me', me, 'my_cards', my_cards, 'my_groups', my_groups,
    'due_at', case when t.status = 'playing' then least(coalesce(t.bot_acts_at, t.turn_ends), t.turn_ends) else t.next_at end,
    'turn_secs', coalesce((public.game_cfg('rummy') ->> 'turn')::int, 30),
    'server_now', now());
end;
$$;

-- New signatures (extra p_cards argument): drop the old ones so calls are never ambiguous.
drop function if exists public.rm_join(text, bigint, int, text);
drop function if exists public.rm_create_private(text, bigint, int);

create or replace function public.rm_join(p_mode text, p_stake bigint, p_deals int default 0, p_code text default null, p_cards int default 13) returns uuid
language plpgsql security definer set search_path = public as $$
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

  select * into t from rm_tables where me.id = any (members) and mode = p_mode and stake = p_stake and deals = p_deals and cards = p_cards
    and (p_code is null and code is null or code = upper(trim(p_code))) limit 1 for update;
  if found then
    t.seats := (select coalesce(jsonb_agg(case when v ->> 'uid' = me.id::text then v || jsonb_build_object('left', false, 'ping', now()) else v end order by i), '[]')
                from jsonb_array_elements(t.seats) with ordinality x(v, i));
    if t.status = 'waiting' and t.next_at is null then t.next_at := now() + interval '3 seconds'; end if;
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
  if t.status = 'waiting' then t.next_at := now() + interval '3 seconds'; end if;
  perform public.rm_save(t);
  return t.id;
end;
$$;

create or replace function public.rm_create_private(p_mode text, p_stake bigint, p_deals int default 0, p_cards int default 13) returns text
language plpgsql security definer set search_path = public as $$
declare me profiles := public.current_profile(); c text;
begin
  if me.id is null or me.role <> 'player' then raise exception 'Only active players can create tables'; end if;
  if p_mode <> 'deals' then p_deals := 0; end if;
  if not public.rm_valid_stake(p_mode, p_stake, p_deals) or p_cards not in (13, 21) then raise exception 'Invalid table'; end if;
  loop
    c := public.new_code();
    exit when not exists (select 1 from tp_tables where code = c) and not exists (select 1 from rm_tables where code = c);
  end loop;
  insert into rm_tables (mode, stake, deals, cards, code) values (p_mode, p_stake, p_deals, p_cards, c);
  perform public.rm_join(p_mode, p_stake, p_deals, c, p_cards);
  return c;
end;
$$;

create or replace function public.lobby_counts() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'teen-patti', coalesce((select jsonb_object_agg(boot::text, n) from (
        select boot, sum((select count(*) from jsonb_array_elements(seats) v where not (v ->> 'bot')::boolean and not coalesce((v ->> 'left')::boolean, false))
                         + jsonb_array_length(queue)) n
        from tp_tables where code is null and updated_at > now() - interval '2 minutes' group by boot) z), '{}'),
    'rummy', coalesce((select jsonb_object_agg(k, n) from (
        select mode || ':' || stake || ':' || deals || case when cards = 21 then ':21' else '' end k, sum((select count(*) from jsonb_array_elements(seats) v where not (v ->> 'bot')::boolean and not coalesce((v ->> 'left')::boolean, false))
                         + jsonb_array_length(queue)) n
        from rm_tables where code is null and updated_at > now() - interval '2 minutes' group by 1) z), '{}'));
$$;

revoke execute on function public.rm_start(public.rm_tables), public.rm_end_deal(public.rm_tables, int),
  public.rm_declare(public.rm_tables, int, int, jsonb), public.rm_bot_move(public.rm_tables), public.rm_view(public.rm_tables)
  from public, anon, authenticated;
revoke execute on function public.rm_join(text, bigint, int, text, int), public.rm_create_private(text, bigint, int, int) from public, anon;
grant execute on function public.rm_join(text, bigint, int, text, int), public.rm_create_private(text, bigint, int, int) to authenticated;
