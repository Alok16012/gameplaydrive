-- GameHub: full database setup for a NEW, empty Supabase project (migrations 001-004 combined).
-- Paste into Supabase → SQL Editor → New query → Run. Projects already set up: run only the migrations you're missing.

-- GameHub schema: account hierarchy, virtual-coin wallets, ledger, bots, audit log.
-- Run once in Supabase → SQL Editor. Safe to re-run only on an empty project.
--
-- Roles: superadmin → admin → agent → player. Every account (except the super admin) has the parent that
-- created it. Row-level security lets an account see itself and its downline only; all writes go through the
-- functions below (or the server API for creating logins), never straight into the tables.

create type public.app_role as enum ('superadmin', 'admin', 'agent', 'player');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  code text not null unique,
  role public.app_role not null,
  name text not null check (length(trim(name)) > 0),
  phone text unique check (phone ~ '^[0-9]{10}$'),
  username text unique check (username ~ '^[a-z0-9._]{3,}$'),
  parent_id uuid references public.profiles (id),
  status text not null default 'active' check (status in ('active', 'frozen')),
  state text,
  created_at timestamptz not null default now(),
  check ((role = 'superadmin') = (parent_id is null)),
  check (role = 'player' or username is not null),
  check (role <> 'player' or phone is not null)
);
create index profiles_parent_idx on public.profiles (parent_id);

create table public.wallets (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  coins bigint not null default 0 check (coins >= 0),
  updated_at timestamptz not null default now()
);

create table public.ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  amount bigint not null,
  balance_after bigint not null,
  kind text not null check (kind in ('mint', 'burn', 'transfer_in', 'transfer_out', 'bet', 'win', 'refund')),
  note text,
  counterparty uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index ledger_user_idx on public.ledger (user_id, created_at desc);

create table public.bots (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  emoji text not null,
  bal bigint not null default 1000,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.app_settings (
  key text primary key,
  value jsonb not null
);
insert into public.app_settings (key, value) values ('bots_auto', 'true');

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles (id) on delete set null,
  actor_name text,
  action text not null,
  before text,
  after text,
  created_at timestamptz not null default now()
);
create index audit_created_idx on public.audit_log (created_at desc);

-- ---------------------------------------------------------------- helpers

-- True when `anc` is above `target` in the hierarchy (any depth).
create function public.is_ancestor(anc uuid, target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  with recursive up as (
    select id, parent_id from profiles where id = target
    union all
    select p.id, p.parent_id from profiles p join up on p.id = up.parent_id
  )
  select exists (select 1 from up where parent_id = anc);
$$;

-- The signed-in account, only while active.
create function public.current_profile() returns public.profiles
language sql stable security definer set search_path = public as $$
  select * from profiles where id = auth.uid() and status = 'active';
$$;

-- Can the signed-in account manage `target`? Super admin: everyone else. Others: their downline.
create function public.can_manage(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select target <> auth.uid() and exists (
    select 1 from profiles me
    where me.id = auth.uid() and me.status = 'active'
      and (me.role = 'superadmin' or public.is_ancestor(me.id, target))
  );
$$;

create function public.is_superadmin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'superadmin' and status = 'active');
$$;

create function public.write_audit(p_action text, p_before text, p_after text) returns void
language sql security definer set search_path = public as $$
  insert into audit_log (actor_id, actor_name, action, before, after)
  select auth.uid(), coalesce((select coalesce(username, name) from profiles where id = auth.uid()), 'system'), p_action, p_before, p_after;
$$;

-- ---------------------------------------------------------------- row-level security

alter table public.profiles enable row level security;
alter table public.wallets enable row level security;
alter table public.ledger enable row level security;
alter table public.bots enable row level security;
alter table public.app_settings enable row level security;
alter table public.audit_log enable row level security;

create policy "see self and downline" on public.profiles for select to authenticated
  using (id = auth.uid() or public.can_manage(id));
create policy "see own and downline wallets" on public.wallets for select to authenticated
  using (user_id = auth.uid() or public.can_manage(user_id));
create policy "see own and downline ledger" on public.ledger for select to authenticated
  using (user_id = auth.uid() or public.can_manage(user_id));
create policy "anyone signed in reads bots" on public.bots for select to authenticated using (true);
create policy "super admin manages bots" on public.bots for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());
create policy "anyone signed in reads settings" on public.app_settings for select to authenticated using (true);
create policy "super admin updates settings" on public.app_settings for update to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());
create policy "see own and downline audit" on public.audit_log for select to authenticated
  using (public.is_superadmin() or actor_id = auth.uid() or public.can_manage(actor_id));

-- ---------------------------------------------------------------- account management

-- Called only by the server API (service role) after it has created the auth login.
-- Validates the hierarchy rules: superadmin → admin/agent/player, admin → agent/player, agent → player,
-- and the parent must be the creator or someone in the creator's downline ranked above the new role.
create function public.create_profile(
  p_id uuid, p_actor uuid, p_role public.app_role, p_name text, p_phone text, p_username text, p_parent uuid, p_state text
) returns public.profiles
language plpgsql security definer set search_path = public as $$
declare
  actor profiles;
  parent profiles;
  rank_of jsonb := '{"superadmin":0,"admin":1,"agent":2,"player":3}';
  prefix text := case p_role when 'admin' then 'ADM-' when 'agent' then 'AGT-' else 'GH' end;
  digits int := case p_role when 'player' then 6 else 4 end;
  new_code text;
  result profiles;
begin
  select * into actor from profiles where id = p_actor and status = 'active';
  if actor.id is null then raise exception 'Your account is not active'; end if;
  if (rank_of ->> actor.role::text)::int >= (rank_of ->> p_role::text)::int then
    raise exception '% accounts cannot create % accounts', initcap(actor.role::text), p_role;
  end if;
  select * into parent from profiles where id = coalesce(p_parent, p_actor) and status = 'active';
  if parent.id is null then raise exception 'Owner account not found or frozen'; end if;
  if parent.id <> actor.id and actor.role <> 'superadmin' and not public.is_ancestor(actor.id, parent.id) then
    raise exception 'Owner must be you or someone in your network';
  end if;
  if (rank_of ->> parent.role::text)::int >= (rank_of ->> p_role::text)::int then
    raise exception '% accounts cannot own % accounts', initcap(parent.role::text), p_role;
  end if;
  loop
    new_code := prefix || lpad((floor(random() * power(10, digits)))::int::text, digits, '0');
    exit when not exists (select 1 from profiles where code = new_code);
  end loop;
  insert into profiles (id, code, role, name, phone, username, parent_id, state)
    values (p_id, new_code, p_role, trim(p_name), p_phone, lower(p_username), parent.id, p_state)
    returning * into result;
  insert into wallets (user_id) values (p_id);
  insert into audit_log (actor_id, actor_name, action, before, after)
    values (actor.id, coalesce(actor.username, actor.name), initcap(p_role::text) || ' ' || new_code || ' created under ' || parent.name, '—', trim(p_name));
  return result;
end;
$$;

create function public.set_account_status(target uuid, new_status text) returns void
language plpgsql security definer set search_path = public as $$
declare old text; who text;
begin
  if new_status not in ('active', 'frozen') then raise exception 'Invalid status'; end if;
  if not public.can_manage(target) then raise exception 'Not allowed'; end if;
  select status, initcap(role::text) || ' ' || code into old, who from profiles where id = target;
  update profiles set status = new_status where id = target;
  perform public.write_audit(who, old, new_status);
end;
$$;

-- ---------------------------------------------------------------- coins

