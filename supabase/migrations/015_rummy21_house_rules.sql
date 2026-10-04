-- 015: 21 Card Rummy house rules.
--   • Three printed jokers (one per deck), worth 0 and usable anywhere a joker is.
--   • Wild joker: every card of the cut rank, plus the same-suit cards either side of it
--     (cut 5♥ → all 5s, 4♥ and 6♥ are jokers). 13 Card Rummy keeps "every card of the cut rank".
--   • Tunnela ("3 naali", three identical cards) counts as a pure sequence.
--   • Instant rummy with 3 tunnelas or 8 doubles (pairs of identical cards), however the rest of the hand looks.
--   • 7 doubles in hand when someone else declares: game maaf — no points for that player.
-- Safe to run more than once. Run after 011 (and 012-014). Run it in the Supabase SQL Editor.

-- Which wild joker applies at this table: '5' (13 cards: every 5 is a joker) or '5:♥' (21 cards: every 5, plus
-- 4♥ and 6♥ — the same-suit cards either side of the cut joker; printed jokers 'JK' are always jokers).
create or replace function public.rm_wk(t public.rm_tables) returns text language sql immutable as $$
  select case when t.cards = 21 then (t.wild ->> 'r') || ':' || (t.wild ->> 's') else t.wild ->> 'r' end;
$$;

create or replace function public.rm_isj(c jsonb, w text) returns boolean language sql immutable as $$
  select case
    when c ->> 'r' = 'JK' then true
    when c ->> 'r' = split_part(w, ':', 1) then true
    when position(':' in w) > 0 and c ->> 's' = split_part(w, ':', 2) then
      ((public.rm_low(c ->> 'r') - public.rm_low(split_part(w, ':', 1)) + 13) % 13) in (1, 12)
    else false end;
$$;

create or replace function public.rm_pts(c jsonb, wild text) returns int language sql immutable as $$
  select case when public.rm_isj(c, wild) then 0 when c ->> 'r' in ('A','K','Q','J','10') then 10 else public.rm_low(c ->> 'r') end;
$$;

-- Groups: pure / impure sequence, set, and (21 cards) tunnela = 3 identical cards ("3 naali"), dublee = 2 identical.
create or replace function public.rm_classify(g jsonb, wild text) returns text
language plpgsql immutable as $$
declare n int := jsonb_array_length(g); nat int; jokers int; lo int[]; hi int[]; v int[]; ace_high boolean;
        printed boolean := exists (select 1 from jsonb_array_elements(g) c where c ->> 'r' = 'JK');
begin
  if not printed and n in (2, 3) and (select count(distinct (c ->> 'r') || (c ->> 's')) from jsonb_array_elements(g) c) = 1 then
    return case n when 3 then 'tunnela' else 'dublee' end;
  end if;
  if n < 3 then return 'invalid'; end if;
  if not printed and (select count(distinct c ->> 's') from jsonb_array_elements(g) c) = 1 then
    select array_agg(public.rm_low(c ->> 'r')) into lo from jsonb_array_elements(g) c;
    select array_agg(case when x = 1 then 14 else x end) into hi from unnest(lo) x;
    if (select count(distinct x) from unnest(lo) x) = n and (public.rm_consec(lo) or public.rm_consec(hi)) then return 'pure'; end if;
  end if;
  select count(*) into nat from jsonb_array_elements(g) c where not public.rm_isj(c, wild);
  jokers := n - nat;
  if nat = 0 then return 'invalid'; end if;
  if n <= 4 and (select count(distinct c ->> 'r') from jsonb_array_elements(g) c where not public.rm_isj(c, wild)) = 1
     and (select count(distinct c ->> 's') from jsonb_array_elements(g) c where not public.rm_isj(c, wild)) = nat then
    return 'set';
  end if;
  if (select count(distinct c ->> 's') from jsonb_array_elements(g) c where not public.rm_isj(c, wild)) = 1 then
    foreach ace_high in array array[false, true] loop
      select array_agg(case when ace_high and c ->> 'r' = 'A' then 14 else public.rm_low(c ->> 'r') end)
        into v from jsonb_array_elements(g) c where not public.rm_isj(c, wild);
      if (select count(distinct x) from unnest(v) x) = nat
         and (select max(x) - min(x) + 1 - nat from unnest(v) x) <= jokers then
        return 'impure';
      end if;
    end loop;
  end if;
  return 'invalid';
end;
$$;

-- 13 cards: 1 pure + 1 more sequence, rest in sets/sequences; max 80.
-- 21 cards: 3 pure sequences (a tunnela counts as one), rest in sets/sequences; max 120.
--           Instant rummy: 3 tunnelas, or 8 dublees — whatever the other cards are.
create or replace function public.rm_score_groups(groups jsonb, wild text) returns jsonb
language plpgsql immutable as $$
declare g jsonb; k text; kinds text[] := '{}'; pure int := 0; seqs int := 0; invalid int := 0; cnt int := 0; pts int := 0; i int := 0;
        tun int := 0; dub int := 0; big boolean;
