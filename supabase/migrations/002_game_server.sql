-- GameHub game server on Supabase (run after 001_init.sql).
--
-- Games run here, not in the browser: the database shuffles, deals, times turns, plays the bots and moves
-- coins. Clients only send actions and render state.
--   • Casino (Dragon Tiger, Andar Bahar, Lucky 7): casino_round() deals and settles a round in one call.
--   • Teen Patti: shared multiplayer tables (tp_tables). Real players at the same boot are seated together;
--     empty seats are filled with labelled bots. Each player only ever receives their own cards (tp_hands has
--     no read policy). Timers advance "lazily": any seated client calls tp_tick() once a deadline has passed,
--     and the row lock makes that safe when several clients tick at once. Clients follow changes through
--     Supabase Realtime on tp_tables.

-- ---------------------------------------------------------------- cards

create function public.new_deck() returns jsonb
language sql volatile as $$
  select jsonb_agg(jsonb_build_object('r', r, 's', s) order by random())
  from unnest(array['A','2','3','4','5','6','7','8','9','10','J','Q','K']) r
  cross join unnest(array['♠','♥','♦','♣']) s;
$$;

-- A high (Teen Patti) / A low (Dragon Tiger, Lucky 7).
create function public.card_high(r text) returns int language sql immutable as $$
  select case r when 'A' then 14 when 'K' then 13 when 'Q' then 12 when 'J' then 11 else r::int end;
$$;
create function public.card_low(r text) returns int language sql immutable as $$
  select case r when 'A' then 1 when 'K' then 13 when 'Q' then 12 when 'J' then 11 else r::int end;
$$;

-- Internal: move coins for a player and write the ledger. Returns the new balance (null if not enough coins).
create function public.wallet_move(p_uid uuid, p_amount bigint, p_kind text, p_note text) returns bigint
language plpgsql security definer set search_path = public as $$
declare bal bigint;
begin
  if p_amount = 0 then select coins into bal from wallets where user_id = p_uid; return bal; end if;
  update wallets set coins = coins + p_amount, updated_at = now()
    where user_id = p_uid and coins + p_amount >= 0 returning coins into bal;
  if bal is not null then
    insert into ledger (user_id, amount, balance_after, kind, note) values (p_uid, p_amount, bal, p_kind, p_note);
  end if;
  return bal;
end;
$$;

-- ---------------------------------------------------------------- casino

