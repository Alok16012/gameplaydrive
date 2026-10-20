-- 066: Classic Teen Patti (fair play) — storage for the TypeScript engine in app/lib/teenpatti.
-- The server (Next.js API, service role) deals, runs the clocks and settles; this migration only gives it a row
-- per table, an exactly-once ledger and one atomic commit function. Players never touch these tables directly.
-- Safe to run more than once. Run it in the Supabase SQL Editor.

create table if not exists public.tp2_tables (
  id uuid primary key default gen_random_uuid(),
  code text unique,                       -- private tables only
  boot bigint not null,
  rules jsonb not null,                   -- snapshot of the table rules (see engine.ts Rules)
  seats jsonb not null default '[]',      -- [{seat, playerId, name, emoji, bot, bal, lastSeen}]
  dealer_seat int,
  hand_no int not null default 0,
  hand jsonb,                             -- the current / last HandState, private cards included
  next_hand_at timestamptz,
  version bigint not null default 1,      -- compare-and-swap token for tp2_commit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tp2_tables_public_idx on public.tp2_tables (boot, updated_at desc) where code is null;

-- Every coin movement of every hand, once. (hand_id, key) is unique so a retried commit can never pay twice.
create table if not exists public.tp2_ledger (
  id bigint generated always as identity primary key,
  table_id uuid not null references public.tp2_tables (id) on delete cascade,
  hand_id text not null,
  key text not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,                     -- BOOT | BET | SHOW_FEE | SIDESHOW_FEE | PAYOUT | REFUND
  amount bigint not null,                 -- negative: into the pot; positive: out of it
  created_at timestamptz not null default now(),
  unique (hand_id, key)
);
create index if not exists tp2_ledger_user_idx on public.tp2_ledger (user_id, created_at desc);

alter table public.tp2_tables enable row level security;
alter table public.tp2_ledger enable row level security;
revoke all on public.tp2_tables, public.tp2_ledger from anon, authenticated;

-- Atomic commit: under the row lock, check the version, apply every new ledger entry to the players' wallets
-- (skipping entries already applied) and save the table patch. Any failure rolls the whole thing back.
-- p_patch keys (all optional): seats, dealerSeat, handNo, hand, nextHandAt.
-- p_ledger: [{handId, handNo, key, playerId, kind, amount}] for human players only.
create or replace function public.tp2_commit(p_table uuid, p_expected bigint, p_patch jsonb, p_ledger jsonb)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  t tp2_tables;
  e jsonb;
  bal bigint;
  amt bigint;
  wkind text;
  note text;
begin
  select * into t from tp2_tables where id = p_table for update;
  if not found then raise exception 'TP2_NOT_FOUND'; end if;
  if t.version <> p_expected then raise exception 'TP2_STALE'; end if;

  for e in select * from jsonb_array_elements(coalesce(p_ledger, '[]')) loop
    insert into tp2_ledger (table_id, hand_id, key, user_id, kind, amount)
      values (p_table, e ->> 'handId', e ->> 'key', (e ->> 'playerId')::uuid, e ->> 'kind', (e ->> 'amount')::bigint)
      on conflict (hand_id, key) do nothing;
    if found then
      amt := (e ->> 'amount')::bigint;
      wkind := case when amt > 0 then (case e ->> 'kind' when 'REFUND' then 'refund' else 'win' end) else 'bet' end;
      note := 'Teen Patti • Hand #' || (e ->> 'handNo') ||
              case e ->> 'kind' when 'BOOT' then ' • Boot' when 'SHOW_FEE' then ' • Show' when 'SIDESHOW_FEE' then ' • Side show'
                                when 'PAYOUT' then ' • Won' when 'REFUND' then ' • Refund' else '' end;
      bal := public.wallet_move((e ->> 'playerId')::uuid, amt, wkind, note);
      if bal is null then raise exception 'TP2_INSUFFICIENT:%', e ->> 'playerId'; end if;
    end if;
  end loop;

  update tp2_tables set
    seats = coalesce(p_patch -> 'seats', seats),
    dealer_seat = case when p_patch ? 'dealerSeat' then (p_patch ->> 'dealerSeat')::int else dealer_seat end,
    hand_no = coalesce((p_patch ->> 'handNo')::int, hand_no),
    hand = case when p_patch ? 'hand' then nullif(p_patch -> 'hand', 'null'::jsonb) else hand end,
    next_hand_at = case when p_patch ? 'nextHandAt' then (p_patch ->> 'nextHandAt')::timestamptz else next_hand_at end,
    version = version + 1,
    updated_at = now()
  where id = p_table;
  return t.version + 1;
end;
$$;
revoke execute on function public.tp2_commit(uuid, bigint, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.tp2_commit(uuid, bigint, jsonb, jsonb) to service_role;