begin
  select coalesce(sum(jsonb_array_length(x)), 0) into cnt from jsonb_array_elements(groups) x;
  big := cnt >= 20;
  for g in select * from jsonb_array_elements(groups) loop
    k := public.rm_classify(g, wild);
    kinds := kinds || k;
    if k = 'pure' then pure := pure + 1; end if;
    if k = 'tunnela' then tun := tun + 1; end if;
    if k = 'dublee' then dub := dub + 1; end if;
    if k in ('pure', 'impure') then seqs := seqs + 1; end if;
    if not (k in ('pure', 'impure', 'set') or (big and k = 'tunnela')) then invalid := invalid + 1; end if;
  end loop;
  if big and cnt = 21 and (tun >= 3 or dub >= 8) then
    return jsonb_build_object('points', 0, 'valid', true);
  end if;
  for g in select * from jsonb_array_elements(groups) loop
    i := i + 1;
    if big then
      if pure + tun < 3 or not (kinds[i] in ('pure', 'impure', 'set', 'tunnela')) then
        pts := pts + (select coalesce(sum(public.rm_pts(c, wild)), 0) from jsonb_array_elements(g) c);
      end if;
    elsif pure = 0 or (seqs < 2 and kinds[i] <> 'pure') or (seqs >= 2 and kinds[i] not in ('pure', 'impure', 'set')) then
      pts := pts + (select coalesce(sum(public.rm_pts(c, wild)), 0) from jsonb_array_elements(g) c);
    end if;
  end loop;
  return jsonb_build_object('points', least(pts, case when big then 120 else 80 end),
    'valid', invalid = 0 and ((cnt = 13 and pure >= 1 and seqs >= 2) or (cnt = 21 and pure + tun >= 3)));
end;
$$;

-- Identical cards in a 21-card hand (printed jokers excluded): how many tunnelas (3 alike) and doubles (2+ alike).
create or replace function public.rm_alike(cards jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'tun', count(*) filter (where n >= 3), 'dub', count(*) filter (where n >= 2),
    'tun_groups', coalesce(jsonb_agg(xs) filter (where n >= 3), '[]'),
    'dub_groups', coalesce(jsonb_agg(jsonb_build_array(xs -> 0, xs -> 1)) filter (where n >= 2), '[]'))
  from (select count(*) n, jsonb_agg(x) xs from jsonb_array_elements(cards) x where x ->> 'r' <> 'JK' group by x ->> 'r', x ->> 's') z;
$$;

-- A 21-card hand that is an instant rummy (3 tunnelas or 8 doubles): its groups, else null.
create or replace function public.rm_special21(cards jsonb) returns jsonb language plpgsql immutable as $$
declare a jsonb := public.rm_alike(cards); groups jsonb; used jsonb := '[]'; g jsonb; k int := 0;
begin
  if jsonb_array_length(cards) <> 21 then return null; end if;
  if (a ->> 'tun')::int >= 3 then
    for g in select * from jsonb_array_elements(a -> 'tun_groups') loop
      exit when k = 3; groups := coalesce(groups, '[]') || jsonb_build_array(g); used := used || g; k := k + 1;
    end loop;
  elsif (a ->> 'dub')::int >= 8 then
    for g in select * from jsonb_array_elements(a -> 'dub_groups') loop
      exit when k = 8; groups := coalesce(groups, '[]') || jsonb_build_array(g); used := used || g; k := k + 1;
    end loop;
  else
    return null;
  end if;
  if jsonb_array_length(public.rm_minus(cards, used)) > 0 then groups := groups || jsonb_build_array(public.rm_minus(cards, used)); end if;
  return groups;
end;
$$;


create or replace function public.rm_greedy(cards jsonb, wild text, strat int) returns jsonb
language plpgsql immutable as $$
declare
  jokers jsonb := (select coalesce(jsonb_agg(c), '[]') from jsonb_array_elements(cards) c where public.rm_isj(c, wild));
  rest jsonb := (select coalesce(jsonb_agg(c), '[]') from jsonb_array_elements(cards) c where not public.rm_isj(c, wild));
  groups jsonb := '[]';
  g jsonb; p jsonb; kind text; i int; placed boolean; sc jsonb;
