-- 117: Private tables report (Admin → Reports → Private Tables). Three statements, apart from the ordinary game
-- reports: every private table made (Rummy 13 / 21 Card, Teen Patti, Poker, Ludo, Chess) with who made it and when;
-- the coin transactions of each table; and the commission (platform fee) kept from each table, game-wise, with totals.
--
-- The fee was never written down anywhere (only implied by stakes − payouts, in jsonb that the next deal overwrote),
-- so a log is added: table_fees gets one row per settled deal / hand / game from triggers on the game tables —
-- Rummy (status → dealdone: Points deals from the result rows, Pool / Deals matches from stake × players − prize),
-- Teen Patti / Poker (a hand's settlement arriving in `hand`: pot and its rake), Ludo (done: pot − prize), Chess
-- (done: 2 × entry − prize, nothing on a draw). Past Ludo, Chess, Teen Patti and Poker tables are filled in from
-- their rows and per-hand ledgers; past Rummy deals cannot be (nothing was kept), so Rummy starts from now.
-- Rummy tables also get host / created_at, Teen Patti / Poker tables a host, and Rummy ledger notes name the private
-- table ("Rummy • Points • Private AB12CD • Deal won"), so its transactions can be told apart.

begin;

-- Who made the table and when (Ludo / Chess / Teen Patti / Poker already keep created_at).
alter table public.rm_tables add column if not exists host uuid references public.profiles (id) on delete set null;
alter table public.rm_tables add column if not exists created_at timestamptz not null default now();
update public.rm_tables set created_at = updated_at where created_at > updated_at;
alter table public.tp2_tables add column if not exists host uuid references public.profiles (id) on delete set null;
alter table public.pk_tables add column if not exists host uuid references public.profiles (id) on delete set null;
-- Existing private tables: the first human in the seats (still an account) is as close as it gets.
update public.tp2_tables t set host = (select (s ->> 'playerId')::uuid from jsonb_array_elements(t.seats) s where not coalesce((s ->> 'bot')::boolean, false) and exists (select 1 from profiles p where p.id = (s ->> 'playerId')::uuid) order by (s ->> 'seat')::int limit 1)
  where code is not null and host is null;
update public.pk_tables t set host = (select (s ->> 'playerId')::uuid from jsonb_array_elements(t.seats) s where not coalesce((s ->> 'bot')::boolean, false) and exists (select 1 from profiles p where p.id = (s ->> 'playerId')::uuid) order by (s ->> 'seat')::int limit 1)
  where code is not null and host is null;

create or replace function public.rm_tables_host()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.host is null then new.host := auth.uid(); end if;
  return new;
end;
$$;
drop trigger if exists rm_tables_host on public.rm_tables;
create trigger rm_tables_host before insert on public.rm_tables for each row execute function public.rm_tables_host();

-- Rummy ledger notes name the private table.
create or replace function public.rm_label(t public.rm_tables) returns text language sql immutable as $$
  select 'Rummy • ' || case t.mode when 'points' then 'Points' when 'pool101' then 'Pool 101' when 'pool201' then 'Pool 201' else 'Deals ×' || t.deals end
         || case when t.code is not null then ' • Private ' || t.code else '' end;
$$;

-- The commission log: one row per settled deal / hand / game, private tables carry their code.
create table if not exists public.table_fees (
  id bigint generated always as identity primary key,
  game text not null check (game in ('rummy', 'rummy21', 'teen-patti', 'poker', 'ludo', 'chess')),
  table_id uuid not null,
  code text,                              -- private tables: the invite code; null for public tables
  host uuid,
  round text not null,                    -- 'Match 2 • Deal 3', 'Hand 12', 'Game'
  stake_in bigint not null default 0,     -- coins the players put in
  paid_out bigint not null default 0,     -- coins paid back to them
  fee bigint not null default 0,          -- kept by the house
  created_at timestamptz not null default now(),
  unique (game, table_id, round)
);
create index if not exists table_fees_created_idx on public.table_fees (created_at desc);
create index if not exists table_fees_code_idx on public.table_fees (code) where code is not null;
alter table public.table_fees enable row level security;
revoke all on public.table_fees from anon, authenticated;

create or replace function public.rm_tables_fee_log()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare r jsonb := new.result; x jsonb; sin numeric := 0; pout numeric := 0; n int; g text := case when new.cards = 21 then 'rummy21' else 'rummy' end;
begin
  if r is null then return new; end if;
  if new.mode = 'points' then
    for x in select * from jsonb_array_elements(coalesce(r -> 'rows', '[]')) loop
      continue when (x ->> 'coins') is null;
      if (x ->> 'coins')::numeric < 0 then sin := sin - (x ->> 'coins')::numeric; else pout := pout + (x ->> 'coins')::numeric; end if;
    end loop;
    if sin > 0 then
      insert into table_fees (game, table_id, code, host, round, stake_in, paid_out, fee)
        values (g, new.id, new.code, new.host, 'Match ' || new.match_no || ' • Deal ' || new.deal_no, sin, pout, sin - pout)
        on conflict do nothing;
    end if;
  elsif coalesce((r ->> 'match_over')::boolean, false) then
    select count(*) into n from jsonb_array_elements(coalesce(r -> 'rows', '[]'));
    if n > 0 then
      insert into table_fees (game, table_id, code, host, round, stake_in, paid_out, fee)
        values (g, new.id, new.code, new.host, 'Match ' || new.match_no, new.stake * n, new.prize, new.stake * n - new.prize)
        on conflict do nothing;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists rm_tables_fee_log on public.rm_tables;
create trigger rm_tables_fee_log after update on public.rm_tables for each row
  when (new.status = 'dealdone' and old.status is distinct from 'dealdone') execute function public.rm_tables_fee_log();

create or replace function public.hand_fee_log()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare pot bigint := coalesce((new.hand ->> 'pot')::bigint, 0); rake bigint := coalesce((new.hand -> 'settlement' ->> 'rake')::bigint, 0);
begin
  if pot > 0 then
    insert into table_fees (game, table_id, code, host, round, stake_in, paid_out, fee)
      values (tg_argv[0], new.id, new.code, new.host, 'Hand ' || coalesce(new.hand ->> 'handNo', new.hand_no::text), pot, pot - rake, rake)
      on conflict do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists tp2_tables_fee_log on public.tp2_tables;
create trigger tp2_tables_fee_log after update of hand on public.tp2_tables for each row
  when (new.hand -> 'settlement' is not null and (old.hand -> 'settlement') is distinct from (new.hand -> 'settlement'))
  execute function public.hand_fee_log('teen-patti');
drop trigger if exists pk_tables_fee_log on public.pk_tables;
create trigger pk_tables_fee_log after update of hand on public.pk_tables for each row
  when (new.hand -> 'settlement' is not null and (old.hand -> 'settlement') is distinct from (new.hand -> 'settlement'))
  execute function public.hand_fee_log('poker');

create or replace function public.ld_tables_fee_log()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into table_fees (game, table_id, code, host, round, stake_in, paid_out, fee)
    values ('ludo', new.id, new.code, (new.seats -> 0 ->> 'uid')::uuid, 'Game', new.pot, new.prize, new.pot - new.prize)
    on conflict do nothing;
  return new;
end;
$$;
drop trigger if exists ld_tables_fee_log on public.ld_tables;
create trigger ld_tables_fee_log after update on public.ld_tables for each row
  when (new.status = 'done' and old.status is distinct from 'done') execute function public.ld_tables_fee_log();

create or replace function public.ch_tables_fee_log()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare pout bigint := case when new.result = 'win' then coalesce(new.prize, 0) else 2 * new.entry end;
begin
  insert into table_fees (game, table_id, code, host, round, stake_in, paid_out, fee)
    values ('chess', new.id, new.code, new.host, 'Game', 2 * new.entry, pout, 2 * new.entry - pout)
    on conflict do nothing;
  return new;
end;
$$;
drop trigger if exists ch_tables_fee_log on public.ch_tables;
create trigger ch_tables_fee_log after update on public.ch_tables for each row
  when (new.status = 'done' and old.status is distinct from 'done') execute function public.ch_tables_fee_log();

-- What already happened: Ludo and Chess from their rows, Teen Patti and Poker private tables from their per-hand
-- ledgers (a hand still being played is left out).
insert into table_fees (game, table_id, code, host, round, stake_in, paid_out, fee, created_at)
  select 'ludo', id, code, (seats -> 0 ->> 'uid')::uuid, 'Game', pot, prize, pot - prize, updated_at from ld_tables where status = 'done'
  on conflict do nothing;
insert into table_fees (game, table_id, code, host, round, stake_in, paid_out, fee, created_at)
  select 'chess', id, code, host, 'Game', 2 * entry, case when result = 'win' then coalesce(prize, 0) else 2 * entry end,
         2 * entry - case when result = 'win' then coalesce(prize, 0) else 2 * entry end, updated_at
  from ch_tables where status = 'done'
  on conflict do nothing;
insert into table_fees (game, table_id, code, host, round, stake_in, paid_out, fee, created_at)
  select 'teen-patti', l.table_id, t.code, t.host, 'Hand ' || split_part(l.hand_id, ':', 2),
         coalesce(-sum(l.amount) filter (where l.amount < 0), 0), coalesce(sum(l.amount) filter (where l.amount > 0), 0), -sum(l.amount), max(l.created_at)
  from tp2_ledger l join tp2_tables t on t.id = l.table_id
  where t.code is not null and not (l.hand_id = t.id || ':' || t.hand_no and coalesce(t.hand ->> 'phase', '') <> 'COMPLETED')
  group by l.table_id, t.code, t.host, l.hand_id
  -- only hands that were paid out and whose lines still add up (a deleted bet leaves a hand that can't be read)
  having bool_or(l.amount > 0) and -sum(l.amount) between 0 and floor(-sum(l.amount) filter (where l.amount < 0) * 0.25)
  on conflict do nothing;
insert into table_fees (game, table_id, code, host, round, stake_in, paid_out, fee, created_at)
  select 'poker', l.table_id, t.code, t.host, 'Hand ' || split_part(l.hand_id, ':', 2),
         coalesce(-sum(l.amount) filter (where l.amount < 0), 0), coalesce(sum(l.amount) filter (where l.amount > 0), 0), -sum(l.amount), max(l.created_at)
  from pk_ledger l join pk_tables t on t.id = l.table_id
  where t.code is not null and not (l.hand_id = t.id || ':' || t.hand_no and coalesce(t.hand ->> 'phase', '') <> 'COMPLETED')
  group by l.table_id, t.code, t.host, l.hand_id
  -- only hands that were paid out and whose lines still add up (a deleted bet leaves a hand that can't be read)
  having bool_or(l.amount > 0) and -sum(l.amount) between 0 and floor(-sum(l.amount) filter (where l.amount < 0) * 0.25)
  on conflict do nothing;

-- ---------------------------------------------------------------------------------------------------------------
-- The three statements. The Super Admin sees every table; an admin / agent the tables made by players under them.

/** Every private table: who made it, when, what it plays, and its commission so far. Tables made in the period,
 *  or with a settled deal / hand in it (a Rummy private table lives on and plays match after match). */
create or replace function public.private_tables_report(p_from timestamptz default null, p_to timestamptz default null)
returns table (game text, table_id uuid, code text, host_id uuid, host_name text, host_code text, created_at timestamptz, status text,
               stake bigint, detail text, players int, rounds bigint, stake_in bigint, paid_out bigint, fee bigint, last_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $$
  with pt as (
    select case when t.cards = 21 then 'rummy21' else 'rummy' end game, t.id, t.code, t.host, t.created_at,
           case t.status when 'waiting' then 'waiting' else 'playing' end status, t.stake::bigint stake,
           case t.mode when 'points' then 'Points • ' || t.stake || '/pt' when 'pool101' then 'Pool 101' when 'pool201' then 'Pool 201' else 'Deals ×' || t.deals end detail,
           cardinality(t.members) players
    from rm_tables t where t.code is not null
    union all
    select 'teen-patti', t.id, t.code, t.host, t.created_at,
           case when exists (select 1 from jsonb_array_elements(t.seats) s where not coalesce((s ->> 'bot')::boolean, false)) then 'playing' else 'idle' end,
           t.boot, 'Boot ' || t.boot, (select count(distinct user_id) from tp2_ledger l where l.table_id = t.id)::int
    from tp2_tables t where t.code is not null
    union all
    select 'poker', t.id, t.code, t.host, t.created_at,
           case when exists (select 1 from jsonb_array_elements(t.seats) s where not coalesce((s ->> 'bot')::boolean, false)) then 'playing' else 'idle' end,
           t.boot, 'Boot ' || t.boot, (select count(distinct user_id) from pk_ledger l where l.table_id = t.id)::int
    from pk_tables t where t.code is not null
    union all
    select 'ludo', t.id, t.code, (t.seats -> 0 ->> 'uid')::uuid, t.created_at, t.status, t.entry, t.max_players || ' players • Entry ' || t.entry, cardinality(t.members)
    from ld_tables t
    union all
    select 'chess', t.id, t.code, t.host, t.created_at, t.status, t.entry, 'Entry ' || t.entry, case when t.guest is null then 1 else 2 end
    from ch_tables t
  ), f as (
    select table_id, count(*) rounds, sum(stake_in) stake_in, sum(paid_out) paid_out, sum(fee) fee, max(created_at) last_at
    from table_fees where code is not null and (p_from is null or created_at >= p_from) and (p_to is null or created_at < p_to)
    group by table_id
  )
  select pt.game, pt.id, pt.code, pt.host, p.name, p.code, pt.created_at, pt.status, pt.stake, pt.detail, pt.players,
         coalesce(f.rounds, 0), coalesce(f.stake_in, 0), coalesce(f.paid_out, 0), coalesce(f.fee, 0), f.last_at
  from pt left join f on f.table_id = pt.id left join profiles p on p.id = pt.host
  where (((p_from is null or pt.created_at >= p_from) and (p_to is null or pt.created_at < p_to)) or f.rounds > 0)
    and (public.is_superadmin() or (pt.host is not null and public.can_manage(pt.host)))
  order by coalesce(f.last_at, pt.created_at) desc;
$$;

/** The commission statement: every settled deal / hand / game of a private table in the period. */
create or replace function public.private_table_fees(p_from timestamptz default null, p_to timestamptz default null)
returns table (id bigint, game text, table_id uuid, code text, host_name text, host_code text, round text, stake_in bigint, paid_out bigint, fee bigint, created_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $$
  select f.id, f.game, f.table_id, f.code, p.name, p.code, f.round, f.stake_in, f.paid_out, f.fee, f.created_at
  from table_fees f left join profiles p on p.id = f.host
  where f.code is not null and (p_from is null or f.created_at >= p_from) and (p_to is null or f.created_at < p_to)
    and (public.is_superadmin() or (f.host is not null and public.can_manage(f.host)))
  order by f.created_at desc;
$$;

/** The transaction statement: every coin movement at a private table in the period. Teen Patti / Poker from their
 *  per-hand ledgers; Ludo / Chess / Rummy from ledger lines that name the table (older Rummy lines, from before this
 *  report, are matched to a table by its members and the time they were written). */
create or replace function public.private_table_txns(p_from timestamptz default null, p_to timestamptz default null)
returns table (game text, code text, table_id uuid, user_id uuid, user_name text, user_code text, kind text, amount bigint, note text, created_at timestamptz)
language sql
stable
security definer
set search_path to 'public'
as $$
  with tx as (
    select 'teen-patti' game, t.code, t.id table_id, t.host, l.user_id, lower(l.kind) kind, l.amount,
           'Hand #' || split_part(l.hand_id, ':', 2) || ' • ' || initcap(replace(l.kind, '_', ' ')) note, l.created_at
    from tp2_ledger l join tp2_tables t on t.id = l.table_id and t.code is not null
    where (p_from is null or l.created_at >= p_from) and (p_to is null or l.created_at < p_to)
    union all
    select 'poker', t.code, t.id, t.host, l.user_id, lower(l.kind), l.amount, 'Hand #' || split_part(l.hand_id, ':', 2) || ' • ' || initcap(replace(l.kind, '_', ' ')), l.created_at
    from pk_ledger l join pk_tables t on t.id = l.table_id and t.code is not null
    where (p_from is null or l.created_at >= p_from) and (p_to is null or l.created_at < p_to)
    union all
    select 'ludo', t.code, t.id, (t.seats -> 0 ->> 'uid')::uuid, l.user_id, l.kind, l.amount, l.note, l.created_at
    from ledger l join ld_tables t on t.code = substring(l.note from '^Ludo • (?:Private|Table) ([A-Z0-9]+)')
    where l.note like 'Ludo • %' and (p_from is null or l.created_at >= p_from) and (p_to is null or l.created_at < p_to)
    union all
    select 'chess', t.code, t.id, t.host, l.user_id, l.kind, l.amount, l.note, l.created_at
    from ledger l join ch_tables t on t.code = substring(l.note from '^Chess • Private ([A-Z0-9]+)')
      and l.created_at between t.created_at - interval '1 minute' and t.updated_at + interval '1 minute'
    where l.note like 'Chess • %' and (p_from is null or l.created_at >= p_from) and (p_to is null or l.created_at < p_to)
    union all
    select case when t.cards = 21 then 'rummy21' else 'rummy' end, t.code, t.id, t.host, l.user_id, l.kind, l.amount, l.note, l.created_at
    from ledger l join rm_tables t on t.code is not null
      and (t.code = substring(l.note from '^Rummy • [^•]+ • Private ([A-Z0-9]+)')
           or (l.note not like '%• Private %' and l.user_id = any (t.members) and l.created_at between t.created_at - interval '1 minute' and t.updated_at + interval '1 minute'))
    where l.note like 'Rummy • %' and (p_from is null or l.created_at >= p_from) and (p_to is null or l.created_at < p_to)
  )
  select r.game, r.code, r.table_id, r.user_id, p.name, p.code, r.kind, r.amount, r.note, r.created_at
  from tx r left join profiles p on p.id = r.user_id
  where public.is_superadmin() or (r.host is not null and public.can_manage(r.host))
  order by r.created_at desc, r.user_id;
$$;

revoke all on function public.rm_tables_host(), public.rm_tables_fee_log(), public.hand_fee_log(), public.ld_tables_fee_log(), public.ch_tables_fee_log() from public, anon, authenticated;
revoke all on function public.private_tables_report(timestamptz, timestamptz), public.private_table_fees(timestamptz, timestamptz), public.private_table_txns(timestamptz, timestamptz) from public, anon;
grant execute on function public.private_tables_report(timestamptz, timestamptz), public.private_table_fees(timestamptz, timestamptz), public.private_table_txns(timestamptz, timestamptz) to authenticated;

commit;
notify pgrst, 'reload schema';