create function public.casino_round(p_game text, p_bets jsonb, p_round text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  names jsonb := '{"dragon-tiger":"Dragon Tiger","andar-bahar":"Andar Bahar","lucky-7":"Lucky 7"}';
  valid text[];
  d jsonb := public.new_deck();
  b jsonb;
  stake bigint := 0;
  ret numeric := 0;
  won_side boolean := false;
  bal bigint;
  cards jsonb;
  winner text;
  joker jsonb; andar jsonb := '[]'; bahar jsonb := '[]'; side text := 'andar'; c jsonb; i int := 1;
  note text;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  valid := case p_game when 'dragon-tiger' then array['dragon','tie','tiger'] when 'andar-bahar' then array['andar','bahar'] when 'lucky-7' then array['below','seven','above'] end;
  if valid is null then raise exception 'Unknown game'; end if;
  for b in select * from jsonb_array_elements(coalesce(p_bets, '[]')) loop
    if not ((b ->> 'side') = any (valid)) or (b ->> 'v')::bigint <= 0 then raise exception 'Invalid bet'; end if;
    stake := stake + (b ->> 'v')::bigint;
  end loop;
  if stake > 100000 then raise exception 'Max 100,000 coins per round'; end if;

  if p_game = 'dragon-tiger' then
    cards := jsonb_build_object('dragon', d -> 0, 'tiger', d -> 1);
    winner := case when card_low(d -> 0 ->> 'r') = card_low(d -> 1 ->> 'r') then 'tie'
                   when card_low(d -> 0 ->> 'r') > card_low(d -> 1 ->> 'r') then 'dragon' else 'tiger' end;
  elsif p_game = 'lucky-7' then
    cards := jsonb_build_object('card', d -> 0);
    winner := case when card_low(d -> 0 ->> 'r') < 7 then 'below' when card_low(d -> 0 ->> 'r') = 7 then 'seven' else 'above' end;
  else
    -- Andar Bahar: centre joker, deal alternately (Andar first) until a card matches the joker's rank.
    joker := d -> 0;
    loop
      c := d -> i;
      if side = 'andar' then andar := andar || jsonb_build_array(c); else bahar := bahar || jsonb_build_array(c); end if;
      exit when c ->> 'r' = joker ->> 'r';
      side := case side when 'andar' then 'bahar' else 'andar' end;
      i := i + 1;
    end loop;
    cards := jsonb_build_object('joker', joker, 'andar', andar, 'bahar', bahar);
    winner := side;
  end if;

  -- Payouts (stake included): 1:1 → ×2, Tie 8:1 → ×9, Exactly 7 11:1 → ×12. Dragon Tiger tie refunds 50% of side bets.
  for b in select * from jsonb_array_elements(coalesce(p_bets, '[]')) loop
    if b ->> 'side' = winner then
      ret := ret + (b ->> 'v')::bigint * (case b ->> 'side' when 'tie' then 9 when 'seven' then 12 else 2 end);
      won_side := true;
    elsif p_game = 'dragon-tiger' and winner = 'tie' then
      ret := ret + (b ->> 'v')::bigint / 2.0;
    end if;
  end loop;
  ret := floor(ret);

  note := (names ->> p_game) || case when p_round <> '' then ' • Round #' || p_round else '' end;
  if stake > 0 then
    bal := public.wallet_move(me.id, -stake, 'bet', note);
    if bal is null then raise exception 'Not enough coins'; end if;
    if ret > 0 then bal := public.wallet_move(me.id, ret::bigint, case when won_side then 'win' else 'refund' end, note); end if;
  else
    select coins into bal from wallets where user_id = me.id;
  end if;
  return jsonb_build_object('cards', cards, 'winner', winner, 'payout', ret, 'stake', stake, 'balance', bal);
end;
$$;

-- ---------------------------------------------------------------- bots

-- A bot for a seat: an active custom bot (random share when auto-generate is on) or a generated name.
create function public.make_bot(p_exclude text[] default '{}') returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  auto boolean := coalesce((select (value)::text::boolean from app_settings where key = 'bots_auto'), true);
  b record;
  fnames text[] := array['Aarav','Aditi','Aditya','Akash','Aman','Amit','Ananya','Anil','Anjali','Ankit','Arjun','Arnav','Asha','Bhavna','Chirag','Deepak','Deepika','Dev','Dhruv','Divya','Farhan','Gaurav','Harsh','Isha','Ishaan','Jatin','Kabir','Kajal','Karan','Kavya','Kiran','Kunal','Manish','Meera','Mohit','Naina','Neha','Nikhil','Nisha','Pooja','Pranav','Priya','Rahul','Raj','Rakesh','Ravi','Rhea','Riya','Rohan','Rohit','Sahil','Sakshi','Sameer','Sanjay','Shreya','Simran','Sneha','Sonia','Sumit','Suresh','Tanvi','Tarun','Varun','Vikas','Vikram','Vinay','Vivek','Yash','Zoya','Imran','Ayesha','Gurpreet','Karthik','Naveen','Prakash','Vijay','Anand','Abhishek','Ritika'];
  lnames text[] := array['Sharma','Verma','Patel','Singh','Gupta','Mehta','Iyer','Nair','Reddy','Rao','Joshi','Kapoor','Khan','Das','Jain','Malhotra','Yadav','Shetty','Desai','Mishra'];
  tags text[] := array['King','Pro','Ace','Boss','Star','Raja','Champ','Lucky','Shark','Tiger'];
  emojis text[] := array['👨🏽','👩🏻','🧔🏾','👨🏻‍🦱','👩🏽‍🦱','🧑🏼','👱🏽‍♂️','👩🏾','🧑🏽‍🦰','👨🏿','👩🏼‍🦰','🧕🏽','👳🏽‍♂️','👨🏾‍🦲','🧑🏻‍🦱'];
  f text; n text; tries int := 0;
begin
  if not auto or random() < 0.3 then
    select name, emoji, bal into b from bots where active and not (name = any (p_exclude)) order by random() limit 1;
    if found then return jsonb_build_object('name', b.name, 'emoji', b.emoji, 'bal', greatest(b.bal, 500), 'bot', true); end if;
  end if;
  loop
    f := fnames[1 + floor(random() * array_length(fnames, 1))::int];
    n := case floor(random() * 6)::int
      when 0 then f
      when 1 then f || ' ' || left(lnames[1 + floor(random() * array_length(lnames, 1))::int], 1)
      when 2 then lower(f) || '_' || (1 + floor(random() * 99))::int
      when 3 then f || ' ' || lnames[1 + floor(random() * array_length(lnames, 1))::int]
      when 4 then tags[1 + floor(random() * array_length(tags, 1))::int] || f
      else f || (1 + floor(random() * 99))::int end;
    tries := tries + 1;
    exit when not (n = any (p_exclude)) or tries > 20;
  end loop;
  return jsonb_build_object('name', n, 'emoji', emojis[1 + floor(random() * array_length(emojis, 1))::int],
                            'bal', (300 + floor(random() * random() * 24000))::int / 10 * 10 + 500, 'bot', true);
end;
$$;

-- ---------------------------------------------------------------- Teen Patti

-- Score compared as an array (higher wins). Values doubled so A-2-3 (27) sits between A-K-Q (28) and K-Q-J (26).
create function public.tp_score(cards jsonb) returns int[]
language plpgsql immutable as $$
declare v int[]; flush boolean; seq boolean; top int[];
begin
  select array_agg(card_high(c ->> 'r') order by card_high(c ->> 'r') desc) into v from jsonb_array_elements(cards) c;
  flush := (select count(distinct c ->> 's') from jsonb_array_elements(cards) c) = 1;
  seq := v[1] - v[2] = 1 and v[2] - v[3] = 1;
  top := array[v[1] * 2, v[2] * 2, v[3] * 2];
  if not seq and v[1] = 14 and v[2] = 3 and v[3] = 2 then seq := true; top := array[27, 0, 0]; end if;
  if v[1] = v[2] and v[2] = v[3] then return array[6] || top; end if;
  if seq and flush then return array[5] || top; end if;
  if seq then return array[4] || top; end if;
  if flush then return array[3] || top; end if;
  if v[1] = v[2] then return array[2, v[2] * 2, v[3] * 2]; end if;
  if v[2] = v[3] then return array[2, v[2] * 2, v[1] * 2]; end if;
  return array[1] || top;
end;
$$;

create function public.tp_hand_name(score int[]) returns text language sql immutable as $$
  select (array['High Card','Pair','Color','Sequence','Pure Sequence','Trail'])[score[1]];
$$;

create table public.tp_tables (
  id uuid primary key default gen_random_uuid(),
  boot bigint not null check (boot > 0),
  status text not null default 'waiting' check (status in ('waiting', 'playing', 'done')),
  hand_no int not null default 0,
  pot bigint not null default 0,
  stake bigint not null default 0,          -- blind stake; a seen player's chaal is 2× this
  round int not null default 1,
  turn int,                                 -- index into seats
  turn_ends timestamptz,
  bot_acts_at timestamptz,
  next_hand_at timestamptz,
  result jsonb,
  seats jsonb not null default '[]',        -- [{uid|null, name, emoji, bot, bal, playing, packed, seen, action, left, ping}]
  queue jsonb not null default '[]',        -- players waiting for the next hand: [{uid, name, emoji}]
  members uuid[] not null default '{}',     -- everyone seated or queued (for row-level security)
  updated_at timestamptz not null default now()
);
create index tp_tables_boot_idx on public.tp_tables (boot);

create table public.tp_hands (
  table_id uuid not null references public.tp_tables (id) on delete cascade,
  seat int not null,
  cards jsonb not null,
  primary key (table_id, seat)
);

alter table public.tp_tables enable row level security;
alter table public.tp_hands enable row level security; -- no policies: cards are only served by tp_view()
create policy "members see their table" on public.tp_tables for select to authenticated using (auth.uid() = any (members));

alter publication supabase_realtime add table public.tp_tables;

create function public.tp_members(s jsonb, q jsonb) returns uuid[] language sql immutable as $$
  select coalesce(array_agg(distinct (x ->> 'uid')::uuid) filter (where x ->> 'uid' is not null), '{}')
  from jsonb_array_elements(s || q) x where coalesce((x ->> 'left')::boolean, false) = false;
$$;

-- Seat index helpers over the seats array (0-based).
create function public.tp_active(s jsonb) returns int[] language sql immutable as $$
  select coalesce(array_agg(i - 1 order by i), '{}') from jsonb_array_elements(s) with ordinality x(v, i)
  where (v ->> 'playing')::boolean and not (v ->> 'packed')::boolean;
$$;

-- Give the turn to `seat`: 15 s clock; bots get a human-like thinking time (sometimes they run out the clock).
create function public.tp_set_turn(t public.tp_tables, seat int) returns public.tp_tables
language plpgsql volatile as $$
declare r float := random(); delay float;
begin
  t.turn := seat;
  t.turn_ends := now() + interval '15 seconds';
  if (t.seats -> seat ->> 'bot')::boolean then
    delay := case when r < 0.3 then 0.8 + random() * 1.7 when r < 0.72 then 3 + random() * 4 when r < 0.95 then 7.5 + random() * 5 else 15 end;
    t.bot_acts_at := now() + make_interval(secs => delay);
  else
    t.bot_acts_at := null;
  end if;
  return t;
end;
$$;

create function public.tp_seat_set(s jsonb, seat int, patch jsonb) returns jsonb language sql immutable as $$
  select jsonb_set(s, array[seat::text], (s -> seat) || patch);
$$;

-- Deal a new hand: seats change (leavers go, queued players sit down, bots fill up to 6), boots are collected.
create function public.tp_start_hand(t public.tp_tables) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
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
  humans int := 0;
  first_seat int;
begin
  -- Keep humans who are still here; bots stay unless broke or they randomly leave between hands.
  for x in select * from jsonb_array_elements(t.seats) loop
    if (x ->> 'bot')::boolean then
      if (x ->> 'bal')::bigint >= t.boot * 4 and random() > 0.12 then s := s || jsonb_build_array(x); end if;
    elsif not coalesce((x ->> 'left')::boolean, false) and (x ->> 'ping')::timestamptz > now() - interval '60 seconds' then
      s := s || jsonb_build_array(x);
    end if;
  end loop;
  -- Queued players take seats (replacing bots if the table is full).
  for q in select * from jsonb_array_elements(t.queue) loop
    if jsonb_array_length(s) >= 6 then
      select coalesce(max(i2) - 1, -1) into i from jsonb_array_elements(s) with ordinality y(v, i2) where (v ->> 'bot')::boolean;
      exit when i < 0;
      s := s - i;
    end if;
    s := s || jsonb_build_array(q || jsonb_build_object('bot', false, 'ping', now()));
  end loop;
  t.queue := '[]';
  -- Fill with bots.
  while jsonb_array_length(s) < 6 loop
    select coalesce(array_agg(v ->> 'name'), '{}') into names from jsonb_array_elements(s) v;
    s := s || jsonb_build_array(public.make_bot(names));
  end loop;

  -- Collect boots. Humans who can't pay sit this hand out.
  delete from tp_hands where table_id = t.id;
  for i in 0 .. jsonb_array_length(s) - 1 loop
    x := s -> i;
    if (x ->> 'bot')::boolean then
      x := x || jsonb_build_object('bal', (x ->> 'bal')::bigint - t.boot, 'playing', true);
    else
      bal := public.wallet_move((x ->> 'uid')::uuid, -t.boot, 'bet', 'Teen Patti • Boot ' || t.boot);
      if bal is null then
        x := x || jsonb_build_object('playing', false, 'action', 'Not enough coins');
      else
        x := x || jsonb_build_object('bal', bal, 'playing', true);
        humans := humans + 1;
      end if;
    end if;
    x := x || jsonb_build_object('packed', false, 'seen', false, 'action', case when (x ->> 'playing')::boolean then null else x ->> 'action' end);
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
  if humans = 0 then
    -- Nobody real is playing: refund nothing (bots only), wait for a player.
    delete from tp_hands where table_id = t.id;
    t.status := 'waiting';
    t.next_hand_at := null;
    t.turn := null;
    return t;
  end if;
  t.hand_no := t.hand_no + 1;
  t.status := 'playing';
  t.pot := t.boot * playing;
  t.stake := t.boot;
  t.round := 1;
  t.next_hand_at := null;
  -- First to act rotates with each hand.
  first_seat := (t.hand_no - 1) % jsonb_array_length(s);
  while not (s -> first_seat ->> 'playing')::boolean loop first_seat := (first_seat + 1) % jsonb_array_length(s); end loop;
  return public.tp_set_turn(t, first_seat);
end;
$$;

-- Pay the pot (5% platform fee) and publish the result. Cards are revealed only on a show.
create function public.tp_finish(t public.tp_tables, winner int, reason text, showdown boolean) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare w jsonb := t.seats -> winner; payout bigint := floor(t.pot * 0.95); bal bigint; reveal jsonb := '[]'; h record; hand text;
begin
  if (w ->> 'bot')::boolean then
    t.seats := public.tp_seat_set(t.seats, winner, jsonb_build_object('bal', (w ->> 'bal')::bigint + payout));
  else
    bal := public.wallet_move((w ->> 'uid')::uuid, payout, 'win', 'Teen Patti • Hand #' || t.hand_no);
    t.seats := public.tp_seat_set(t.seats, winner, jsonb_build_object('bal', bal));
  end if;
  if showdown then
    for h in select seat, cards from tp_hands where table_id = t.id and seat = any (public.tp_active(t.seats)) loop
      reveal := reveal || jsonb_build_array(jsonb_build_object('seat', h.seat, 'cards', h.cards, 'hand', public.tp_hand_name(public.tp_score(h.cards))));
    end loop;
    select public.tp_hand_name(public.tp_score(cards)) into hand from tp_hands where table_id = t.id and seat = winner;
  end if;
  t.result := jsonb_build_object('seat', winner, 'name', w ->> 'name', 'bot', (w ->> 'bot')::boolean, 'uid', w ->> 'uid',
                                 'amount', payout, 'reason', coalesce(hand, reason), 'reveal', reveal, 'pot', t.pot);
  t.status := 'done';
  t.turn := null;
  t.turn_ends := null;
  t.bot_acts_at := null;
  t.next_hand_at := now() + interval '8 seconds';
  return t;
end;
$$;

create function public.tp_showdown(t public.tp_tables) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare best int; h record;
begin
  for h in select seat, cards from tp_hands where table_id = t.id and seat = any (public.tp_active(t.seats)) order by public.tp_score(cards) desc, seat limit 1 loop
    best := h.seat;
  end loop;
  return public.tp_finish(t, best, 'Show', true);
end;
$$;

-- Apply one action for the seat whose turn it is (player or bot), then move the game on.
create function public.tp_apply(t public.tp_tables, seat int, action text) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  x jsonb := t.seats -> seat;
  seen boolean := (x ->> 'seen')::boolean;
  amt bigint;
  bal bigint;
  active int[];
  n int := jsonb_array_length(t.seats);
  nxt int;
begin
  if action in ('pack', 'timeout') then
    t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('packed', true, 'action', case action when 'pack' then 'Pack' else 'Timed out' end));
  else
    if action = 'raise' then t.stake := t.stake * 2; end if;
    amt := case when seen then t.stake * 2 else t.stake end;
    if (x ->> 'bot')::boolean then
      t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('bal', (x ->> 'bal')::bigint - amt));
    else
      bal := public.wallet_move((x ->> 'uid')::uuid, -amt, 'bet', 'Teen Patti • Hand #' || t.hand_no);
      if bal is null then raise exception 'Not enough coins'; end if;
      t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('bal', bal));
    end if;
    t.pot := t.pot + amt;
    t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('action',
      case action when 'show' then 'Show' when 'raise' then 'Raise ' || amt else (case when seen then 'Chaal ' else 'Blind ' end) || amt end));
  end if;

  active := public.tp_active(t.seats);
  if array_length(active, 1) = 1 then return public.tp_finish(t, active[1], 'Everyone else packed', false); end if;
  if action = 'show' then return public.tp_showdown(t); end if;
  if t.pot >= t.boot * 60 then return public.tp_showdown(t); end if; -- pot limit: automatic show

  nxt := seat;
  loop
    nxt := (nxt + 1) % n;
    if nxt <= seat and nxt = active[1] then t.round := t.round + 1; end if;
    exit when nxt = any (active);
  end loop;
  return public.tp_set_turn(t, nxt);
