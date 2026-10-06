-- Khelobaazi: database updates 021 → 028 in one go. Paste all of this into the Supabase SQL Editor and press Run.
-- Every part is safe to run more than once. (024 and 023 are already in your database; 020_game_outcome_control is
-- left out on purpose — 022 below switches it off.)
--   021  WhatsApp support number (Super Admin → Game Config)
--   022  Fair play restored: honest game rounds, won games are paid, outcome control off
--   025  Computer players take their time (Teen Patti fallback, Rummy)
--   026  Plinko payouts booked as winnings
--   027  Quicker Stock Market rounds
--   028  Ludo with friends (private tables by code)

-- =====================================================================  021_support_contact.sql
-- 021: Help & Support contact — a WhatsApp number (and an optional short note) that the Super Admin sets and
-- every player sees on the Help screen and the login page. Only for support chats.
-- Safe to run more than once. Run after 018. Run it in the Supabase SQL Editor.

insert into public.app_settings (key, value) values ('support', '{}'::jsonb) on conflict (key) do nothing;

-- Super Admin: set (or clear, with an empty number) the support WhatsApp number. Stored as digits with the
-- country code (a 10-digit Indian number gets 91 in front). Every change goes to the audit log.
create or replace function public.set_support_contact(p_whatsapp text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  num text := regexp_replace(coalesce(p_whatsapp, ''), '\D', '', 'g');
  old jsonb := coalesce((select value from app_settings where key = 'support'), '{}'::jsonb);
  v jsonb;
begin
  if not public.is_superadmin() then raise exception 'Only the Super Admin can change the support number'; end if;
  if length(num) = 10 then num := '91' || num; end if;
  if num <> '' and (length(num) < 11 or length(num) > 15) then
    raise exception 'Enter the WhatsApp number with country code, e.g. +91 98765 43210';
  end if;
  if length(coalesce(p_note, '')) > 140 then raise exception 'Keep the note under 140 characters'; end if;
  v := jsonb_strip_nulls(jsonb_build_object('whatsapp', nullif(num, ''), 'note', nullif(trim(coalesce(p_note, '')), '')));
  insert into app_settings (key, value) values ('support', v) on conflict (key) do update set value = excluded.value;
  insert into audit_log (actor_id, actor_name, action, before, after)
    values (me.id, me.name, 'Support contact changed', old::text, v::text);
  return v;
end;
$$;

-- Anyone may read it, signed in or not (the login page shows it too).
create or replace function public.support_contact() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select value from app_settings where key = 'support'), '{}'::jsonb);
$$;

revoke execute on function public.set_support_contact(text, text) from public, anon;
grant execute on function public.set_support_contact(text, text) to authenticated;
grant execute on function public.support_contact() to anon, authenticated;

-- =====================================================================  022_restore_fair_play.sql
-- 022: Fair play restored. Undoes the outcome control from 020_game_outcome_control.sql: every game goes back
-- to its honest version, where results come only from the shuffle / RNG and the rules, and a won game is paid.
--   • Aviator, Dragon Tiger / Andar Bahar / Lucky 7, Roulette, Plinko: the original server rounds (010, 006, 012).
--   • Ludo / Carrom / Chess / Poker payouts: game_payout as in 017 (capped by the stake, never refused for a win).
--   • Blackjack: the one-argument bj_deal from 020_game_outcome_control is dropped; the side-bet version
--     (020_blackjack_side_bets.sql) stays.
--   • get_outcome_mode() always answers 'fair' and nobody can set outcomes any more.
-- Safe to run more than once. Run it in the Supabase SQL Editor after everything else.

-- av_round: from 010_aviator.sql
create or replace function public.av_round() returns public.av_rounds
language plpgsql volatile security definer set search_path = public as $$
declare r av_rounds; u float8; c numeric;
begin
  perform pg_advisory_xact_lock(7788001);
  select * into r from av_rounds order by id desc limit 1;
  if r.id is null or now() > r.crash_at + interval '3 seconds' then
    u := random();
    c := least(500, greatest(1.00, floor(97.0 / (1 - u)) / 100.0));
    insert into av_rounds (starts_at, crash, crash_at)
      values (now() + interval '7 seconds', c, now() + interval '7 seconds' + make_interval(secs => ln(c) / 0.1))
      returning * into r;
  end if;
  return r;
end;
$$;

