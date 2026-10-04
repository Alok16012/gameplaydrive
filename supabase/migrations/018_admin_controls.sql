-- 018: Admin controls.
--   • Per-game settings for every game (Super Admin): on/off, min / max bet, platform fee %, turn time
--     (Teen Patti, Rummy), blind limit (Teen Patti) and bot speed (Ludo, Carrom, Chess, Poker). Stored in
--     app_settings.games, changed only through set_game_settings(), every change written to the audit log.
--     The same settings apply to every player — there is no per-player outcome control.
--   • Server-side enforcement: a switched-off game takes no new bets and bets outside min / max are refused
--     (wallet_move for server-run games, game_bet for browser games, table joins for Teen Patti / Rummy).
--   • Daily bet limit per player (set by anyone above them in the hierarchy): total bets per day (India time)
--     can't go over it. Checked on each bet, and on joining a Teen Patti / Rummy table.
--   • Reports, scoped to the caller's own downline: per game, per account under them, and a risk list
--     (players winning far more than they stake).
-- Safe to run more than once. Run after 017. Run it in the Supabase SQL Editor.

alter table public.profiles add column if not exists daily_bet_limit bigint check (daily_bet_limit is null or daily_bet_limit > 0);
create index if not exists ledger_created_idx on public.ledger (created_at);

-- Game id (as the app uses it: "dragon-tiger") from a ledger note's game name ("Dragon Tiger • Round #12").
create or replace function public.game_id_of(g text) returns text language sql immutable as $$
  select replace(lower(trim(g)), ' ', '-');
$$;

-- Refuse a bet if the game is switched off or (when check_size) the bet is outside the admin's min / max.
create or replace function public.game_guard(g text, amount bigint, check_size boolean) returns void
language plpgsql stable security definer set search_path = public as $$
declare id text := public.game_id_of(g); c jsonb := public.game_cfg(public.game_id_of(g)); lo bigint; hi bigint;
begin
  if not coalesce((c ->> 'enabled')::boolean, true) then raise exception '% is closed for maintenance', initcap(replace(id, '-', ' ')); end if;
  if not check_size then return; end if;
  lo := (c ->> 'min_bet')::bigint; hi := (c ->> 'max_bet')::bigint;
  if lo is not null and amount < lo then raise exception 'Minimum bet here is % coins', lo; end if;
  if hi is not null and amount > hi then raise exception 'Maximum bet here is % coins', hi; end if;
end;
$$;

