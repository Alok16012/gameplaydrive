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