-- Positive amount: give coins to `target`; negative: take coins back.
-- Super admin creates (mints) and removes (burns) coins; admins and agents move them from/to their own wallet.
create function public.transfer_coins(target uuid, amount bigint, p_note text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  t profiles;
  mine bigint;
  theirs bigint;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if amount = 0 then raise exception 'Amount must not be zero'; end if;
  if not public.can_manage(target) then raise exception 'Not allowed'; end if;
  select * into t from profiles where id = target;
  -- Lock both wallets in a fixed order so concurrent transfers can't deadlock.
  perform 1 from wallets where user_id in (me.id, target) order by user_id for update;
  select coins into theirs from wallets where user_id = target;
  if amount < 0 and theirs < -amount then raise exception 'They only have % coins', theirs; end if;

  if me.role <> 'superadmin' then
    select coins into mine from wallets where user_id = me.id;
    if amount > 0 and mine < amount then raise exception 'You only have % coins', mine; end if;
    update wallets set coins = coins - amount, updated_at = now() where user_id = me.id returning coins into mine;
    insert into ledger (user_id, amount, balance_after, kind, note, counterparty)
      values (me.id, -amount, mine, case when amount > 0 then 'transfer_out' else 'transfer_in' end,
              coalesce(p_note, case when amount > 0 then 'Sent to ' || t.name else 'Taken back from ' || t.name end), target);
  end if;

  update wallets set coins = coins + amount, updated_at = now() where user_id = target returning coins into theirs;
  insert into ledger (user_id, amount, balance_after, kind, note, counterparty)
    values (target, amount, theirs,
            case when me.role = 'superadmin' then (case when amount > 0 then 'mint' else 'burn' end)
                 else (case when amount > 0 then 'transfer_in' else 'transfer_out' end) end,
            coalesce(p_note, case when amount > 0 then 'Coins from ' || me.name else 'Coins taken back by ' || me.name end), me.id);
  perform public.write_audit(case when amount > 0 then 'Coins to ' else 'Coins from ' end || t.code || ' (' || t.name || ')',
                             (theirs - amount)::text, theirs::text);
  return theirs;
end;
$$;

-- Games: stake coins. Returns the new balance.
create function public.game_bet(amount bigint, p_note text) returns bigint
language plpgsql security definer set search_path = public as $$
declare me profiles := public.current_profile(); bal bigint;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if amount <= 0 then raise exception 'Invalid amount'; end if;
  update wallets set coins = coins - amount, updated_at = now()
    where user_id = me.id and coins >= amount returning coins into bal;
  if bal is null then raise exception 'Not enough coins'; end if;
  insert into ledger (user_id, amount, balance_after, kind, note) values (me.id, -amount, bal, 'bet', p_note);
  return bal;
end;
$$;

-- Games: pay out winnings or refunds. Interim guard until games run on the server: payouts in the last
-- 30 minutes can't exceed 100× the coins staked in that window.
create function public.game_payout(amount bigint, p_note text, p_kind text default 'win') returns bigint
language plpgsql security definer set search_path = public as $$
declare me profiles := public.current_profile(); bal bigint; staked bigint; paid bigint;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if amount <= 0 or p_kind not in ('win', 'refund') then raise exception 'Invalid payout'; end if;
  select coalesce(sum(-l.amount) filter (where l.kind = 'bet'), 0), coalesce(sum(l.amount) filter (where l.kind in ('win', 'refund')), 0)
    into staked, paid
    from ledger l where l.user_id = me.id and l.created_at > now() - interval '30 minutes';
  if paid + amount > staked * 100 then raise exception 'Payout rejected'; end if;
  update wallets set coins = coins + amount, updated_at = now() where user_id = me.id returning coins into bal;
  insert into ledger (user_id, amount, balance_after, kind, note) values (me.id, amount, bal, p_kind, p_note);
  return bal;
end;
$$;

-- Admin console actions that don't change data here (config edits, bot changes) still get audited.
create function public.log_action(p_action text, p_before text, p_after text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from profiles where id = auth.uid() and role <> 'player' and status = 'active') then
    raise exception 'Not allowed';
  end if;
  perform public.write_audit(p_action, p_before, p_after);
end;
$$;

-- Lock down: nothing is callable without signing in, and the internal helpers aren't callable from the browser.
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
revoke execute on function public.create_profile(uuid, uuid, public.app_role, text, text, text, uuid, text) from authenticated;
revoke execute on function public.write_audit(text, text, text) from authenticated;


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


-- GameHub: production Teen Patti + 13 Card Rummy on the game server (run after 001 and 002).
--
-- Adds
--   • Game settings the Super Admin controls (enabled, platform fee %, turn time) — read by the server.
--   • Teen Patti: side show, private tables (invite code, friends only, no bots), settings-driven fee/timer.
--   • 13 Card Rummy on the server: Points, Pool 101, Pool 201 and Deals (best of 2/3). The server deals from two
--     decks, runs the 30 s turn clock, validates every declaration, scores losing hands (the better of the
--     player's own arrangement and the server's best grouping), plays honest bots (a bot can only declare a
--     hand that really is valid) and settles coins.
--   • Lobby counts of real players per table type.

-- ---------------------------------------------------------------- game settings

insert into public.app_settings (key, value) values
  ('games', '{"teen-patti": {"enabled": true, "rake": 5, "turn": 15}, "rummy": {"enabled": true, "rake": 10, "turn": 30}}')
on conflict (key) do nothing;

create function public.game_cfg(p_game text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select value -> p_game from app_settings where key = 'games'), '{}');
$$;

create function public.set_game_config(p_game text, p_enabled boolean, p_rake numeric, p_turn int) returns void
language plpgsql security definer set search_path = public as $$
declare old jsonb := public.game_cfg(p_game);
begin
  if not public.is_superadmin() then raise exception 'Only the Super Admin can change game settings'; end if;
  if p_game not in ('teen-patti', 'rummy') then raise exception 'Unknown game'; end if;
  if p_rake < 0 or p_rake > 25 then raise exception 'Platform fee must be between 0 and 25%%'; end if;
  if p_turn < 10 or p_turn > 90 then raise exception 'Turn time must be between 10 and 90 seconds'; end if;
  update app_settings set value = jsonb_set(value, array[p_game], jsonb_build_object('enabled', p_enabled, 'rake', p_rake, 'turn', p_turn))
    where key = 'games';
  perform public.write_audit('Game settings • ' || p_game, old::text,
    jsonb_build_object('enabled', p_enabled, 'rake', p_rake, 'turn', p_turn)::text);
end;
$$;

create function public.new_code() returns text language sql volatile as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '') from generate_series(1, 6);
$$;

-- ---------------------------------------------------------------- Teen Patti: schema additions

alter table public.tp_tables add column code text unique;
alter table public.tp_tables add column pending jsonb;        -- side show waiting for an answer: {from, to, ends, bot_at}
alter table public.tp_tables add column last_sideshow jsonb;  -- {from, to, loser, hand_no}; cards only shown to those two

-- ---------------------------------------------------------------- Teen Patti: engine (replaces 002 versions)

create or replace function public.tp_set_turn(t public.tp_tables, seat int) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare r float := random(); secs int := coalesce((public.game_cfg('teen-patti') ->> 'turn')::int, 15); delay float;
begin
  t.turn := seat;
  t.turn_ends := now() + make_interval(secs => secs);
  if (t.seats -> seat ->> 'bot')::boolean then
    delay := case when r < 0.3 then 0.8 + random() * 1.7 when r < 0.72 then 3 + random() * 4 when r < 0.95 then least(7.5 + random() * 5, secs - 1) else secs end;
    t.bot_acts_at := now() + make_interval(secs => delay);
  else
    t.bot_acts_at := null;
  end if;
  return t;
end;
$$;

-- Deal a new hand: seats change (leavers go, queued players sit down, bots fill public tables to 6), boots collected.
create or replace function public.tp_start_hand(t public.tp_tables) returns public.tp_tables
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
      s := s || jsonb_build_array(public.make_bot(names));
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
$$;

create or replace function public.tp_finish(t public.tp_tables, winner int, reason text, showdown boolean) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  w jsonb := t.seats -> winner;
  rake numeric := coalesce((public.game_cfg('teen-patti') ->> 'rake')::numeric, 5);
  payout bigint := floor(t.pot * (1 - rake / 100.0));
  bal bigint; reveal jsonb := '[]'; h record; hand text;
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
                                 'amount', payout, 'reason', coalesce(hand, reason), 'reveal', reveal, 'pot', t.pot, 'rake', rake);
  t.status := 'done';
  t.turn := null;
  t.turn_ends := null;
  t.bot_acts_at := null;
  t.pending := null;
  t.next_hand_at := now() + interval '8 seconds';
  return t;
end;
$$;

-- Put coins into the pot for a seat (bot: its table balance; player: their wallet).
create function public.tp_pay(t public.tp_tables, seat int, amt bigint) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare x jsonb := t.seats -> seat; bal bigint;
begin
  if (x ->> 'bot')::boolean then
    t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('bal', (x ->> 'bal')::bigint - amt));
  else
    bal := public.wallet_move((x ->> 'uid')::uuid, -amt, 'bet', 'Teen Patti • Hand #' || t.hand_no);
    if bal is null then raise exception 'Not enough coins'; end if;
    t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('bal', bal));
  end if;
  t.pot := t.pot + amt;
  return t;
end;
$$;

-- Next seat to act after `seat` (bumps the round when play wraps around).
create function public.tp_pass(t public.tp_tables, seat int) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare active int[] := public.tp_active(t.seats); n int := jsonb_array_length(t.seats); nxt int := seat;
begin
  if array_length(active, 1) = 1 then return public.tp_finish(t, active[1], 'Everyone else packed', false); end if;
  if t.pot >= t.boot * 60 then return public.tp_showdown(t); end if; -- pot limit: automatic show
  loop
    nxt := (nxt + 1) % n;
    if nxt <= seat and nxt = active[1] then t.round := t.round + 1; end if;
    exit when nxt = any (active);
  end loop;
  return public.tp_set_turn(t, nxt);
end;
$$;

create or replace function public.tp_apply(t public.tp_tables, seat int, action text) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare seen boolean := (t.seats -> seat ->> 'seen')::boolean; amt bigint;
begin
  if action in ('pack', 'timeout') then
    t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('packed', true, 'action', case action when 'pack' then 'Pack' else 'Timed out' end));
  else
    if action = 'raise' then t.stake := t.stake * 2; end if;
    amt := case when seen then t.stake * 2 else t.stake end;
    t := public.tp_pay(t, seat, amt);
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

-- Previous active player before `seat` (the side-show partner).
create function public.tp_prev_active(t public.tp_tables, seat int) returns int
language plpgsql immutable as $$
declare active int[] := public.tp_active(t.seats); n int := jsonb_array_length(t.seats); p int := seat;
begin
  loop
    p := (p - 1 + n) % n;
    if p = seat then return null; end if;
    if p = any (active) then return p; end if;
  end loop;