end;
$$;

-- A bot's decision, using its real cards once it has seen them.
create function public.tp_bot_move(t public.tp_tables) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  seat int := t.turn;
  x jsonb := t.seats -> t.turn;
  sc int[];
  pack_p float;
  active int[] := public.tp_active(t.seats);
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
  if sc is not null and sc[1] >= 4 and random() < 0.25 and t.stake < t.boot * 8 then return public.tp_apply(t, seat, 'raise'); end if;
  return public.tp_apply(t, seat, 'chaal');
end;
$$;

-- Advance everything that is due: start the next hand, bot moves, turn timeouts.
create function public.tp_advance(t public.tp_tables) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare steps int := 0;
begin
  loop
    steps := steps + 1;
    exit when steps > 12;
    if t.status in ('waiting', 'done') and t.next_hand_at is not null and t.next_hand_at <= now() then
      t := public.tp_start_hand(t);
    elsif t.status = 'playing' and (t.seats -> t.turn ->> 'bot')::boolean and t.bot_acts_at <= now() then
      t := public.tp_bot_move(t);
    elsif t.status = 'playing' and t.turn_ends <= now() then
      t := public.tp_apply(t, t.turn, 'timeout');
    else
      exit;
    end if;
  end loop;
  return t;
end;
$$;

create function public.tp_save(t public.tp_tables) returns void
language sql security definer set search_path = public as $$
  update tp_tables set status = t.status, hand_no = t.hand_no, pot = t.pot, stake = t.stake, round = t.round, turn = t.turn,
    turn_ends = t.turn_ends, bot_acts_at = t.bot_acts_at, next_hand_at = t.next_hand_at, result = t.result, seats = t.seats,
    queue = t.queue, members = public.tp_members(t.seats, t.queue), updated_at = now()
  where id = t.id;