begin
  loop g := public.rm_find_run(rest); exit when g is null; groups := groups || jsonb_build_array(g); rest := public.rm_minus(rest, g); end loop;
  if strat = 1 then
    loop g := public.rm_find_set(rest, wild); exit when g is null; groups := groups || jsonb_build_array(g); rest := public.rm_minus(rest, g); end loop;
  end if;
  foreach kind in array array['seq', 'set'] loop
    loop
      exit when jsonb_array_length(jokers) = 0;
      p := public.rm_find_pair(rest, wild, kind);
      exit when p is null;
      groups := groups || jsonb_build_array(p || jsonb_build_array(jokers -> 0));
      rest := public.rm_minus(rest, p);
      jokers := jokers - 0;
    end loop;
    if strat = 2 and kind = 'seq' then
      loop g := public.rm_find_set(rest, wild); exit when g is null; groups := groups || jsonb_build_array(g); rest := public.rm_minus(rest, g); end loop;
    end if;
  end loop;
  -- Leftover jokers join a group where they keep it valid (impure sequence, or a set with room); else deadwood.
  while jsonb_array_length(jokers) > 0 loop
    placed := false;
    for i in 0 .. jsonb_array_length(groups) - 1 loop
      if public.rm_classify(groups -> i, wild) = 'impure'
         or (public.rm_classify(groups -> i, wild) = 'set' and jsonb_array_length(groups -> i) < 4) then
        groups := jsonb_set(groups, array[i::text], (groups -> i) || jsonb_build_array(jokers -> 0));
        placed := true;
        exit;
      end if;
    end loop;
    if not placed then
      -- Join a pure run only if another pure run remains (the hand still needs one pure sequence).
      for i in 0 .. jsonb_array_length(groups) - 1 loop
        if public.rm_classify(groups -> i, wild) = 'pure'
           and (select count(*) from jsonb_array_elements(groups) gg where public.rm_classify(gg, wild) = 'pure') >= 2 then
          groups := jsonb_set(groups, array[i::text], (groups -> i) || jsonb_build_array(jokers -> 0));
          placed := true;
          exit;
        end if;
      end loop;
    end if;
    exit when not placed;
    jokers := jokers - 0;
  end loop;
  rest := rest || jokers;
  if jsonb_array_length(rest) > 0 then groups := groups || jsonb_build_array(rest); end if;
  sc := public.rm_score_groups(groups, wild);
  return sc || jsonb_build_object('groups', groups);
end;
$$;

create or replace function public.rm_best(cards jsonb, wild text) returns jsonb
language plpgsql immutable as $$
declare a jsonb := public.rm_greedy(cards, wild, 1); b jsonb := public.rm_greedy(cards, wild, 2); res jsonb; sp jsonb; tg jsonb; rest jsonb; c3 jsonb;
begin
  res := case when (b ->> 'valid')::boolean and not (a ->> 'valid')::boolean then b
              when (a ->> 'valid')::boolean and not (b ->> 'valid')::boolean then a
              when (b ->> 'points')::int < (a ->> 'points')::int then b else a end;
  if jsonb_array_length(cards) >= 20 then
    -- 21 cards: an instant rummy (3 tunnelas / 8 doubles) beats everything; tunnelas also count as pure sequences.
    sp := public.rm_special21(cards);
    if sp is not null then return public.rm_score_groups(sp, wild) || jsonb_build_object('groups', sp); end if;
    tg := (public.rm_alike(cards)) -> 'tun_groups';
    if jsonb_array_length(tg) > 0 then
      rest := cards;
      for c3 in select * from jsonb_array_elements(tg) loop rest := public.rm_minus(rest, c3); end loop;
      c3 := tg || (public.rm_greedy(rest, wild, 1) -> 'groups');
      a := public.rm_score_groups(c3, wild) || jsonb_build_object('groups', c3);
      if ((a ->> 'valid')::boolean and not (res ->> 'valid')::boolean)
         or ((a ->> 'valid')::boolean = (res ->> 'valid')::boolean and (a ->> 'points')::int < (res ->> 'points')::int) then res := a; end if;
    end if;
  end if;
  return res;
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
         unnest(array['♠','♥','♦','♣']) cs
    -- 21 cards: one printed joker per deck.
    union all select jsonb_build_object('id', 155 + j, 'r', 'JK', 's', '★') from generate_series(1, case when t.cards = 21 then 3 else 0 end) j) z;
  delete from rm_hands where table_id = t.id;
  for i in 0 .. n - 1 loop
    x := t.seats -> i;
    if coalesce((x ->> 'in_match')::boolean, false) and not coalesce((x ->> 'out')::boolean, false) then
      select jsonb_agg(d -> j) into hand from generate_series(k, k + t.cards - 1) j;
      insert into rm_hands (table_id, seat, cards) values (t.id, i, hand);
      k := k + t.cards;
      x := x || '{"playing": true, "dropped": false, "middle": false, "wrong": false, "maaf": false, "turns": 0, "timeouts": 0, "picked": null, "action": null, "deal_pts": 0}';
    else
      x := x || '{"playing": false}';
    end if;
    t.seats := jsonb_set(t.seats, array[i::text], x);
  end loop;
  -- The cut card sets the wild joker; a printed joker is never the cut card (move the next ordinary card up).
  if d -> k ->> 'r' = 'JK' then
    select j into first_seat from generate_series(k + 1, jsonb_array_length(d) - 1) j where d -> j ->> 'r' <> 'JK' limit 1;
    hand := d -> k;
    d := jsonb_set(jsonb_set(d, array[k::text], d -> first_seat), array[first_seat::text], hand);
  end if;
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
      -- 21 cards: 7 doubles in hand when someone else goes out — game maaf, no points.
      pts := 0;
      t.seats := public.rm_seat_set(t.seats, i, '{"maaf": true}');
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
      'note', case when i = winner then 'Declared' when coalesce((x ->> 'maaf')::boolean, false) then 'Game maaf (7 doubles)' when not coalesce((x ->> 'playing')::boolean, false) then 'Out'
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
  sc := public.rm_score_groups(groups, public.rm_wk(t));
  -- 21 cards: 3 tunnelas or 8 doubles in hand is a rummy however they are arranged.
  if not (sc ->> 'valid')::boolean and t.cards = 21 and public.rm_special21(cards) is not null then
    update rm_hands set groups = (select jsonb_agg((select jsonb_agg(y -> 'id') from jsonb_array_elements(g) y)) from jsonb_array_elements(public.rm_special21(cards)) g)
      where table_id = t.id and rm_hands.seat = rm_declare.seat;
    sc := '{"valid": true, "points": 0}';
  end if;
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