end;
$$;

-- Side show: a Seen player pays a chaal and asks the previous (Seen) player to compare privately.
create function public.tp_request_sideshow(t public.tp_tables, seat int) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare prev int := public.tp_prev_active(t, seat);
begin
  if not (t.seats -> seat ->> 'seen')::boolean then raise exception 'See your cards before asking for a side show'; end if;
  if array_length(public.tp_active(t.seats), 1) < 3 then raise exception 'Side show needs three or more players; use Show'; end if;
  if prev is null or not (t.seats -> prev ->> 'seen')::boolean then raise exception 'The previous player must be Seen for a side show'; end if;
  t := public.tp_pay(t, seat, t.stake * 2);
  t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('action', 'Side show?'));
  t.pending := jsonb_build_object('from', seat, 'to', prev, 'ends', now() + interval '10 seconds',
    'bot_at', case when (t.seats -> prev ->> 'bot')::boolean then now() + make_interval(secs => 1.5 + random() * 3) end);
  t.turn_ends := now() + interval '10 seconds';
  t.bot_acts_at := null;
  return t;
end;
$$;

create function public.tp_resolve_sideshow(t public.tp_tables, accept boolean) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare f int := (t.pending ->> 'from')::int; o int := (t.pending ->> 'to')::int; a int[]; b int[]; loser int;
begin
  t.pending := null;
  if accept then
    select public.tp_score(cards) into a from tp_hands where table_id = t.id and seat = f;
    select public.tp_score(cards) into b from tp_hands where table_id = t.id and seat = o;
    loser := case when a > b then o else f end; -- ties go against the player who asked
    t.seats := public.tp_seat_set(t.seats, loser, '{"packed": true, "action": "Lost side show"}');
    t.seats := public.tp_seat_set(t.seats, case when loser = f then o else f end, '{"action": "Won side show"}');
    t.last_sideshow := jsonb_build_object('from', f, 'to', o, 'loser', loser, 'hand_no', t.hand_no);
  else
    t.seats := public.tp_seat_set(t.seats, o, '{"action": "Declined"}');
  end if;
  return public.tp_pass(t, f);
end;
$$;

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

create or replace function public.tp_advance(t public.tp_tables) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare steps int := 0; sc int[];
begin
  loop
    steps := steps + 1;
    exit when steps > 12;
    if t.status in ('waiting', 'done') and t.next_hand_at is not null and t.next_hand_at <= now() then
      t := public.tp_start_hand(t);
    elsif t.status = 'playing' and t.pending is not null then
      if (t.pending ->> 'bot_at') is not null and (t.pending ->> 'bot_at')::timestamptz <= now() then
        select public.tp_score(cards) into sc from tp_hands where table_id = t.id and seat = (t.pending ->> 'to')::int;
        t := public.tp_resolve_sideshow(t, sc[1] >= 2 or random() < 0.5);
      elsif (t.pending ->> 'ends')::timestamptz <= now() then
        t := public.tp_resolve_sideshow(t, false); -- no answer in time: declined
      else
        exit;
      end if;
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

create or replace function public.tp_save(t public.tp_tables) returns void
language sql security definer set search_path = public as $$
  update tp_tables set status = t.status, hand_no = t.hand_no, pot = t.pot, stake = t.stake, round = t.round, turn = t.turn,
    turn_ends = t.turn_ends, bot_acts_at = t.bot_acts_at, next_hand_at = t.next_hand_at, result = t.result, seats = t.seats,
    queue = t.queue, members = public.tp_members(t.seats, t.queue), pending = t.pending, last_sideshow = t.last_sideshow, updated_at = now()
  where id = t.id;
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
    'server_now', now());
end;
$$;

drop function public.tp_join(bigint);