-- casino_round: from 006_lucky7_markets.sql
create or replace function public.casino_round(p_game text, p_bets jsonb, p_round text default '') returns jsonb
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
    if not ((b ->> 'side') = any (valid)
            or (p_game = 'dragon-tiger' and (b ->> 'side') ~ '^(pair|[dt]_(even|odd|black|red|A|[2-9]|10|J|Q|K))$')
            or (p_game = 'lucky-7' and (b ->> 'side') ~ '^(low|high|even|odd|black|red|g_(a23|456|8910|jqk)|c_(A|[2-9]|10|J|Q|K))$'))
       or (b ->> 'v')::bigint <= 0 then raise exception 'Invalid bet'; end if;
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

  for b in select * from jsonb_array_elements(coalesce(p_bets, '[]')) loop
    if p_game = 'dragon-tiger' then
      if public.dt_pay(b ->> 'side', d -> 0, d -> 1, winner) > 0 then
        ret := ret + (b ->> 'v')::bigint * public.dt_pay(b ->> 'side', d -> 0, d -> 1, winner);
        won_side := true;
      elsif winner = 'tie' and b ->> 'side' in ('dragon', 'tiger') then
        ret := ret + (b ->> 'v')::bigint / 2.0;
      end if;
    elsif p_game = 'lucky-7' then
      if public.l7_pay(b ->> 'side', d -> 0) > 0 then
        ret := ret + (b ->> 'v')::bigint * public.l7_pay(b ->> 'side', d -> 0);
        won_side := true;
      end if;
    elsif b ->> 'side' = winner then
      ret := ret + (b ->> 'v')::bigint * 2;
      won_side := true;
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

-- game_payout: from 017_client_game_payout_caps.sql
create or replace function public.game_payout(amount bigint, p_note text, p_kind text default 'win') returns bigint
language plpgsql security definer set search_path = public as $$
declare me profiles := public.current_profile(); bal bigint; g text := public.game_key(p_note); open bigint; cap bigint;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if amount <= 0 or p_kind not in ('win', 'refund') then raise exception 'Invalid payout'; end if;
  perform 1 from game_stakes where user_id = me.id and game = g and not settled for update;
  select coalesce(sum(s.amount), 0) into open from game_stakes s
    where s.user_id = me.id and s.game = g and not s.settled and s.created_at > now() - interval '3 hours';
  cap := case when p_kind = 'refund' then open else floor(open * public.game_max_mult(g)) end;
  if open = 0 or amount > cap then raise exception 'Payout rejected'; end if;
  update game_stakes set settled = true where user_id = me.id and game = g and not settled;
  update wallets set coins = coins + amount, updated_at = now() where user_id = me.id returning coins into bal;
  insert into ledger (user_id, amount, balance_after, kind, note) values (me.id, amount, bal, p_kind, p_note);
  return bal;
end;
$$;