create or replace function public.rm_draw(t public.rm_tables, seat int, src text) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare p rm_private; card jsonb; top jsonb;
begin
  if t.phase <> 'draw' then raise exception 'You have already drawn a card'; end if;
  select * into p from rm_private where table_id = t.id for update;
  if src = 'open' then
    card := p.open -> 0;
    if card is null then raise exception 'The open pile is empty'; end if;
    if public.rm_isj(card, public.rm_wk(t)) then raise exception 'You can''t pick a joker from the open pile'; end if;
    p.open := p.open - 0;
  else
    if jsonb_array_length(p.stock) = 0 then
      -- Closed deck ran out: reshuffle the open pile (except its top card).
      top := p.open -> 0;
      p.stock := (select coalesce(jsonb_agg(c order by random()), '[]') from jsonb_array_elements(p.open - 0) c);
      p.open := case when top is null then '[]' else jsonb_build_array(top) end;
    end if;
    card := p.stock -> 0;
    p.stock := p.stock - 0;
  end if;
  update rm_private set stock = p.stock, open = p.open where table_id = t.id;
  update rm_hands set cards = cards || jsonb_build_array(card) where table_id = t.id and rm_hands.seat = rm_draw.seat;
  t.open_top := p.open -> 0;
  t.stock_count := jsonb_array_length(p.stock);
  t.phase := 'discard';
  t.seats := public.rm_seat_set(t.seats, seat, jsonb_build_object('turns', (t.seats -> seat ->> 'turns')::int + 1,
               'picked', case when src = 'open' then card -> 'id' end, 'action', case when src = 'open' then 'Picked from Open' else 'Picked from Closed' end));
  return t;
end;
$$;

create or replace function public.rm_timeout(t public.rm_tables) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare st int := t.turn; misses int := coalesce((t.seats -> t.turn ->> 'timeouts')::int, 0) + 1; last_card jsonb; picked int;
begin
  t.seats := public.rm_seat_set(t.seats, st, jsonb_build_object('timeouts', misses));
  if misses >= 3 then return public.rm_drop(t, st); end if;
  if t.phase = 'draw' then t := public.rm_draw(t, st, 'stock'); end if;
  picked := (t.seats -> st ->> 'picked')::int;
  select c into last_card from rm_hands h, jsonb_array_elements(h.cards) with ordinality x(c, i)
    where h.table_id = t.id and h.seat = st and (picked is null or (c ->> 'id')::int <> picked)
    order by case when picked is null then i end desc nulls last, public.rm_pts(c, public.rm_wk(t)) desc limit 1;
  t := public.rm_throw(t, st, (last_card ->> 'id')::int);
  t.seats := public.rm_seat_set(t.seats, st, '{"action": "Timed out • auto"}');
  return public.rm_pass(t, st);
end;
$$;

revoke execute on function public.rm_wk(public.rm_tables), public.rm_isj(jsonb, text), public.rm_alike(jsonb), public.rm_special21(jsonb),
  public.rm_start(public.rm_tables), public.rm_end_deal(public.rm_tables, int), public.rm_declare(public.rm_tables, int, int, jsonb),
  public.rm_bot_move(public.rm_tables), public.rm_draw(public.rm_tables, int, text), public.rm_timeout(public.rm_tables)
  from public, anon, authenticated;