-- Sit down at a public table for this boot, or at a private table by invite code (rejoins if still seated).
create function public.tp_join(p_boot bigint, p_code text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  t tp_tables;
  who jsonb;
  emo text;
begin
  if me.id is null or me.role <> 'player' then raise exception 'Only active players can join tables'; end if;
  if not coalesce((public.game_cfg('teen-patti') ->> 'enabled')::boolean, true) then raise exception 'Teen Patti is closed for maintenance'; end if;
  if p_code is not null then
    select * into t from tp_tables where code = upper(trim(p_code)) for update;
    if not found then raise exception 'No table with that code'; end if;
    p_boot := t.boot;
  elsif p_boot not in (10, 25, 50, 100, 200, 500, 1000) then
    raise exception 'Invalid boot';
  end if;
  if (select coins from wallets where user_id = me.id) < p_boot then raise exception 'Not enough coins'; end if;

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

-- Create a private Teen Patti table and get its invite code. Friends only: no bots; a hand needs 2+ players.
create function public.tp_create_private(p_boot bigint) returns text
language plpgsql security definer set search_path = public as $$
declare me profiles := public.current_profile(); c text;
begin
  if me.id is null or me.role <> 'player' then raise exception 'Only active players can create tables'; end if;
  if p_boot not in (10, 25, 50, 100, 200, 500, 1000) then raise exception 'Invalid boot'; end if;
  loop
    c := public.new_code();
    exit when not exists (select 1 from tp_tables where code = c) and not exists (select 1 from rm_tables where code = c);
  end loop;
  insert into tp_tables (boot, code) values (p_boot, c);
  perform public.tp_join(p_boot, c);
  return c;
end;
$$;

create or replace function public.tp_act(p_table uuid, p_action text) returns jsonb
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
  elsif p_action in ('accept', 'decline') then
    if t.pending is null or (t.pending ->> 'to')::int <> me then raise exception 'No side show to answer'; end if;
    t := public.tp_resolve_sideshow(t, p_action = 'accept');
    t := public.tp_advance(t);
  else
    if t.pending is not null then raise exception 'Waiting for the side show answer'; end if;
    if t.turn <> me then raise exception 'Not your turn'; end if;
    active := public.tp_active(t.seats);
    if p_action = 'show' and array_length(active, 1) <> 2 then raise exception 'Show is only allowed when two players are left'; end if;
    if p_action = 'sideshow' then
      t := public.tp_request_sideshow(t, me);
    elsif p_action in ('pack', 'chaal', 'raise', 'show') then
      t := public.tp_apply(t, me, p_action);
    else
      raise exception 'Unknown action';
    end if;
    t := public.tp_advance(t);
  end if;
  perform public.tp_save(t);
  return public.tp_view(t);
end;
$$;

create or replace function public.tp_leave(p_table uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t tp_tables; me int;
begin
  select * into t from tp_tables where id = p_table and auth.uid() = any (members) for update;
  if not found then return; end if;
  t.queue := (select coalesce(jsonb_agg(q), '[]') from jsonb_array_elements(t.queue) q where q ->> 'uid' <> auth.uid()::text);
  select i - 1 into me from jsonb_array_elements(t.seats) with ordinality x(v, i) where v ->> 'uid' = auth.uid()::text;
  if me is not null then
    if t.status = 'playing' and (t.seats -> me ->> 'playing')::boolean and not (t.seats -> me ->> 'packed')::boolean then
      if t.pending is not null and me in ((t.pending ->> 'from')::int, (t.pending ->> 'to')::int) then t := public.tp_resolve_sideshow(t, false); end if;
      if t.status = 'playing' and not (t.seats -> me ->> 'packed')::boolean then
        if t.turn = me then t := public.tp_apply(t, me, 'pack');
        else
          t.seats := public.tp_seat_set(t.seats, me, '{"packed": true, "action": "Left"}');
          if array_length(public.tp_active(t.seats), 1) = 1 then t := public.tp_finish(t, (public.tp_active(t.seats))[1], 'Everyone else packed', false); end if;
        end if;
      end if;
    end if;
    t.seats := public.tp_seat_set(t.seats, me, '{"left": true}');
  end if;
  perform public.tp_save(t);
end;
$$;

-- ---------------------------------------------------------------- Rummy: cards and rules

create function public.rm_low(r text) returns int language sql immutable as $$
  select case r when 'A' then 1 when 'K' then 13 when 'Q' then 12 when 'J' then 11 else r::int end;
$$;

create function public.rm_pts(c jsonb, wild text) returns int language sql immutable as $$
  select case when c ->> 'r' = wild then 0 when c ->> 'r' in ('A','K','Q','J','10') then 10 else public.rm_low(c ->> 'r') end;
$$;

create function public.rm_consec(v int[]) returns boolean language sql immutable as $$
  select coalesce(bool_and(d = 1), true) from (select x - lag(x) over (order by x) d from unnest(v) x) z where d is not null;
$$;

-- Same rules as app/lib/rummyRules.ts classify().
create function public.rm_classify(g jsonb, wild text) returns text
language plpgsql immutable as $$
declare n int := jsonb_array_length(g); nat int; jokers int; lo int[]; hi int[]; v int[]; ace_high boolean;
begin
  if n < 3 then return 'invalid'; end if;
  if (select count(distinct c ->> 's') from jsonb_array_elements(g) c) = 1 then
    select array_agg(public.rm_low(c ->> 'r')) into lo from jsonb_array_elements(g) c;
    select array_agg(case when x = 1 then 14 else x end) into hi from unnest(lo) x;
    if public.rm_consec(lo) or public.rm_consec(hi) then return 'pure'; end if;
  end if;
  select count(*) into nat from jsonb_array_elements(g) c where c ->> 'r' <> wild;
  jokers := n - nat;
  if nat = 0 then return 'invalid'; end if;
  if n <= 4 and (select count(distinct c ->> 'r') from jsonb_array_elements(g) c where c ->> 'r' <> wild) = 1
     and (select count(distinct c ->> 's') from jsonb_array_elements(g) c where c ->> 'r' <> wild) = nat then
    return 'set';
  end if;
  if (select count(distinct c ->> 's') from jsonb_array_elements(g) c where c ->> 'r' <> wild) = 1 then
    foreach ace_high in array array[false, true] loop
      select array_agg(case when ace_high and c ->> 'r' = 'A' then 14 else public.rm_low(c ->> 'r') end)
        into v from jsonb_array_elements(g) c where c ->> 'r' <> wild;
      if (select count(distinct x) from unnest(v) x) = nat
         and (select max(x) - min(x) + 1 - nat from unnest(v) x) <= jokers then
        return 'impure';
      end if;
    end loop;
  end if;
  return 'invalid';
end;
$$;

-- Points and validity of an arrangement (array of arrays of cards). Same rules as rummyRules.ts scoreGroups().
create function public.rm_score_groups(groups jsonb, wild text) returns jsonb
language plpgsql immutable as $$
declare g jsonb; k text; kinds text[] := '{}'; pure int := 0; seqs int := 0; invalid int := 0; cnt int := 0; pts int := 0; i int := 0;
begin
  for g in select * from jsonb_array_elements(groups) loop
    k := public.rm_classify(g, wild);
    kinds := kinds || k;
    if k = 'pure' then pure := pure + 1; end if;
    if k in ('pure', 'impure') then seqs := seqs + 1; end if;
    if k = 'invalid' then invalid := invalid + 1; end if;
    cnt := cnt + jsonb_array_length(g);
  end loop;
  for g in select * from jsonb_array_elements(groups) loop
    i := i + 1;
    if pure = 0 or (seqs < 2 and kinds[i] <> 'pure') or (seqs >= 2 and kinds[i] = 'invalid') then
      pts := pts + (select coalesce(sum(public.rm_pts(c, wild)), 0) from jsonb_array_elements(g) c);
    end if;
  end loop;
  return jsonb_build_object('points', least(pts, 80), 'valid', cnt = 13 and pure >= 1 and seqs >= 2 and invalid = 0);
end;
$$;

create function public.rm_minus(a jsonb, b jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(x), '[]') from jsonb_array_elements(a) x
  where (x ->> 'id')::int not in (select (y ->> 'id')::int from jsonb_array_elements(b) y);
$$;

-- Longest natural run (3+) of one suit in `cards`, one card per rank (A low or high), or null.
create function public.rm_find_run(cards jsonb) returns jsonb
language sql immutable as $$
  with c as (select x, x ->> 's' s, public.rm_low(x ->> 'r') v from jsonb_array_elements(cards) x),
  vals as (select distinct s, v from c union select distinct s, 14 from c where v = 1),
  isl as (select s, v, v - row_number() over (partition by s order by v) grp from vals),
  runs as (select s, min(v) lo, least(max(v), case when min(v) = 1 then 13 else 14 end) hi from isl group by s, grp),
  best as (select s, lo, hi from runs where hi - lo >= 2 order by hi - lo desc, hi desc limit 1)
  select jsonb_agg((select x from c where c.s = best.s and (c.v = val or (val = 14 and c.v = 1)) limit 1) order by val)
  from best, generate_series(best.lo, best.hi) val;
$$;

-- Best set (3-4 cards, same rank, different suits) in `cards`, highest points first, or null.
create function public.rm_find_set(cards jsonb, wild text) returns jsonb
language sql immutable as $$
  with c as (select x, x ->> 'r' r, x ->> 's' s from jsonb_array_elements(cards) x),
  best as (select r from c group by r having count(distinct s) >= 3 order by max(public.rm_pts((select x from c c2 where c2.r = c.r limit 1), wild)) desc limit 1),
  one as (select distinct on (c.s) c.x from c, best where c.r = best.r order by c.s)
  select jsonb_agg(x) from (select x from one limit 4) z;
$$;

-- Best pair that one joker turns into a group: kind 'seq' (same suit, 1-2 apart) or 'set' (same rank).
create function public.rm_find_pair(cards jsonb, wild text, kind text) returns jsonb
language sql immutable as $$
  with c as (select x, x ->> 'r' r, x ->> 's' s, public.rm_low(x ->> 'r') v, (x ->> 'id')::int id from jsonb_array_elements(cards) x)
  select jsonb_build_array(a.x, b.x) from c a join c b on a.id < b.id
  where (kind = 'seq' and a.s = b.s and (abs(a.v - b.v) between 1 and 2
         or (a.v = 1 and b.v between 12 and 13) or (b.v = 1 and a.v between 12 and 13)))
     or (kind = 'set' and a.r = b.r and a.s <> b.s)
  order by public.rm_pts(a.x, wild) + public.rm_pts(b.x, wild) desc limit 1;
$$;

-- Greedy grouping of a hand. strat 1: sets before joker sequences; strat 2: joker sequences first.
create function public.rm_greedy(cards jsonb, wild text, strat int) returns jsonb
language plpgsql immutable as $$
declare
  jokers jsonb := (select coalesce(jsonb_agg(c), '[]') from jsonb_array_elements(cards) c where c ->> 'r' = wild);
  rest jsonb := (select coalesce(jsonb_agg(c), '[]') from jsonb_array_elements(cards) c where c ->> 'r' <> wild);
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

-- Best of the greedy strategies: {points, valid, groups}.
create function public.rm_best(cards jsonb, wild text) returns jsonb
language plpgsql immutable as $$
declare a jsonb := public.rm_greedy(cards, wild, 1); b jsonb := public.rm_greedy(cards, wild, 2);
begin
  if (b ->> 'valid')::boolean and not (a ->> 'valid')::boolean then return b; end if;
  if (a ->> 'valid')::boolean and not (b ->> 'valid')::boolean then return a; end if;
  return case when (b ->> 'points')::int < (a ->> 'points')::int then b else a end;
end;
$$;

-- ---------------------------------------------------------------- Rummy: tables

create table public.rm_tables (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('points', 'pool101', 'pool201', 'deals')),
  stake bigint not null check (stake > 0),     -- coins per point (points) or entry fee (pool, deals)
  deals int not null default 0,                -- deals mode: number of deals in a match
  code text unique,                            -- private tables: invite code (friends only, no bots)
  status text not null default 'waiting' check (status in ('waiting', 'playing', 'dealdone')),
  match_no int not null default 0,
  deal_no int not null default 0,
  round int not null default 1,
  turn int,
  phase text,                                  -- 'draw' | 'discard'
  turn_ends timestamptz,
  bot_acts_at timestamptz,
  next_at timestamptz,
  wild jsonb,
  open_top jsonb,
  stock_count int not null default 0,
  prize bigint not null default 0,
  match_over boolean not null default true,
  result jsonb,
  seats jsonb not null default '[]',
  queue jsonb not null default '[]',
  members uuid[] not null default '{}',
  updated_at timestamptz not null default now()
);
create index rm_tables_lookup_idx on public.rm_tables (mode, stake, deals);

create table public.rm_private (table_id uuid primary key references public.rm_tables (id) on delete cascade, stock jsonb not null, open jsonb not null);
create table public.rm_hands (
  table_id uuid not null references public.rm_tables (id) on delete cascade,
  seat int not null,
  cards jsonb not null,
  groups jsonb,                                -- the player's own arrangement (arrays of card ids)
  primary key (table_id, seat)
);

alter table public.rm_tables enable row level security;
alter table public.rm_private enable row level security;  -- no policies: the stock is never readable
alter table public.rm_hands enable row level security;    -- no policies: hands are served by rm_view()
create policy "members see their table" on public.rm_tables for select to authenticated using (auth.uid() = any (members));
alter publication supabase_realtime add table public.rm_tables;

create function public.rm_members(s jsonb, q jsonb) returns uuid[] language sql immutable as $$
  select coalesce(array_agg(distinct (x ->> 'uid')::uuid) filter (where x ->> 'uid' is not null), '{}')
  from jsonb_array_elements(s || q) x where coalesce((x ->> 'left')::boolean, false) = false;
$$;

-- Seats still in the current deal.
create function public.rm_active(s jsonb) returns int[] language sql immutable as $$
  select coalesce(array_agg(i - 1 order by i), '{}') from jsonb_array_elements(s) with ordinality x(v, i)
  where coalesce((v ->> 'playing')::boolean, false) and not coalesce((v ->> 'dropped')::boolean, false) and not coalesce((v ->> 'wrong')::boolean, false);
$$;

create function public.rm_drop_pts(mode text, middle boolean) returns int language sql immutable as $$
  select case when mode = 'pool201' then (case when middle then 50 else 25 end) else (case when middle then 40 else 20 end) end;
$$;

create function public.rm_label(t public.rm_tables) returns text language sql immutable as $$
  select 'Rummy • ' || case t.mode when 'points' then 'Points' when 'pool101' then 'Pool 101' when 'pool201' then 'Pool 201' else 'Deals ×' || t.deals end;
$$;

create function public.rm_seat_set(s jsonb, seat int, patch jsonb) returns jsonb language sql immutable as $$
  select jsonb_set(s, array[seat::text], (s -> seat) || patch);
$$;

create function public.rm_set_turn(t public.rm_tables, seat int) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare secs int := coalesce((public.game_cfg('rummy') ->> 'turn')::int, 30); r float := random();
begin
  t.turn := seat;
  t.phase := 'draw';
  t.turn_ends := now() + make_interval(secs => secs);
  t.seats := public.rm_seat_set(t.seats, seat, '{"picked": null}');
  if (t.seats -> seat ->> 'bot')::boolean then
    t.bot_acts_at := now() + make_interval(secs => case when r < 0.95 then 1.2 + random() * 4 else secs end);
  else
    t.bot_acts_at := null;
  end if;
  return t;
end;
$$;

-- Start the next deal. A new match first when needed: seats change, entries (Pool/Deals) are collected.
-- Points Rummy: every deal is its own match; each player's maximum loss (80 points) is held and settled after.
create function public.rm_start(t public.rm_tables) returns public.rm_tables
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
    hold := case when t.mode = 'points' then 80 * t.stake else t.stake end;
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

  -- Deal: 13 cards each from two shuffled decks; next card sets the wild joker; one card starts the open pile.
  n := jsonb_array_length(t.seats);
  select jsonb_agg(c order by random()) into d from (
    select jsonb_build_object('id', (k2 - 1) * 52 + (row_number() over (partition by k2 order by cr, cs)) - 1, 'r', cr, 's', cs) c
    from generate_series(1, 2) k2,
         unnest(array['A','2','3','4','5','6','7','8','9','10','J','Q','K']) cr,
         unnest(array['♠','♥','♦','♣']) cs) z;
  delete from rm_hands where table_id = t.id;
  for i in 0 .. n - 1 loop
    x := t.seats -> i;
    if coalesce((x ->> 'in_match')::boolean, false) and not coalesce((x ->> 'out')::boolean, false) then
      select jsonb_agg(d -> j) into hand from generate_series(k, k + 12) j;
      insert into rm_hands (table_id, seat, cards) values (t.id, i, hand);
      k := k + 13;
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

-- Deal over: score every player, settle coins, decide whether the match continues.
create function public.rm_end_deal(t public.rm_tables, winner int) returns public.rm_tables
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
    elsif (x ->> 'wrong')::boolean then pts := 80;
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
    pts := least(pts, 80);
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

-- Hand the turn to the next player, or end the deal if only one is left.
create function public.rm_pass(t public.rm_tables, seat int) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare active int[] := public.rm_active(t.seats); n int := jsonb_array_length(t.seats); nxt int := seat;
begin
  if array_length(active, 1) = 1 then return public.rm_end_deal(t, active[1]); end if;
  loop
    nxt := (nxt + 1) % n;
    if nxt <= seat and nxt = active[1] then t.round := t.round + 1; end if;
    exit when nxt = any (active);
  end loop;
  return public.rm_set_turn(t, nxt);
end;
$$;

create function public.rm_draw(t public.rm_tables, seat int, src text) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare p rm_private; card jsonb; top jsonb;
begin
  if t.phase <> 'draw' then raise exception 'You have already drawn a card'; end if;
  select * into p from rm_private where table_id = t.id for update;
  if src = 'open' then
    card := p.open -> 0;
    if card is null then raise exception 'The open pile is empty'; end if;
    if card ->> 'r' = t.wild ->> 'r' then raise exception 'You can''t pick a joker from the open pile'; end if;
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

-- Remove a card from the hand onto the open pile.
create function public.rm_throw(t public.rm_tables, seat int, card_id int) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare card jsonb;
begin
  select c into card from rm_hands h, jsonb_array_elements(h.cards) c where h.table_id = t.id and h.seat = rm_throw.seat and (c ->> 'id')::int = card_id;
  if card is null then raise exception 'That card is not in your hand'; end if;
  update rm_hands set cards = (select jsonb_agg(c) from jsonb_array_elements(cards) c where (c ->> 'id')::int <> card_id)
    where table_id = t.id and rm_hands.seat = rm_throw.seat;
  update rm_private set open = jsonb_build_array(card) || open where table_id = t.id;
  t.open_top := card;
  return t;
end;
$$;

create function public.rm_discard(t public.rm_tables, seat int, card_id int) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare c jsonb;
begin
  if t.phase <> 'discard' then raise exception 'Draw a card first'; end if;
  if (t.seats -> seat ->> 'picked')::int = card_id and not (t.seats -> seat ->> 'bot')::boolean then raise exception 'You can''t discard the card you just picked from the open pile'; end if;
  t := public.rm_throw(t, seat, card_id);
  c := t.open_top;
  t.seats := public.rm_seat_set(t.seats, seat, jsonb_build_object('action', 'Discarded ' || (c ->> 'r') || (c ->> 's')));
  return public.rm_pass(t, seat);
end;
$$;

-- Declare: put the 14th card aside and show 13 cards in groups (arrays of card ids).
create function public.rm_declare(t public.rm_tables, seat int, card_id int, p_groups jsonb) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare cards jsonb; groups jsonb; sc jsonb; ids int[]; want int[];
begin
  if t.phase <> 'discard' then raise exception 'Draw a card before declaring'; end if;
  t := public.rm_throw(t, seat, card_id);
  select h.cards into cards from rm_hands h where h.table_id = t.id and h.seat = rm_declare.seat;
  select array_agg((y #>> '{}')::int order by (y #>> '{}')::int) into ids from jsonb_array_elements(coalesce(p_groups, '[]')) g, jsonb_array_elements(g) y;
  select array_agg((c ->> 'id')::int order by (c ->> 'id')::int) into want from jsonb_array_elements(cards) c;
  if ids is distinct from want then raise exception 'Your groups must contain exactly your 13 cards'; end if;
  groups := (select jsonb_agg((select jsonb_agg(c) from jsonb_array_elements(cards) c where (c ->> 'id')::int in (select (y #>> '{}')::int from jsonb_array_elements(g) y))) from jsonb_array_elements(p_groups) g);
  update rm_hands set groups = p_groups where table_id = t.id and rm_hands.seat = rm_declare.seat;
  sc := public.rm_score_groups(groups, t.wild ->> 'r');
  if (sc ->> 'valid')::boolean then
    t.seats := public.rm_seat_set(t.seats, seat, '{"action": "Declared!"}');
    return public.rm_end_deal(t, seat);
  end if;
  -- Wrong declaration: 80 points and out of this deal; the others play on.
  t.seats := public.rm_seat_set(t.seats, seat, '{"wrong": true, "action": "Wrong show"}');
  return public.rm_pass(t, seat);
end;
$$;

create function public.rm_drop(t public.rm_tables, seat int) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare middle boolean := (t.seats -> seat ->> 'turns')::int > 0 or t.phase = 'discard';
begin
  t.seats := public.rm_seat_set(t.seats, seat, jsonb_build_object('dropped', true, 'middle', middle, 'action', case when middle then 'Middle drop' else 'Dropped' end));
  return public.rm_pass(t, seat);
end;
$$;

-- Turn ran out: draw from closed and throw it back (or throw the drawn card). Three misses in a row: drop.
create function public.rm_timeout(t public.rm_tables) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare st int := t.turn; misses int := coalesce((t.seats -> t.turn ->> 'timeouts')::int, 0) + 1; last_card jsonb; picked int;
begin
  t.seats := public.rm_seat_set(t.seats, st, jsonb_build_object('timeouts', misses));
  if misses >= 3 then return public.rm_drop(t, st); end if;
  if t.phase = 'draw' then t := public.rm_draw(t, st, 'stock'); end if;
  picked := (t.seats -> st ->> 'picked')::int;
  select c into last_card from rm_hands h, jsonb_array_elements(h.cards) with ordinality x(c, i)
    where h.table_id = t.id and h.seat = st and (picked is null or (c ->> 'id')::int <> picked)
    order by case when picked is null then i end desc nulls last, public.rm_pts(c, t.wild ->> 'r') desc limit 1;
  t := public.rm_throw(t, st, (last_card ->> 'id')::int);
  t.seats := public.rm_seat_set(t.seats, st, '{"action": "Timed out • auto"}');
  return public.rm_pass(t, st);
end;
$$;

-- An honest bot: it sees only its own hand and the open card, and declares only a truly valid hand.
create function public.rm_bot_move(t public.rm_tables) returns public.rm_tables
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
    if (t.seats -> st ->> 'turns')::int = 0 and (cur ->> 'points')::int >= 70 and random() < 0.25 then return public.rm_drop(t, st); end if;
    if t.round >= 5 and (cur ->> 'points')::int >= 75 and random() < 0.08 then return public.rm_drop(t, st); end if;
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

create function public.rm_advance(t public.rm_tables) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare steps int := 0;
begin
  loop
    steps := steps + 1;
    exit when steps > 16;
    if t.status in ('waiting', 'dealdone') and t.next_at is not null and t.next_at <= now() then
      t := public.rm_start(t);
    elsif t.status = 'playing' and (t.seats -> t.turn ->> 'bot')::boolean and t.bot_acts_at <= now() then
      t := public.rm_bot_move(t);
    elsif t.status = 'playing' and t.turn_ends <= now() then
      t := public.rm_timeout(t);
    else
      exit;
    end if;
  end loop;
  return t;
end;
$$;

create function public.rm_save(t public.rm_tables) returns void
language sql security definer set search_path = public as $$
  update rm_tables set status = t.status, match_no = t.match_no, deal_no = t.deal_no, round = t.round, turn = t.turn, phase = t.phase,
    turn_ends = t.turn_ends, bot_acts_at = t.bot_acts_at, next_at = t.next_at, wild = t.wild, open_top = t.open_top,
    stock_count = t.stock_count, prize = t.prize, match_over = t.match_over, result = t.result, seats = t.seats, queue = t.queue,
    members = public.rm_members(t.seats, t.queue), updated_at = now()
  where id = t.id;
$$;

create function public.rm_view(t public.rm_tables) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me int; my_cards jsonb; my_groups jsonb;
begin
  select i - 1 into me from jsonb_array_elements(t.seats) with ordinality x(v, i) where v ->> 'uid' = auth.uid()::text;
  if me is not null and t.status <> 'waiting' then
    select h.cards, h.groups into my_cards, my_groups from rm_hands h where h.table_id = t.id and h.seat = me;
  end if;
  return jsonb_build_object(
    'id', t.id, 'mode', t.mode, 'stake', t.stake, 'deals', t.deals, 'code', t.code, 'status', t.status, 'match_no', t.match_no,
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

create function public.rm_valid_stake(p_mode text, p_stake bigint, p_deals int) returns boolean language sql immutable as $$
  select case when p_mode = 'points' then p_stake in (1, 2, 5, 10, 20, 50, 100)
              when p_mode in ('pool101', 'pool201') then p_stake in (10, 25, 50, 100, 250, 500, 1000)
              when p_mode = 'deals' then p_stake in (10, 25, 50, 100, 250, 500, 1000) and p_deals in (2, 3)
              else false end;
$$;

-- Sit down at a public Rummy table of this format and stake, or a private one by code (rejoins if seated).
create function public.rm_join(p_mode text, p_stake bigint, p_deals int default 0, p_code text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare me profiles := public.current_profile(); t rm_tables; who jsonb; emo text; need bigint;
begin
  if me.id is null or me.role <> 'player' then raise exception 'Only active players can join tables'; end if;
  if not coalesce((public.game_cfg('rummy') ->> 'enabled')::boolean, true) then raise exception 'Rummy is closed for maintenance'; end if;
  if p_code is not null then
    select * into t from rm_tables where code = upper(trim(p_code));
    if not found then raise exception 'No table with that code'; end if;
    p_mode := t.mode; p_stake := t.stake; p_deals := t.deals;
  else
    if p_mode <> 'deals' then p_deals := 0; end if;
    if not public.rm_valid_stake(p_mode, p_stake, p_deals) then raise exception 'Invalid table'; end if;
  end if;
  need := case when p_mode = 'points' then 80 * p_stake else p_stake end;
  if (select coins from wallets where user_id = me.id) < need then raise exception 'Not enough coins (you need %)', need; end if;

  select * into t from rm_tables where me.id = any (members) and mode = p_mode and stake = p_stake and deals = p_deals
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
      where tt.mode = p_mode and tt.stake = p_stake and tt.deals = p_deals and tt.code is null
        and (select count(*) from jsonb_array_elements(tt.seats) v where not (v ->> 'bot')::boolean and not coalesce((v ->> 'left')::boolean, false))
            + jsonb_array_length(tt.queue) < 6
        and tt.updated_at > now() - interval '5 minutes'
      order by (select count(*) from jsonb_array_elements(tt.seats) v where not (v ->> 'bot')::boolean and not coalesce((v ->> 'left')::boolean, false)) desc
      limit 1 for update skip locked;
    if not found then
      insert into rm_tables (mode, stake, deals, queue, members, next_at) values (p_mode, p_stake, p_deals, jsonb_build_array(who), array[me.id], now() + interval '3 seconds')
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

create function public.rm_create_private(p_mode text, p_stake bigint, p_deals int default 0) returns text
language plpgsql security definer set search_path = public as $$
declare me profiles := public.current_profile(); c text;
begin
  if me.id is null or me.role <> 'player' then raise exception 'Only active players can create tables'; end if;
  if p_mode <> 'deals' then p_deals := 0; end if;
  if not public.rm_valid_stake(p_mode, p_stake, p_deals) then raise exception 'Invalid table'; end if;
  loop
    c := public.new_code();
    exit when not exists (select 1 from tp_tables where code = c) and not exists (select 1 from rm_tables where code = c);
  end loop;
  insert into rm_tables (mode, stake, deals, code) values (p_mode, p_stake, p_deals, c);
  perform public.rm_join(p_mode, p_stake, p_deals, c);
  return c;
end;
$$;

create function public.rm_tick(p_table uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t rm_tables;
begin
  select * into t from rm_tables where id = p_table and auth.uid() = any (members) for update;
  if not found then raise exception 'You are not at this table'; end if;
  t.seats := (select coalesce(jsonb_agg(case when v ->> 'uid' = auth.uid()::text then v || jsonb_build_object('ping', now()) else v end order by i), '[]')
              from jsonb_array_elements(t.seats) with ordinality x(v, i));
  t := public.rm_advance(t);
  perform public.rm_save(t);
  return public.rm_view(t);
end;
$$;

create function public.rm_state(p_table uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t rm_tables;
begin
  select * into t from rm_tables where id = p_table and auth.uid() = any (members);
  if not found then raise exception 'You are not at this table'; end if;
  return public.rm_view(t);
end;
$$;

-- p_action: 'draw_stock' | 'draw_open' | 'discard' (p_card) | 'declare' (p_card = 14th card, p_groups) | 'drop'
create function public.rm_act(p_table uuid, p_action text, p_card int default null, p_groups jsonb default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t rm_tables; me int;
begin
  select * into t from rm_tables where id = p_table and auth.uid() = any (members) for update;
  if not found then raise exception 'You are not at this table'; end if;
  t := public.rm_advance(t);
  select i - 1 into me from jsonb_array_elements(t.seats) with ordinality x(v, i) where v ->> 'uid' = auth.uid()::text;
  if me is null or t.status <> 'playing' or not (me = any (public.rm_active(t.seats))) then raise exception 'You are not in this deal'; end if;
  if t.turn <> me then raise exception 'Not your turn'; end if;
  t.seats := public.rm_seat_set(t.seats, me, '{"timeouts": 0}');
  if p_action = 'draw_stock' then t := public.rm_draw(t, me, 'stock');
  elsif p_action = 'draw_open' then t := public.rm_draw(t, me, 'open');
  elsif p_action = 'discard' then t := public.rm_discard(t, me, p_card);
  elsif p_action = 'declare' then t := public.rm_declare(t, me, p_card, p_groups);
  elsif p_action = 'drop' then
    if t.phase <> 'draw' then raise exception 'You can only drop before drawing'; end if;
    t := public.rm_drop(t, me);
  else raise exception 'Unknown action'; end if;
  t := public.rm_advance(t);
  perform public.rm_save(t);
  return public.rm_view(t);
end;
$$;

-- Save the player's own arrangement (arrays of card ids) — used for their score if someone else declares.
create function public.rm_arrange(p_table uuid, p_groups jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare me int;
begin
  select i - 1 into me from rm_tables t, jsonb_array_elements(t.seats) with ordinality x(v, i)
    where t.id = p_table and auth.uid() = any (t.members) and v ->> 'uid' = auth.uid()::text;
  if me is null then return; end if;
  update rm_hands set groups = p_groups where table_id = p_table and seat = me;
end;
$$;

create function public.rm_leave(p_table uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t rm_tables; me int;
begin
  select * into t from rm_tables where id = p_table and auth.uid() = any (members) for update;
  if not found then return; end if;
  t.queue := (select coalesce(jsonb_agg(q), '[]') from jsonb_array_elements(t.queue) q where q ->> 'uid' <> auth.uid()::text);
  select i - 1 into me from jsonb_array_elements(t.seats) with ordinality x(v, i) where v ->> 'uid' = auth.uid()::text;
  if me is not null then
    t.seats := public.rm_seat_set(t.seats, me, '{"left": true}');
    -- Leaving mid-deal counts as a drop (and forfeits a Pool/Deals match).
    if t.status = 'playing' and me = any (public.rm_active(t.seats)) then
      if t.turn = me then t := public.rm_drop(t, me);
      else
        t.seats := public.rm_seat_set(t.seats, me, jsonb_build_object('dropped', true, 'middle', (t.seats -> me ->> 'turns')::int > 0, 'action', 'Left'));
        if array_length(public.rm_active(t.seats), 1) = 1 then t := public.rm_end_deal(t, (public.rm_active(t.seats))[1]); end if;
      end if;
    end if;
    if t.mode <> 'points' and coalesce((t.seats -> me ->> 'in_match')::boolean, false) then
      t.seats := public.rm_seat_set(t.seats, me, '{"out": true}');
    end if;
  end if;
  perform public.rm_save(t);
end;
$$;

-- ---------------------------------------------------------------- lobby

-- Real players currently seated per public table type, e.g. {"teen-patti": {"10": 3}, "rummy": {"pool101:50:0": 2}}.
create function public.lobby_counts() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'teen-patti', coalesce((select jsonb_object_agg(boot::text, n) from (
        select boot, sum((select count(*) from jsonb_array_elements(seats) v where not (v ->> 'bot')::boolean and not coalesce((v ->> 'left')::boolean, false))
                         + jsonb_array_length(queue)) n
        from tp_tables where code is null and updated_at > now() - interval '2 minutes' group by boot) z), '{}'),
    'rummy', coalesce((select jsonb_object_agg(k, n) from (
        select mode || ':' || stake || ':' || deals k, sum((select count(*) from jsonb_array_elements(seats) v where not (v ->> 'bot')::boolean and not coalesce((v ->> 'left')::boolean, false))
                         + jsonb_array_length(queue)) n
        from rm_tables where code is null and updated_at > now() - interval '2 minutes' group by 1) z), '{}'));
$$;

-- ---------------------------------------------------------------- permissions

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
do $$
declare f text;
begin
  -- Internal engine functions: only callable from other functions, never directly from the app.
  foreach f in array array[
    'create_profile(uuid, uuid, public.app_role, text, text, text, uuid, text)', 'write_audit(text, text, text)',
    'wallet_move(uuid, bigint, text, text)', 'make_bot(text[])',
    'tp_set_turn(public.tp_tables, int)', 'tp_start_hand(public.tp_tables)', 'tp_finish(public.tp_tables, int, text, boolean)',
    'tp_showdown(public.tp_tables)', 'tp_apply(public.tp_tables, int, text)', 'tp_bot_move(public.tp_tables)',
    'tp_advance(public.tp_tables)', 'tp_save(public.tp_tables)', 'tp_view(public.tp_tables)', 'tp_pay(public.tp_tables, int, bigint)',
    'tp_pass(public.tp_tables, int)', 'tp_request_sideshow(public.tp_tables, int)', 'tp_resolve_sideshow(public.tp_tables, boolean)',
    'rm_set_turn(public.rm_tables, int)', 'rm_start(public.rm_tables)', 'rm_end_deal(public.rm_tables, int)', 'rm_pass(public.rm_tables, int)',
    'rm_draw(public.rm_tables, int, text)', 'rm_throw(public.rm_tables, int, int)', 'rm_discard(public.rm_tables, int, int)',
    'rm_declare(public.rm_tables, int, int, jsonb)', 'rm_drop(public.rm_tables, int)', 'rm_timeout(public.rm_tables)',
    'rm_bot_move(public.rm_tables)', 'rm_advance(public.rm_tables)', 'rm_save(public.rm_tables)', 'rm_view(public.rm_tables)']
  loop
    execute 'revoke execute on function public.' || f || ' from authenticated';
  end loop;
end $$;


-- GameHub fixes from the live test:
--   • one table join at a time per player
--   • quicker Teen Patti bots (most moves in 1-5 s; rarely run out the clock)
-- Two join requests from the same player arriving together (a double tap, or a screen mounting twice) could each
-- miss the other's table and seat the player at two tables. A per-player transaction lock makes the second request
-- wait for the first and then rejoin the same table.

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

create or replace function public.rm_join(p_mode text, p_stake bigint, p_deals int default 0, p_code text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare me profiles := public.current_profile(); t rm_tables; who jsonb; emo text; need bigint;
begin
  if me.id is null or me.role <> 'player' then raise exception 'Only active players can join tables'; end if;
  perform pg_advisory_xact_lock(hashtext('table-join:' || me.id::text));
  if not coalesce((public.game_cfg('rummy') ->> 'enabled')::boolean, true) then raise exception 'Rummy is closed for maintenance'; end if;
  if p_code is not null then
    select * into t from rm_tables where code = upper(trim(p_code));
    if not found then raise exception 'No table with that code'; end if;
    p_mode := t.mode; p_stake := t.stake; p_deals := t.deals;
  else
    if p_mode <> 'deals' then p_deals := 0; end if;
    if not public.rm_valid_stake(p_mode, p_stake, p_deals) then raise exception 'Invalid table'; end if;
  end if;
  need := case when p_mode = 'points' then 80 * p_stake else p_stake end;
  if (select coins from wallets where user_id = me.id) < need then raise exception 'Not enough coins (you need %)', need; end if;

  select * into t from rm_tables where me.id = any (members) and mode = p_mode and stake = p_stake and deals = p_deals
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
      where tt.mode = p_mode and tt.stake = p_stake and tt.deals = p_deals and tt.code is null
        and (select count(*) from jsonb_array_elements(tt.seats) v where not (v ->> 'bot')::boolean and not coalesce((v ->> 'left')::boolean, false))
            + jsonb_array_length(tt.queue) < 6
        and tt.updated_at > now() - interval '5 minutes'
      order by (select count(*) from jsonb_array_elements(tt.seats) v where not (v ->> 'bot')::boolean and not coalesce((v ->> 'left')::boolean, false)) desc
      limit 1 for update skip locked;
    if not found then
      insert into rm_tables (mode, stake, deals, queue, members, next_at) values (p_mode, p_stake, p_deals, jsonb_build_array(who), array[me.id], now() + interval '3 seconds')
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

-- Teen Patti bot pacing
create or replace function public.tp_set_turn(t public.tp_tables, seat int) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare r float := random(); secs int := coalesce((public.game_cfg('teen-patti') ->> 'turn')::int, 15); delay float;
begin
  t.turn := seat;
  t.turn_ends := now() + make_interval(secs => secs);
  if (t.seats -> seat ->> 'bot')::boolean then
    delay := case when r < 0.45 then 0.8 + random() * 1.7 when r < 0.85 then 2.5 + random() * 2.5 when r < 0.98 then least(5 + random() * 4, secs - 1) else secs end;
    t.bot_acts_at := now() + make_interval(secs => delay);
  else
    t.bot_acts_at := null;
  end if;
  return t;
end;
$$;

revoke execute on function public.tp_set_turn(public.tp_tables, int) from public, anon, authenticated;
revoke execute on function public.tp_join(bigint, text) from public, anon;
revoke execute on function public.rm_join(text, bigint, int, text) from public, anon;
grant execute on function public.tp_join(bigint, text) to authenticated;
grant execute on function public.rm_join(text, bigint, int, text) to authenticated;




-- 005: Dragon Tiger side bets, and a re-run of the function permissions.
--
-- Side bets (total return per coin, stake included):
--   pair            Dragon and Tiger show the same rank            ×12
--   d_even / t_even card rank is even (2,4,6,8,10,Q)               ×2.1
--   d_odd  / t_odd  card rank is odd (A,3,5,7,9,J,K)               ×1.79
--   d_black/t_black ♠ or ♣                                         ×1.95
--   d_red  / t_red  ♥ or ♦                                         ×1.95
--   d_<R>  / t_<R>  exact rank, e.g. d_A, t_10, d_K                ×12
-- Main bets are unchanged (Dragon/Tiger ×2, Tie ×9, Dragon/Tiger stakes get 50% back on a tie).
--
-- Safe to run more than once. Run it in the Supabase SQL Editor.

create or replace function public.dt_pay(p_side text, p_d jsonb, p_t jsonb, p_winner text) returns numeric
language plpgsql immutable set search_path = public as $$
declare c jsonb; key text; v int;
begin
  if p_side in ('dragon', 'tiger', 'tie') then
    return case when p_side = p_winner then (case p_side when 'tie' then 9 else 2 end) else 0 end;
  end if;
  if p_side = 'pair' then return case when p_d ->> 'r' = p_t ->> 'r' then 12 else 0 end; end if;
  c := case left(p_side, 1) when 'd' then p_d else p_t end;
  key := substr(p_side, 3);
  v := public.card_low(c ->> 'r');
  return case key
    when 'even' then case when v % 2 = 0 then 2.1 else 0 end
    when 'odd' then case when v % 2 = 1 then 1.79 else 0 end
    when 'black' then case when c ->> 's' in ('♠', '♣') then 1.95 else 0 end
    when 'red' then case when c ->> 's' in ('♥', '♦') then 1.95 else 0 end
    else case when key = c ->> 'r' then 12 else 0 end
  end;
end;
$$;

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
            or (p_game = 'dragon-tiger' and (b ->> 'side') ~ '^(pair|[dt]_(even|odd|black|red|A|[2-9]|10|J|Q|K))$'))
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

  -- Payouts (stake included): 1:1 → ×2, Tie 8:1 → ×9, Exactly 7 11:1 → ×12. Dragon Tiger tie refunds 50% of side bets.
  for b in select * from jsonb_array_elements(coalesce(p_bets, '[]')) loop
    if p_game = 'dragon-tiger' then
      if public.dt_pay(b ->> 'side', d -> 0, d -> 1, winner) > 0 then
        ret := ret + (b ->> 'v')::bigint * public.dt_pay(b ->> 'side', d -> 0, d -> 1, winner);
        won_side := true;
      elsif winner = 'tie' and b ->> 'side' in ('dragon', 'tiger') then
        ret := ret + (b ->> 'v')::bigint / 2.0;
      end if;
      continue;
    end if;
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

-- ---------------------------------------------------------------- permissions (same as setup_all.sql)

revoke execute on all functions in schema public from public, anon;
grant usage on schema public to authenticated;
grant execute on all functions in schema public to authenticated, service_role;
do $$
declare f text;
begin
  -- Internal engine functions: only callable from other functions, never directly from the app.
  foreach f in array array[
    'create_profile(uuid, uuid, public.app_role, text, text, text, uuid, text)', 'write_audit(text, text, text)',
    'wallet_move(uuid, bigint, text, text)', 'make_bot(text[])', 'dt_pay(text, jsonb, jsonb, text)',
    'tp_set_turn(public.tp_tables, int)', 'tp_start_hand(public.tp_tables)', 'tp_finish(public.tp_tables, int, text, boolean)',
    'tp_showdown(public.tp_tables)', 'tp_apply(public.tp_tables, int, text)', 'tp_bot_move(public.tp_tables)',
    'tp_advance(public.tp_tables)', 'tp_save(public.tp_tables)', 'tp_view(public.tp_tables)', 'tp_pay(public.tp_tables, int, bigint)',
    'tp_pass(public.tp_tables, int)', 'tp_request_sideshow(public.tp_tables, int)', 'tp_resolve_sideshow(public.tp_tables, boolean)',
    'rm_set_turn(public.rm_tables, int)', 'rm_start(public.rm_tables)', 'rm_end_deal(public.rm_tables, int)', 'rm_pass(public.rm_tables, int)',
    'rm_draw(public.rm_tables, int, text)', 'rm_throw(public.rm_tables, int, int)', 'rm_discard(public.rm_tables, int, int)',
    'rm_declare(public.rm_tables, int, int, jsonb)', 'rm_drop(public.rm_tables, int)', 'rm_timeout(public.rm_tables)',
    'rm_bot_move(public.rm_tables)', 'rm_advance(public.rm_tables)', 'rm_save(public.rm_tables)', 'rm_view(public.rm_tables)']
  loop
    execute 'revoke execute on function public.' || f || ' from authenticated';
  end loop;
end $$;


-- 006: Lucky 7 markets (exchange-style board). Run after 005 in the Supabase SQL Editor. Safe to run more than once.
--
-- One card is dealt. Odds are the total return per coin staked (stake included):
--   low               A to 6                              ×2      (a 7 loses Low and High)
--   high              8 to K                              ×2
--   even              2, 4, 6, 8, 10, Q                   ×2.1
--   odd               A, 3, 5, 7, 9, J, K                 ×1.79
--   black / red       ♠ ♣ / ♥ ♦                           ×1.95
--   g_a23 / g_456 / g_8910 / g_jqk   card in that group   ×4      (7 is in no group)
--   c_A … c_K         exact card                          ×12
-- The older bets below / seven / above (×2 / ×12 / ×2) still settle, for app versions that use them.

create or replace function public.l7_pay(p_side text, p_card jsonb) returns numeric
language plpgsql immutable set search_path = public as $$
declare v int := public.card_low(p_card ->> 'r'); s text := p_card ->> 's';
begin
  return case p_side
    when 'low' then case when v <= 6 then 2 else 0 end
    when 'high' then case when v >= 8 then 2 else 0 end
    when 'below' then case when v < 7 then 2 else 0 end
    when 'above' then case when v > 7 then 2 else 0 end
    when 'seven' then case when v = 7 then 12 else 0 end
    when 'even' then case when v % 2 = 0 then 2.1 else 0 end
    when 'odd' then case when v % 2 = 1 then 1.79 else 0 end
    when 'black' then case when s in ('♠', '♣') then 1.95 else 0 end
    when 'red' then case when s in ('♥', '♦') then 1.95 else 0 end
    when 'g_a23' then case when v between 1 and 3 then 4 else 0 end
    when 'g_456' then case when v between 4 and 6 then 4 else 0 end
    when 'g_8910' then case when v between 8 and 10 then 4 else 0 end
    when 'g_jqk' then case when v between 11 and 13 then 4 else 0 end
    else case when p_side = 'c_' || (p_card ->> 'r') then 12 else 0 end
  end;
end;
$$;

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

revoke execute on function public.l7_pay(text, jsonb) from public, anon, authenticated;
revoke execute on function public.casino_round(text, jsonb, text) from public, anon;
grant execute on function public.casino_round(text, jsonb, text) to authenticated;


-- 007: edit account details from the Admin / Agent console. Run after 006. Safe to run more than once.
--
-- update_profile() is called only by the server API (PATCH /api/accounts, service role), which also keeps the login
-- in step: a player signs in with their mobile number and staff with their username, so changing either changes the
-- login too. Rules: the Super Admin can edit everyone; anyone else only accounts below them in their network.
-- Every changed field (and a password reset) is written to the audit log under the editor's name.

create or replace function public.update_profile(
  p_actor uuid, p_target uuid, p_name text, p_phone text, p_username text, p_state text, p_password_reset boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  actor profiles;
  t profiles;
  who text;
  changes jsonb := '[]';
  ch jsonb;
begin
  select * into actor from profiles where id = p_actor and status = 'active';
  if actor.id is null then raise exception 'Your account is not active'; end if;
  select * into t from profiles where id = p_target;
  if t.id is null then raise exception 'Account not found'; end if;
  if t.id = actor.id or not (actor.role = 'superadmin' or public.is_ancestor(actor.id, t.id)) then
    raise exception 'You can only edit accounts in your own network';
  end if;

  p_name := trim(coalesce(p_name, ''));
  if p_name = '' then raise exception 'Enter a name'; end if;
  p_phone := nullif(trim(coalesce(p_phone, '')), '');
  if p_phone is not null and p_phone !~ '^[0-9]{10}$' then raise exception 'Enter a 10-digit mobile number'; end if;
  if t.role = 'player' and p_phone is null then raise exception 'Players need a mobile number to sign in'; end if;
  if t.role = 'player' then
    p_username := null;
    p_state := nullif(trim(coalesce(p_state, '')), '');
  else
    p_username := lower(trim(coalesce(p_username, '')));
    if p_username !~ '^[a-z0-9._]{3,}$' then raise exception 'Username: at least 3 letters, numbers, dots or underscores'; end if;
    p_state := t.state;
  end if;
  if p_phone is distinct from t.phone and exists (select 1 from profiles where phone = p_phone and id <> t.id) then
    raise exception 'That mobile number is already used by another account';
  end if;
  if p_username is distinct from t.username and exists (select 1 from profiles where username = p_username and id <> t.id) then
    raise exception 'That username is taken';
  end if;

  if p_name <> t.name then changes := changes || jsonb_build_array(jsonb_build_array('Name', t.name, p_name)); end if;
  if p_phone is distinct from t.phone then changes := changes || jsonb_build_array(jsonb_build_array('Mobile', coalesce(t.phone, '—'), coalesce(p_phone, '—'))); end if;
  if p_username is distinct from t.username then changes := changes || jsonb_build_array(jsonb_build_array('Username', coalesce(t.username, '—'), p_username)); end if;
  if p_state is distinct from t.state then changes := changes || jsonb_build_array(jsonb_build_array('State', coalesce(t.state, '—'), coalesce(p_state, '—'))); end if;
  if p_password_reset then changes := changes || jsonb_build_array(jsonb_build_array('Password', '••••', 'reset')); end if;

  update profiles set name = p_name, phone = p_phone, username = p_username, state = p_state where id = t.id;

  who := initcap(t.role::text) || ' ' || t.code;
  for ch in select * from jsonb_array_elements(changes) loop
    insert into audit_log (actor_id, actor_name, action, before, after)
      values (actor.id, coalesce(actor.username, actor.name), who || ' • ' || (ch ->> 0), ch ->> 1, ch ->> 2);
  end loop;

  return jsonb_build_object('old', to_jsonb(t), 'new', (select to_jsonb(p) from profiles p where p.id = t.id), 'changed', jsonb_array_length(changes));
end;
$$;

-- Server API only: never callable from the browser.
revoke execute on function public.update_profile(uuid, uuid, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.update_profile(uuid, uuid, text, text, text, text, boolean) to service_role;


-- 008: Teen Patti limits closer to standard tables.
--   • Pot limit raised from boot × 60 to boot × 1024 (the automatic show was kicking in by round 3-4).
--   • Raise is capped so the blind stake never goes above boot × 128 (seen chaal ≤ boot × 256).
-- Safe to run more than once. Run it in the Supabase SQL Editor.

create or replace function public.tp_pass(t public.tp_tables, seat int) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare active int[] := public.tp_active(t.seats); n int := jsonb_array_length(t.seats); nxt int := seat;
begin
  if array_length(active, 1) = 1 then return public.tp_finish(t, active[1], 'Everyone else packed', false); end if;
  if t.pot >= t.boot * 1024 then return public.tp_showdown(t); end if; -- pot limit (boot × 1024): automatic show
  loop
    nxt := (nxt + 1) % n;
    if nxt <= seat and nxt = active[1] then t.round := t.round + 1; end if;
    exit when nxt = any (active);
  end loop;
  return public.tp_set_turn(t, nxt);
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

revoke execute on function public.tp_pass(public.tp_tables, int) from public, anon, authenticated;
revoke execute on function public.tp_apply(public.tp_tables, int, text) from public, anon, authenticated;


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