$$;

-- What one player may see: the public table plus their own cards (only after they chose to See, or at a show).
create function public.tp_view(t public.tp_tables) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me int; mine jsonb;
begin
  select i - 1 into me from jsonb_array_elements(t.seats) with ordinality x(v, i) where v ->> 'uid' = auth.uid()::text;
  if me is not null and (t.seats -> me ->> 'seen')::boolean or (me is not null and t.status = 'done') then
    select cards into mine from tp_hands where table_id = t.id and seat = me;
  end if;
  return jsonb_build_object(
    'id', t.id, 'boot', t.boot, 'status', t.status, 'hand_no', t.hand_no, 'pot', t.pot, 'stake', t.stake, 'round', t.round,
    'turn', t.turn, 'turn_ends', t.turn_ends, 'next_hand_at', t.next_hand_at, 'result', t.result, 'seats', t.seats,
    'queued', exists (select 1 from jsonb_array_elements(t.queue) q where q ->> 'uid' = auth.uid()::text),
    'me', me, 'my_cards', mine, 'my_hand', case when mine is not null then public.tp_hand_name(public.tp_score(mine)) end,
    -- When a client should call tp_tick() next (bot move, turn timeout or next deal).
    'due_at', case when t.status = 'playing' then least(coalesce(t.bot_acts_at, t.turn_ends), t.turn_ends) else t.next_hand_at end,
    'server_now', now());