-- Coins a player has bet today (India time).
create or replace function public.bets_today(p_uid uuid) returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(-amount), 0)::bigint from ledger
  where user_id = p_uid and kind = 'bet' and created_at >= (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata');
$$;

-- Coins the player may still bet today (null = no limit).
create or replace function public.bet_room(p_uid uuid) returns bigint language sql stable security definer set search_path = public as $$
  select case when p.daily_bet_limit is null then null else greatest(0, p.daily_bet_limit - public.bets_today(p_uid)) end
  from profiles p where p.id = p_uid;
$$;

create or replace function public.check_bet_room(p_uid uuid, amount bigint) returns void
language plpgsql stable security definer set search_path = public as $$
declare room bigint := public.bet_room(p_uid);
begin
  if room is not null and amount > room then
    raise exception 'Daily bet limit reached (% coins left today)', room;
  end if;
end;
$$;

create or replace function public.wallet_move(p_uid uuid, p_amount bigint, p_kind text, p_note text) returns bigint
language plpgsql security definer set search_path = public as $$
declare bal bigint; g text;
begin
  if p_amount = 0 then select coins into bal from wallets where user_id = p_uid; return bal; end if;
  -- Admin controls on new bets. Teen Patti / Rummy bets inside a running hand are never blocked (they are checked
  -- when the player joins a table); every other game is checked on each bet.
  if p_kind = 'bet' and p_amount < 0 then
    g := public.game_key(p_note);
    if g not in ('teen patti', 'rummy') then
      perform public.game_guard(g, -p_amount, true);
      perform public.check_bet_room(p_uid, -p_amount);
    end if;
  end if;
  update wallets set coins = coins + p_amount, updated_at = now()
    where user_id = p_uid and coins + p_amount >= 0 returning coins into bal;
  if bal is not null then
    insert into ledger (user_id, amount, balance_after, kind, note) values (p_uid, p_amount, bal, p_kind, p_note);
  end if;
  return bal;
end;
$$;

create or replace function public.game_bet(amount bigint, p_note text) returns bigint
language plpgsql security definer set search_path = public as $$
declare me profiles := public.current_profile(); bal bigint; g text := public.game_key(p_note);
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if amount <= 0 or amount > 1000000 then raise exception 'Invalid amount'; end if;
  -- Admin controls: game switched off, bet size limits (on the opening bet of a game) and the player's daily limit.
  perform public.game_guard(g, amount, p_note ~* '•\s*(entry|boot|buy-in)');
  perform public.check_bet_room(me.id, amount);
  update wallets set coins = coins - amount, updated_at = now()
    where user_id = me.id and coins >= amount returning coins into bal;
  if bal is null then raise exception 'Not enough coins'; end if;
  insert into ledger (user_id, amount, balance_after, kind, note) values (me.id, -amount, bal, 'bet', p_note);
  -- A new game closes the last one's unpaid stakes (that game was lost).
  if p_note ~* '•\s*(entry|boot|buy-in)' then
    update game_stakes set settled = true where user_id = me.id and game = g and not settled;
  end if;
  insert into game_stakes (user_id, game, amount) values (me.id, g, amount);
  return bal;
end;
$$;

-- Browser-game payout caps follow the platform fee the admin sets, so never above these ceilings.
create or replace function public.game_max_mult(g text) returns numeric language sql immutable as $$
  select case g when 'ludo' then 4 when 'carrom' then 2 when 'chess' then 2 when 'poker' then 6 when 'teen patti' then 6 else 2 end;
$$;

create or replace function public.tp_join(p_boot bigint, p_code text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  t tp_tables;
  who jsonb;
  emo text;
begin
  if me.id is null or me.role <> 'player' then raise exception 'Only active players can join tables'; end if;
  perform pg_advisory_xact_lock(hashtext('table-join:' || me.id::text));
  if not coalesce((public.game_cfg('teen-patti') ->> 'enabled')::boolean, true) then raise exception 'Teen Patti is closed for maintenance'; end if;
  if p_code is not null then
    select * into t from tp_tables where code = upper(trim(p_code)) for update;
    if not found then raise exception 'No table with that code'; end if;
    p_boot := t.boot;
  elsif p_boot not in (10, 25, 50, 100, 200, 500, 1000) then
    raise exception 'Invalid boot';
  end if;
  if (select coins from wallets where user_id = me.id) < p_boot then raise exception 'Not enough coins'; end if;
  perform public.check_bet_room(me.id, p_boot);

  -- Rejoin a table you're still at.
  select * into t from tp_tables where me.id = any (members) and boot = p_boot and (p_code is null and code is null or code = upper(trim(p_code))) limit 1 for update;
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

  if p_code is not null then
    select * into t from tp_tables where code = upper(trim(p_code)) for update;
    if (select count(*) from jsonb_array_elements(t.seats) v where not coalesce((v ->> 'left')::boolean, false)) + jsonb_array_length(t.queue) >= 6 then
      raise exception 'This table is full';
    end if;
  else
    select * into t from tp_tables tt
      where tt.boot = p_boot and tt.code is null
        and (select count(*) from jsonb_array_elements(tt.seats) v where not (v ->> 'bot')::boolean and not coalesce((v ->> 'left')::boolean, false))
            + jsonb_array_length(tt.queue) < 6
        and tt.updated_at > now() - interval '5 minutes'
      order by (select count(*) from jsonb_array_elements(tt.seats) v where not (v ->> 'bot')::boolean and not coalesce((v ->> 'left')::boolean, false)) desc
      limit 1 for update skip locked;
    if not found then
      insert into tp_tables (boot, queue, members, next_hand_at) values (p_boot, jsonb_build_array(who), array[me.id], now() + interval '3 seconds')
        returning * into t;
      return t.id;
    end if;
  end if;
  t.queue := t.queue || jsonb_build_array(who);
  if t.status = 'waiting' then t.next_hand_at := now() + interval '3 seconds'; end if;
  perform public.tp_save(t);
  return t.id;
end;
$$;

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
  perform public.check_bet_room(me.id, need);

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

-- Super Admin: change one game's settings. Only the keys sent are changed; null / "" clears a limit.
create or replace function public.set_game_settings(p_game text, p_cfg jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare old jsonb := public.game_cfg(p_game); new jsonb := public.game_cfg(p_game); k text; v jsonb; n numeric;
        games text[] := array['teen-patti','rummy','andar-bahar','dragon-tiger','lucky-7','aviator','roulette','plinko','blackjack','poker','ludo','carrom','chess'];
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
      if p_game not in ('ludo', 'carrom', 'chess', 'poker') then continue; end if;
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

-- Daily bet limit for an account below you (null clears it).
create or replace function public.set_daily_limit(target uuid, p_limit bigint) returns void
language plpgsql security definer set search_path = public as $$
declare old bigint; who text;
begin
  if not public.can_manage(target) then raise exception 'Not allowed'; end if;
  if p_limit is not null and p_limit < 1 then raise exception 'Limit must be at least 1 coin'; end if;
  select daily_bet_limit, initcap(role::text) || ' ' || code into old, who from profiles where id = target;
  update profiles set daily_bet_limit = p_limit where id = target;
  perform public.write_audit(who || ' • daily bet limit', coalesce(old::text, 'none'), coalesce(p_limit::text, 'none'));
end;
$$;

-- Ledger rows of the caller's downline (players only) in the last p_days days.
create or replace function public.report_rows(p_days int) returns table (user_id uuid, game text, kind text, amount bigint, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select l.user_id, public.game_id_of(public.game_key(l.note)), l.kind, l.amount, l.created_at
  from ledger l join profiles p on p.id = l.user_id
  where l.created_at > now() - make_interval(days => greatest(1, least(p_days, 90)))
    and l.kind in ('bet', 'win', 'refund') and p.role = 'player'
    and exists (select 1 from profiles me where me.id = auth.uid() and me.status = 'active' and me.role <> 'player'
                and (me.role = 'superadmin' or public.is_ancestor(me.id, p.id)));
$$;

-- Per game: coins bet, paid back, platform net (bets − payouts), players, bets placed.
create or replace function public.admin_game_report(p_days int default 1) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(row_to_json(z) order by z.bets desc), '[]') from (
    select game, sum(-amount) filter (where kind = 'bet')::bigint as bets,
           coalesce(sum(amount) filter (where kind in ('win', 'refund')), 0)::bigint as payouts,
           (coalesce(sum(-amount) filter (where kind = 'bet'), 0) - coalesce(sum(amount) filter (where kind in ('win', 'refund')), 0))::bigint as net,
           count(distinct user_id) as players, count(*) filter (where kind = 'bet') as bet_count
    from public.report_rows(p_days) where game <> '' group by game) z;
$$;

-- Per account directly under the caller (or under p_parent, if the caller manages it): totals for their players.
create or replace function public.admin_network_report(p_days int default 1, p_parent uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare root uuid := coalesce(p_parent, auth.uid());
begin
  if p_parent is not null and not public.can_manage(p_parent) then raise exception 'Not allowed'; end if;
  return (select coalesce(jsonb_agg(row_to_json(z) order by z.bets desc), '[]') from (
    select c.id, c.code, c.name, c.role::text as role,
           coalesce(sum(-r.amount) filter (where r.kind = 'bet'), 0)::bigint as bets,
           coalesce(sum(r.amount) filter (where r.kind in ('win', 'refund')), 0)::bigint as payouts,
           (coalesce(sum(-r.amount) filter (where r.kind = 'bet'), 0) - coalesce(sum(r.amount) filter (where r.kind in ('win', 'refund')), 0))::bigint as net,
           count(distinct r.user_id) as players
    from profiles c
    left join public.report_rows(p_days) r on r.user_id = c.id or public.is_ancestor(c.id, r.user_id)
    where c.parent_id = root
    group by c.id, c.code, c.name, c.role) z);
end;
$$;

-- Players in the caller's downline who won much more than they staked (worth a look), plus their limits.
create or replace function public.admin_risk_report(p_days int default 1) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(row_to_json(z) order by z.net_won desc), '[]') from (
    select p.id, p.code, p.name, p.status, p.daily_bet_limit,
           sum(-r.amount) filter (where r.kind = 'bet')::bigint as staked,
           coalesce(sum(r.amount) filter (where r.kind in ('win', 'refund')), 0)::bigint as paid,
           (coalesce(sum(r.amount) filter (where r.kind in ('win', 'refund')), 0) - coalesce(sum(-r.amount) filter (where r.kind = 'bet'), 0))::bigint as net_won,
           count(*) filter (where r.kind = 'bet') as bet_count
    from public.report_rows(p_days) r join profiles p on p.id = r.user_id
    group by p.id, p.code, p.name, p.status, p.daily_bet_limit
    having coalesce(sum(r.amount) filter (where r.kind in ('win', 'refund')), 0) - coalesce(sum(-r.amount) filter (where r.kind = 'bet'), 0) > 0
       and (count(*) filter (where r.kind = 'bet') >= 20
            or coalesce(sum(r.amount) filter (where r.kind in ('win', 'refund')), 0) > 2 * greatest(1, coalesce(sum(-r.amount) filter (where r.kind = 'bet'), 0)))
    order by net_won desc limit 50) z;
$$;

revoke execute on function public.game_id_of(text), public.game_guard(text, bigint, boolean), public.bets_today(uuid),
  public.check_bet_room(uuid, bigint), public.report_rows(int), public.game_max_mult(text) from public, anon, authenticated;
revoke execute on function public.bet_room(uuid) from public, anon, authenticated;
grant execute on function public.bet_room(uuid) to service_role;
revoke execute on function public.wallet_move(uuid, bigint, text, text), public.tp_join(bigint, text), public.rm_join(text, bigint, int, text, int),
  public.game_bet(bigint, text) from public, anon;
revoke execute on function public.wallet_move(uuid, bigint, text, text) from authenticated;
grant execute on function public.tp_join(bigint, text), public.rm_join(text, bigint, int, text, int), public.game_bet(bigint, text) to authenticated;
revoke execute on function public.set_game_settings(text, jsonb), public.set_daily_limit(uuid, bigint), public.admin_game_report(int),
  public.admin_network_report(int, uuid), public.admin_risk_report(int) from public, anon;
grant execute on function public.set_game_settings(text, jsonb), public.set_daily_limit(uuid, bigint), public.admin_game_report(int),
  public.admin_network_report(int, uuid), public.admin_risk_report(int) to authenticated;