-- plinko_drop: from 012_roulette_blackjack_plinko.sql
create or replace function public.plinko_drop(p_amount bigint, p_rows int, p_risk text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  mults numeric[] := public.plinko_table(p_rows, p_risk);
  path int[] := '{}'; slot int := 0; step int; m numeric; pay bigint; bal bigint; note text;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if mults is null then raise exception 'Invalid board'; end if;
  if p_amount < 10 or p_amount > 10000 then raise exception 'Bet between 10 and 10,000 coins'; end if;
  for i in 1 .. p_rows loop
    step := case when random() < 0.5 then 0 else 1 end;
    path := path || step;
    slot := slot + step;
  end loop;
  m := mults[slot + 1];
  pay := floor(p_amount * m);
  note := 'Plinko • ' || p_rows || ' rows • ' || p_risk || ' • ' || m || 'x';
  bal := public.wallet_move(me.id, -p_amount, 'bet', note);
  if bal is null then raise exception 'Not enough coins'; end if;
  if pay > 0 then bal := public.wallet_move(me.id, pay, case when pay >= p_amount then 'win' else 'refund' end, note); end if;
  return jsonb_build_object('path', to_jsonb(path), 'slot', slot, 'mult', m, 'payout', pay, 'balance', bal);
end;
$$;

-- roulette_spin: from 012_roulette_blackjack_plinko.sql
create or replace function public.roulette_spin(p_bets jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  b jsonb; stake bigint := 0; ret bigint := 0; n int; bal bigint; spin_id bigint;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if jsonb_typeof(p_bets) <> 'array' or jsonb_array_length(p_bets) = 0 then raise exception 'Place a bet first'; end if;
  for b in select * from jsonb_array_elements(p_bets) loop
    if public.rl_pay(b ->> 'side', 0) is null or coalesce((b ->> 'v')::bigint, 0) <= 0 then raise exception 'Invalid bet'; end if;
    stake := stake + (b ->> 'v')::bigint;
  end loop;
  if stake > 100000 then raise exception 'Max 100,000 coins per spin'; end if;

  n := floor(random() * 37)::int;
  for b in select * from jsonb_array_elements(p_bets) loop
    if public.rl_pay(b ->> 'side', n) > 0 then
      ret := ret + (b ->> 'v')::bigint * public.rl_pay(b ->> 'side', n);
    end if;
  end loop;

  insert into rl_spins (user_id, num, stake, payout) values (me.id, n, stake, ret) returning id into spin_id;
  bal := public.wallet_move(me.id, -stake, 'bet', 'Roulette • Spin #' || spin_id);
  if bal is null then raise exception 'Not enough coins'; end if;
  if ret > 0 then bal := public.wallet_move(me.id, ret, 'win', 'Roulette • Spin #' || spin_id || ' • ' || n); end if;
  return jsonb_build_object('id', spin_id, 'number', n, 'stake', stake, 'payout', ret, 'balance', bal, 'history', public.rl_history());
end;
$$;

-- set_game_settings: from 023_stock_market.sql (the latest version, with Stock Market)
create or replace function public.set_game_settings(p_game text, p_cfg jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare old jsonb := public.game_cfg(p_game); new jsonb := public.game_cfg(p_game); k text; v jsonb; n numeric;
        games text[] := array['teen-patti','rummy','andar-bahar','dragon-tiger','lucky-7','aviator','roulette','plinko','blackjack','poker','ludo','chess','stock-market'];
begin
  if not public.is_superadmin() then raise exception 'Only the Super Admin can change game settings'; end if;
  if not (p_game = any (games)) then raise exception 'Unknown game'; end if;
  for k, v in select * from jsonb_each(coalesce(p_cfg, '{}')) loop
    if k = 'enabled' then
      if jsonb_typeof(v) <> 'boolean' then raise exception 'enabled must be true or false'; end if;
      new := new || jsonb_build_object(k, v);
    elsif k in ('min_bet', 'max_bet') then
      if v = 'null'::jsonb or v = '""'::jsonb then new := new - k; continue; end if;
      n := (v #>> '{}')::numeric;
      if n < 1 or n > 1000000 or n <> floor(n) then raise exception 'Bets must be whole coins from 1 to 1,000,000'; end if;
      new := new || jsonb_build_object(k, n::bigint);
    elsif k = 'rake' then
      n := (v #>> '{}')::numeric;
      if n < 0 or n > 25 then raise exception 'Platform fee must be between 0 and 25%%'; end if;
      new := new || jsonb_build_object(k, n);
    elsif k = 'turn' then
      if p_game not in ('teen-patti', 'rummy') then continue; end if;
      n := (v #>> '{}')::numeric;
      if n < 10 or n > 90 then raise exception 'Turn time must be between 10 and 90 seconds'; end if;
      new := new || jsonb_build_object(k, n::int);
    elsif k = 'blind_limit' then
      if p_game <> 'teen-patti' then continue; end if;
      n := (v #>> '{}')::numeric;
      if n < 1 or n > 10 then raise exception 'Blind limit must be between 1 and 10'; end if;
      new := new || jsonb_build_object(k, n::int);
    elsif k = 'bot_speed' then
      if p_game not in ('ludo', 'chess', 'poker') then continue; end if;
      if v #>> '{}' not in ('slow', 'normal', 'fast') then raise exception 'Bot speed must be slow, normal or fast'; end if;
      new := new || jsonb_build_object(k, v #>> '{}');
    else
      raise exception 'Unknown setting %', k;
    end if;
  end loop;
  if (new ->> 'min_bet') is not null and (new ->> 'max_bet') is not null and (new ->> 'min_bet')::bigint > (new ->> 'max_bet')::bigint then
    raise exception 'Minimum bet can''t be above the maximum';
  end if;
  insert into app_settings (key, value) values ('games', '{}') on conflict (key) do nothing;
  update app_settings set value = jsonb_set(coalesce(value, '{}'), array[p_game], new) where key = 'games';
  perform public.write_audit('Game settings • ' || p_game, old::text, new::text);
  return new;
end;
$$;

-- Blackjack: only the side-bet deal remains.
drop function if exists public.bj_deal(bigint);

-- Outcome control switched off for good.
create or replace function public.get_outcome_mode(p_user_id uuid, p_game text) returns text
language sql stable as $$ select 'fair'::text $$;
do $$ begin
  if exists (select 1 from pg_proc where proname = 'set_outcome_control' and pronamespace = 'public'::regnamespace) then
    execute (select string_agg(format('revoke execute on function %s from public, anon, authenticated', p.oid::regprocedure), '; ')
             from pg_proc p where p.proname = 'set_outcome_control' and p.pronamespace = 'public'::regnamespace);
  end if;
end $$;

-- =====================================================================  025_human_bot_timing.sql
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

-- =====================================================================  026_plinko_wins.sql
-- 026: Plinko pays are winnings. Whatever a ball pays back (even a 0.5x slot) is booked as 'win' — it was
-- booked as 'refund' when it paid less than the stake, so it showed under Refunds. Reports already count
-- 'win' and 'refund' together as payouts, so totals don't change. Earlier Plinko rows are relabelled too.
-- Safe to run more than once. Run it in the Supabase SQL Editor.

create or replace function public.plinko_drop(p_amount bigint, p_rows int, p_risk text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  mults numeric[] := public.plinko_table(p_rows, p_risk);
  path int[] := '{}'; slot int := 0; step int; m numeric; pay bigint; bal bigint; note text;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if mults is null then raise exception 'Invalid board'; end if;
  if p_amount < 10 or p_amount > 10000 then raise exception 'Bet between 10 and 10,000 coins'; end if;
  for i in 1 .. p_rows loop
    step := case when random() < 0.5 then 0 else 1 end;
    path := path || step;
    slot := slot + step;
  end loop;
  m := mults[slot + 1];
  pay := floor(p_amount * m);
  note := 'Plinko • ' || p_rows || ' rows • ' || p_risk || ' • ' || m || 'x';
  bal := public.wallet_move(me.id, -p_amount, 'bet', note);
  if bal is null then raise exception 'Not enough coins'; end if;
  if pay > 0 then bal := public.wallet_move(me.id, pay, 'win', note); end if;
  return jsonb_build_object('path', to_jsonb(path), 'slot', slot, 'mult', m, 'payout', pay, 'balance', bal);
end;
$$;

update public.ledger set kind = 'win' where kind = 'refund' and note like 'Plinko •%';

-- =====================================================================  027_stock_market_pace.sql
-- 027: Stock Market, a quicker round: 7 s to bet, the market runs 14.4 s (80 ticks of 0.18 s), and the next
-- round opens 3 s after the close (≈ 24 s a round instead of ≈ 34 s). Same price model, same fairness.
-- The app takes the tick length from each round, so it works before and after this runs.
-- Safe to run more than once. Run it in the Supabase SQL Editor (after 023).

create or replace function public.sm_tick(r public.sm_rounds) returns int language sql stable as $$
  select least(80, greatest(0, floor(extract(epoch from (now() - r.starts_at)) / 0.18)::int));
$$;

create or replace function public.sm_round() returns public.sm_rounds
language plpgsql volatile security definer set search_path = public as $$
declare r sm_rounds; p numeric := 1; s numeric; v_path numeric[] := array[1.0]; i int;
begin
  perform pg_advisory_xact_lock(7788023);
  select * into r from sm_rounds order by id desc limit 1;
  if r.id is null or now() > r.ends_at + interval '3 seconds' then
    for i in 1..80 loop
      s := 0.035 * (0.3 + 1.4 * random());
      if random() < 0.08 then s := s * 2.5; end if;   -- the odd sharp move
      s := least(s, 0.5 * p, 0.5 * (2 - p));           -- never reaches 0 or 2, still fair
      if random() < 0.5 then p := p + s; else p := p - s; end if;
      v_path := v_path || round(p, 4);
    end loop;
    insert into sm_rounds (starts_at, ends_at, path)
      values (now() + interval '7 seconds', now() + interval '21.4 seconds', v_path)
      returning * into r;
  end if;
  return r;
end;
$$;

-- =====================================================================  028_ludo_private.sql
-- 028: Ludo private tables — play with friends by invite code, run entirely by the database.
--   • The host creates a table for 2 or 4 players with an entry (coins). Friends join with the 6-character code;
--     everyone's entry goes into the pot. The game starts as soon as the table is full. No bots.
--   • The database rolls every dice and checks every move. Rules are the app's Ludo rules: a 6 brings a token out,
--     three 6s in a row lose the turn, landing on an opponent (off the star squares) sends it home, and a 6, a
--     capture or reaching home earns another roll. First to bring all four tokens home wins the pot (less the
--     platform fee from Game Config → Ludo).
--   • Each turn has 20 s. When it runs out the table plays for that player (rolls, and makes the best move).
--   • Leaving before the start returns the entry. Leaving a running game gives it up; if only one player is left,
--     they win.
--   • Seats on the board: 2 players are red and yellow (across from each other); 4 players are red, green,
--     yellow, blue in the order they joined.
-- Safe to run more than once. Run it in the Supabase SQL Editor (after 018).

create table if not exists public.ld_tables (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  entry bigint not null check (entry >= 0),
  max_players int not null check (max_players in (2, 4)),
  status text not null default 'waiting' check (status in ('waiting', 'playing', 'done', 'cancelled')),
  seats jsonb not null default '[]',   -- [{uid, name, emoji, colour 0-3, tokens [4 × progress], left, misses}]
  turn int,                            -- index into seats
  phase text,                          -- 'roll' | 'move'
  dice int,
  sixes int not null default 0,
  turn_ends timestamptz,
  winner int,
  pot bigint not null default 0,
  prize bigint not null default 0,
  last jsonb,                          -- the last thing that happened, for the table to show
  seq int not null default 0,          -- bumps on every change
  members uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ld_tables_members_idx on public.ld_tables using gin (members);
alter table public.ld_tables enable row level security;
revoke all on public.ld_tables from anon, authenticated;
grant select on public.ld_tables to authenticated;
drop policy if exists "members see their ludo table" on public.ld_tables;
create policy "members see their ludo table" on public.ld_tables for select to authenticated using (auth.uid() = any (members));
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ld_tables') then
    alter publication supabase_realtime add table public.ld_tables;
  end if;
exception when undefined_object then null; -- no realtime publication (local test database)
end $$;

-- progress per token: -1 yard, 0..50 common track, 51..55 home column, 56 home.
create or replace function public.ld_abs(p_colour int, p_prog int) returns int language sql immutable as $$
  select case when p_prog between 0 and 50 then ((array[0, 13, 26, 39])[p_colour + 1] + p_prog) % 52 else -1 end;
$$;
create or replace function public.ld_safe(p_abs int) returns boolean language sql immutable as $$
  select p_abs = any (array[0, 8, 13, 21, 26, 34, 39, 47]);
$$;

create or replace function public.ld_fee() returns numeric language sql stable security definer set search_path = public as $$
  select least(25, greatest(0, coalesce((public.game_cfg('ludo') ->> 'rake')::numeric, 10))) / 100;
$$;

-- Tokens of seat s that can move d squares.
create or replace function public.ld_movable(t public.ld_tables, s int, d int) returns int[] language sql immutable as $$
  select coalesce(array_agg(i order by i), '{}')
  from generate_series(0, 3) i, lateral (select (t.seats -> s -> 'tokens' ->> i)::int p) x
  where (x.p = -1 and d = 6) or (x.p >= 0 and x.p + d <= 56);
$$;

create or replace function public.ld_save(t public.ld_tables) returns void language sql volatile security definer set search_path = public as $$
  update ld_tables set status = t.status, seats = t.seats, turn = t.turn, phase = t.phase, dice = t.dice, sixes = t.sixes,
    turn_ends = t.turn_ends, winner = t.winner, pot = t.pot, prize = t.prize, last = t.last, members = t.members,
    seq = t.seq + 1, updated_at = now()
  where id = t.id;
$$;

create or replace function public.ld_view(t public.ld_tables) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me int;
begin
  select (i - 1)::int into me from jsonb_array_elements(t.seats) with ordinality x(s, i) where s ->> 'uid' = auth.uid()::text;
  return jsonb_build_object(
    'id', t.id, 'code', t.code, 'entry', t.entry, 'max_players', t.max_players, 'status', t.status,
    'seats', (select coalesce(jsonb_agg(s - 'uid' || jsonb_build_object('me', s ->> 'uid' = auth.uid()::text) order by i), '[]')
              from jsonb_array_elements(t.seats) with ordinality x(s, i)),
    'me', me, 'turn', t.turn, 'phase', t.phase, 'dice', t.dice, 'turn_ends', t.turn_ends, 'winner', t.winner,
    'pot', t.pot, 'prize', t.prize, 'fee', public.ld_fee(), 'last', t.last, 'seq', t.seq, 'server_now', now());
end;
$$;

-- Hand the turn to the next player still at the table.
create or replace function public.ld_next(t public.ld_tables) returns public.ld_tables language plpgsql volatile as $$
declare n int := jsonb_array_length(t.seats); k int;
begin
  for k in 1 .. n loop
    t.turn := (t.turn + 1) % n;
    exit when not coalesce((t.seats -> t.turn ->> 'left')::boolean, false);
  end loop;
  t.phase := 'roll'; t.dice := null; t.sixes := 0;
  t.turn_ends := now() + interval '20 seconds';
  return t;
end;
$$;

-- Pay the winner and close the table.
create or replace function public.ld_finish(t public.ld_tables, w int) returns public.ld_tables language plpgsql volatile security definer set search_path = public as $$
begin
  t.status := 'done'; t.winner := w; t.phase := null; t.turn_ends := null;
  t.prize := floor(t.pot * (1 - public.ld_fee()));
  if t.prize > 0 then
    perform public.wallet_move((t.seats -> w ->> 'uid')::uuid, t.prize, 'win', 'Ludo • Private ' || t.code);
  end if;
  return t;
end;
$$;

-- Move token i of the player to move by the dice; captures, home, bonus roll or next turn.
create or replace function public.ld_move(t public.ld_tables, i int) returns public.ld_tables language plpgsql volatile security definer set search_path = public as $$
declare s int := t.turn; c int := (t.seats -> t.turn ->> 'colour')::int; d int := t.dice;
        from_p int := (t.seats -> t.turn -> 'tokens' ->> i)::int; to_p int; a int; q int; j int; caught jsonb := '[]'; bonus boolean;
begin
  if t.phase <> 'move' or not (i = any (public.ld_movable(t, s, d))) then raise exception 'That token can''t move'; end if;
  to_p := case when from_p = -1 then 0 else from_p + d end;
  t.seats := jsonb_set(t.seats, array[s::text, 'tokens', i::text], to_jsonb(to_p));
  a := public.ld_abs(c, to_p);
  if a >= 0 and not public.ld_safe(a) then
    for q in 0 .. jsonb_array_length(t.seats) - 1 loop
      continue when q = s or coalesce((t.seats -> q ->> 'left')::boolean, false);
      for j in 0 .. 3 loop
        if public.ld_abs((t.seats -> q ->> 'colour')::int, (t.seats -> q -> 'tokens' ->> j)::int) = a then
          t.seats := jsonb_set(t.seats, array[q::text, 'tokens', j::text], '-1');
          caught := caught || jsonb_build_array(jsonb_build_object('seat', q, 'token', j));
        end if;
      end loop;
    end loop;
  end if;
  t.last := jsonb_build_object('kind', 'move', 'seat', s, 'token', i, 'from', from_p, 'to', to_p, 'dice', d, 'caught', caught);
  if (select bool_and(x::int = 56) from jsonb_array_elements_text(t.seats -> s -> 'tokens') x) then
    return public.ld_finish(t, s);
  end if;
  bonus := d = 6 or jsonb_array_length(caught) > 0 or to_p = 56;
  if bonus then
    t.phase := 'roll'; t.dice := null; t.turn_ends := now() + interval '20 seconds';
  else
    t := public.ld_next(t);
  end if;
  return t;
end;
$$;

-- The best move for the player to move: a capture if there is one, otherwise the most advanced token.
create or replace function public.ld_best(t public.ld_tables) returns int language plpgsql stable as $$
declare s int := t.turn; c int := (t.seats -> t.turn ->> 'colour')::int; i int; p int; a int; best int; bestp int := -2; q int; j int;
begin
  foreach i in array public.ld_movable(t, s, t.dice) loop
    p := (t.seats -> s -> 'tokens' ->> i)::int;
    a := public.ld_abs(c, case when p = -1 then 0 else p + t.dice end);
    if a >= 0 and not public.ld_safe(a) then
      for q in 0 .. jsonb_array_length(t.seats) - 1 loop
        continue when q = s or coalesce((t.seats -> q ->> 'left')::boolean, false);
        for j in 0 .. 3 loop
          if public.ld_abs((t.seats -> q ->> 'colour')::int, (t.seats -> q -> 'tokens' ->> j)::int) = a then return i; end if;
        end loop;
      end loop;
    end if;
    if p > bestp then bestp := p; best := i; end if;
  end loop;
  return best;
end;
$$;

-- Roll for the player to move. No move possible or a third 6: the turn passes. A single possible move is made.
create or replace function public.ld_roll(t public.ld_tables) returns public.ld_tables language plpgsql volatile security definer set search_path = public as $$
declare d int := 1 + floor(random() * 6)::int; opts int[];
begin
  if t.phase <> 'roll' then raise exception 'Not time to roll'; end if;
  t.dice := d;
  if d = 6 then t.sixes := t.sixes + 1; end if;
  if t.sixes >= 3 then
    t.last := jsonb_build_object('kind', 'skip', 'seat', t.turn, 'dice', d, 'why', 'three sixes');
    return public.ld_next(t);
  end if;
  opts := public.ld_movable(t, t.turn, d);
  if cardinality(opts) = 0 then
    t.last := jsonb_build_object('kind', 'nomove', 'seat', t.turn, 'dice', d);
    return public.ld_next(t);
  end if;
  t.phase := 'move';
  t.last := jsonb_build_object('kind', 'roll', 'seat', t.turn, 'dice', d);
  t.turn_ends := greatest(t.turn_ends, now() + interval '10 seconds');
  if cardinality(opts) = 1 then return public.ld_move(t, opts[1]); end if;
  return t;
end;
$$;

-- Time ran out for the player to move: the table plays for them.
create or replace function public.ld_auto(t public.ld_tables) returns public.ld_tables language plpgsql volatile security definer set search_path = public as $$
declare s int := t.turn;
begin
  t.seats := jsonb_set(t.seats, array[s::text, 'misses'], to_jsonb(coalesce((t.seats -> s ->> 'misses')::int, 0) + 1));
  if coalesce((t.seats -> s ->> 'left')::boolean, false) then return public.ld_next(t); end if;
  if t.phase = 'roll' then t := public.ld_roll(t); end if;
  if t.status = 'playing' and t.phase = 'move' and t.turn = s then t := public.ld_move(t, public.ld_best(t)); end if;
  return t;
end;
$$;

create or replace function public.ld_code() returns text language plpgsql volatile as $$
declare c text; chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  loop
    c := (select string_agg(substr(chars, 1 + floor(random() * length(chars))::int, 1), '') from generate_series(1, 6));
    exit when not exists (select 1 from ld_tables where code = c);
  end loop;
  return c;
end;
$$;

create or replace function public.ld_seat(me profiles, colour int) returns jsonb language sql stable as $$
  select jsonb_build_object('uid', me.id, 'name', me.name, 'emoji', '🧑🏽', 'colour', colour, 'tokens', '[-1,-1,-1,-1]'::jsonb, 'left', false, 'misses', 0);
$$;

-- Host: create a private table and pay the entry. Returns the invite code.
create or replace function public.ld_create_private(p_entry bigint, p_players int default 4) returns text
language plpgsql volatile security definer set search_path = public as $$
declare me profiles := public.current_profile(); c text := public.ld_code(); t ld_tables;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if p_players not in (2, 4) then raise exception 'A table is for 2 or 4 players'; end if;
  if p_entry < 10 or p_entry > 100000 then raise exception 'Entry between 10 and 1,00,000 coins'; end if;
  insert into ld_tables (code, entry, max_players, seats, members, pot)
    values (c, p_entry, p_players, jsonb_build_array(public.ld_seat(me, 0)), array[me.id], p_entry) returning * into t;
  if public.wallet_move(me.id, -p_entry, 'bet', 'Ludo • Private ' || c || ' • Entry') is null then raise exception 'Not enough coins for the entry'; end if;
  return c;
end;
$$;

-- Join a table by code (or come back to the one you're at). Returns the table id. A full table starts.
create or replace function public.ld_join(p_code text) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare me profiles := public.current_profile(); t ld_tables; n int; colours int[];
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  select * into t from ld_tables where code = upper(trim(p_code)) and status <> 'cancelled' order by created_at desc limit 1 for update;
  if t.id is null then raise exception 'No table with that code'; end if;
  if me.id = any (t.members) then return t.id; end if;
  if t.status <> 'waiting' then raise exception 'This game has already started'; end if;
  n := jsonb_array_length(t.seats);
  if n >= t.max_players then raise exception 'This table is full'; end if;
  if public.wallet_move(me.id, -t.entry, 'bet', 'Ludo • Private ' || t.code || ' • Entry') is null then raise exception 'Not enough coins for the entry'; end if;
  colours := case when t.max_players = 2 then array[0, 2] else array[0, 1, 2, 3] end;
  t.seats := t.seats || jsonb_build_array(public.ld_seat(me, colours[n + 1]));
  t.members := t.members || me.id;
  t.pot := t.pot + t.entry;
  if n + 1 = t.max_players then
    t.status := 'playing';
    t.turn := floor(random() * t.max_players)::int; -- who starts is drawn at random
    t.phase := 'roll'; t.dice := null; t.sixes := 0;
    t.turn_ends := now() + interval '23 seconds';
    t.last := jsonb_build_object('kind', 'start', 'seat', t.turn);
  else
    t.last := jsonb_build_object('kind', 'joined', 'seat', n);
  end if;
  perform public.ld_save(t);
  return t.id;
end;
$$;

-- Roll, or move a token (p_token 0-3), on your turn.
create or replace function public.ld_act(p_table uuid, p_action text, p_token int default null) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare t ld_tables;
begin
  select * into t from ld_tables where id = p_table for update;
  if t.id is null or not (auth.uid() = any (t.members)) then raise exception 'Not your table'; end if;
  if t.status <> 'playing' then raise exception 'The game is not running'; end if;
  if t.seats -> t.turn ->> 'uid' <> auth.uid()::text then raise exception 'Not your turn'; end if;
  t.seats := jsonb_set(t.seats, array[t.turn::text, 'misses'], '0');
  if p_action = 'roll' then t := public.ld_roll(t);
  elsif p_action = 'move' then t := public.ld_move(t, p_token);
  else raise exception 'Unknown action'; end if;
  perform public.ld_save(t);
  return public.ld_view(t);
end;
$$;

-- Anyone at the table: run the clock (a turn that has run out is played for that player) and get the table.
create or replace function public.ld_tick(p_table uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare t ld_tables; guard int := 0;
begin
  select * into t from ld_tables where id = p_table for update;
  if t.id is null or not (auth.uid() = any (t.members)) then raise exception 'Not your table'; end if;
  while t.status = 'playing' and t.turn_ends <= now() and guard < 8 loop
    t := public.ld_auto(t);
    guard := guard + 1;
  end loop;
  if guard > 0 then perform public.ld_save(t); select * into t from ld_tables where id = p_table; end if;
  return public.ld_view(t);
end;
$$;

create or replace function public.ld_state(p_table uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t ld_tables;
begin
  select * into t from ld_tables where id = p_table;
  if t.id is null or not (auth.uid() = any (t.members)) then raise exception 'Not your table'; end if;
  return public.ld_view(t);
end;
$$;

-- Leave: before the start the entry comes back; during a game it is given up (the last one left wins).
create or replace function public.ld_leave(p_table uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare t ld_tables; s int; still int[];
begin
  select * into t from ld_tables where id = p_table for update;
  if t.id is null or not (auth.uid() = any (t.members)) then raise exception 'Not your table'; end if;
  select (i - 1)::int into s from jsonb_array_elements(t.seats) with ordinality x(e, i) where e ->> 'uid' = auth.uid()::text;
  if t.status = 'waiting' then
    perform public.wallet_move(auth.uid(), t.entry, 'refund', 'Ludo • Private ' || t.code || ' • Entry returned');
    t.seats := t.seats - s;
    -- keep colours in join order for the seats that are left
    t.seats := (select coalesce(jsonb_agg(e || jsonb_build_object('colour', (case when t.max_players = 2 then array[0, 2] else array[0, 1, 2, 3] end)[i]) order by i), '[]')
                from jsonb_array_elements(t.seats) with ordinality x(e, i));
    t.members := array_remove(t.members, auth.uid());
    t.pot := t.pot - t.entry;
    if jsonb_array_length(t.seats) = 0 then t.status := 'cancelled'; end if;
    t.last := jsonb_build_object('kind', 'left', 'name', (select name from profiles where id = auth.uid()));
  elsif t.status = 'playing' then
    t.seats := jsonb_set(t.seats, array[s::text, 'left'], 'true');
    t.last := jsonb_build_object('kind', 'left', 'seat', s);
    select array_agg((i - 1)::int) into still from jsonb_array_elements(t.seats) with ordinality x(e, i) where not coalesce((e ->> 'left')::boolean, false);
    if cardinality(still) = 1 then t := public.ld_finish(t, still[1]);
    elsif t.turn = s then t := public.ld_next(t); end if;
  end if;
  perform public.ld_save(t);
  return public.ld_view(t);
end;
$$;

revoke execute on function public.ld_save(public.ld_tables), public.ld_view(public.ld_tables), public.ld_next(public.ld_tables),
  public.ld_finish(public.ld_tables, int), public.ld_move(public.ld_tables, int), public.ld_best(public.ld_tables),
  public.ld_roll(public.ld_tables), public.ld_auto(public.ld_tables), public.ld_seat(public.profiles, int) from public, anon, authenticated;
revoke execute on function public.ld_create_private(bigint, int), public.ld_join(text), public.ld_act(uuid, text, int),
  public.ld_tick(uuid), public.ld_state(uuid), public.ld_leave(uuid) from public, anon;
grant execute on function public.ld_create_private(bigint, int), public.ld_join(text), public.ld_act(uuid, text, int),
  public.ld_tick(uuid), public.ld_state(uuid), public.ld_leave(uuid) to authenticated;