end;
$$;

-- Sit down at a table with this boot (rejoins your current table if you're still seated).
create function public.tp_join(p_boot bigint) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  t tp_tables;
  who jsonb;
  emo text;
begin
  if me.id is null or me.role <> 'player' then raise exception 'Only active players can join tables'; end if;
  if p_boot not in (10, 25, 50, 100, 200, 500, 1000) then raise exception 'Invalid boot'; end if;
  if (select coins from wallets where user_id = me.id) < p_boot then raise exception 'Not enough coins'; end if;

  -- Already at a table with this boot? Go back to it (reconnect).
  select * into t from tp_tables where me.id = any (members) and boot = p_boot limit 1 for update;
  if found then
    t.seats := (select coalesce(jsonb_agg(case when v ->> 'uid' = me.id::text then v || jsonb_build_object('left', false, 'ping', now()) else v end order by i), '[]')
                from jsonb_array_elements(t.seats) with ordinality x(v, i));
    if t.status = 'waiting' and t.next_hand_at is null then t.next_hand_at := now() + interval '3 seconds'; end if;
    perform public.tp_save(t);
    return t.id;
  end if;
  -- Leave any other table first.
  update tp_tables set seats = (select coalesce(jsonb_agg(case when v ->> 'uid' = me.id::text then v || '{"left": true}' else v end order by i), '[]') from jsonb_array_elements(seats) with ordinality x(v, i)),
                       queue = (select coalesce(jsonb_agg(q), '[]') from jsonb_array_elements(queue) q where q ->> 'uid' <> me.id::text)
    where me.id = any (members);
  update tp_tables set members = public.tp_members(seats, queue) where me.id = any (members);

  emo := (array['🧑🏽','👩🏽','👨🏻','👩🏾','🧑🏻','👨🏾'])[1 + abs(hashtext(me.id::text)) % 6];
  who := jsonb_build_object('uid', me.id, 'name', me.name, 'emoji', emo, 'bot', false, 'bal', (select coins from wallets where user_id = me.id), 'ping', now());

  -- Prefer the table with the most real players that still has room for another.
  select * into t from tp_tables tt
    where tt.boot = p_boot
      and (select count(*) from jsonb_array_elements(tt.seats) v where not (v ->> 'bot')::boolean and not coalesce((v ->> 'left')::boolean, false))
          + jsonb_array_length(tt.queue) < 6
      and tt.updated_at > now() - interval '5 minutes'
    order by (select count(*) from jsonb_array_elements(tt.seats) v where not (v ->> 'bot')::boolean) desc
    limit 1 for update skip locked;

  if not found then
    insert into tp_tables (boot, queue, members, next_hand_at) values (p_boot, jsonb_build_array(who), array[me.id], now() + interval '3 seconds')
      returning * into t;
    return t.id;
  end if;
  t.queue := t.queue || jsonb_build_array(who);
  if t.status = 'waiting' and t.next_hand_at is null then t.next_hand_at := now() + interval '3 seconds'; end if;
  perform public.tp_save(t);
  return t.id;
end;
$$;

-- Read-only state for a table you're at (used after Realtime change notifications; never writes).
create function public.tp_state(p_table uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t tp_tables;
begin
  select * into t from tp_tables where id = p_table and auth.uid() = any (members);
  if not found then raise exception 'You are not at this table'; end if;
  return public.tp_view(t);
end;
$$;

create function public.tp_tick(p_table uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t tp_tables;
begin
  select * into t from tp_tables where id = p_table and auth.uid() = any (members) for update;
  if not found then raise exception 'You are not at this table'; end if;
  t.seats := (select coalesce(jsonb_agg(case when v ->> 'uid' = auth.uid()::text then v || jsonb_build_object('ping', now()) else v end order by i), '[]')
              from jsonb_array_elements(t.seats) with ordinality x(v, i));
  t := public.tp_advance(t);
  perform public.tp_save(t);
  return public.tp_view(t);
end;
$$;

create function public.tp_act(p_table uuid, p_action text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t tp_tables; me int; active int[];
begin
  select * into t from tp_tables where id = p_table and auth.uid() = any (members) for update;
  if not found then raise exception 'You are not at this table'; end if;
  t := public.tp_advance(t);
  select i - 1 into me from jsonb_array_elements(t.seats) with ordinality x(v, i) where v ->> 'uid' = auth.uid()::text;
  if me is null or t.status <> 'playing' or not (t.seats -> me ->> 'playing')::boolean or (t.seats -> me ->> 'packed')::boolean then
    raise exception 'You are not in this hand';
  end if;
  if p_action = 'see' then
    t.seats := public.tp_seat_set(t.seats, me, '{"seen": true}');
  else
    if t.turn <> me then raise exception 'Not your turn'; end if;
    active := public.tp_active(t.seats);
    if p_action = 'show' and array_length(active, 1) <> 2 then raise exception 'Show is only allowed when two players are left'; end if;
    if p_action not in ('pack', 'chaal', 'raise', 'show') then raise exception 'Unknown action'; end if;
    t := public.tp_apply(t, me, p_action);
    t := public.tp_advance(t);
  end if;
  perform public.tp_save(t);
  return public.tp_view(t);
end;
$$;

create function public.tp_leave(p_table uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t tp_tables; me int;
begin
  select * into t from tp_tables where id = p_table and auth.uid() = any (members) for update;
  if not found then return; end if;
  t.queue := (select coalesce(jsonb_agg(q), '[]') from jsonb_array_elements(t.queue) q where q ->> 'uid' <> auth.uid()::text);
  select i - 1 into me from jsonb_array_elements(t.seats) with ordinality x(v, i) where v ->> 'uid' = auth.uid()::text;
  if me is not null then
    if t.status = 'playing' and (t.seats -> me ->> 'playing')::boolean and not (t.seats -> me ->> 'packed')::boolean then
      if t.turn = me then t := public.tp_apply(t, me, 'pack');
      else
        t.seats := public.tp_seat_set(t.seats, me, '{"packed": true, "action": "Left"}');
        if array_length(public.tp_active(t.seats), 1) = 1 then t := public.tp_finish(t, (public.tp_active(t.seats))[1], 'Everyone else packed', false); end if;
      end if;
    end if;
    t.seats := public.tp_seat_set(t.seats, me, '{"left": true}');
  end if;
  perform public.tp_save(t);
end;
$$;

-- ---------------------------------------------------------------- permissions

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
revoke execute on function public.create_profile(uuid, uuid, public.app_role, text, text, text, uuid, text) from authenticated;
revoke execute on function public.write_audit(text, text, text) from authenticated;
revoke execute on function public.wallet_move(uuid, bigint, text, text) from authenticated;
revoke execute on function public.make_bot(text[]) from authenticated;
revoke execute on function public.tp_set_turn(public.tp_tables, int) from authenticated;
revoke execute on function public.tp_start_hand(public.tp_tables) from authenticated;
revoke execute on function public.tp_finish(public.tp_tables, int, text, boolean) from authenticated;
revoke execute on function public.tp_showdown(public.tp_tables) from authenticated;
revoke execute on function public.tp_apply(public.tp_tables, int, text) from authenticated;
revoke execute on function public.tp_bot_move(public.tp_tables) from authenticated;
revoke execute on function public.tp_advance(public.tp_tables) from authenticated;
revoke execute on function public.tp_save(public.tp_tables) from authenticated;
revoke execute on function public.tp_view(public.tp_tables) from authenticated;
