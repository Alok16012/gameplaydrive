-- 070: Online Poker (Texas Hold'em) — storage for the TypeScript engine in app/lib/poker, in the same shape as
-- Classic Teen Patti (066). The server (Next.js API, service role) deals, runs the clocks, plays the bots and
-- settles; this migration gives it a row per table, an exactly-once ledger and one atomic commit function.
-- Private tables (friends only, joined by a 6-character code) and public tables (with bots) share the same table.
-- Players never touch these tables directly. Safe to run more than once. Run after 069 in the Supabase SQL Editor.

create table if not exists public.pk_tables (
  id uuid primary key default gen_random_uuid(),
  code text unique,                       -- private tables only
  boot bigint not null,
  rules jsonb not null,                   -- snapshot of the table rules (see app/lib/poker/engine.ts Rules)
  seats jsonb not null default '[]',      -- [{seat, playerId, name, emoji, bot, bal, lastSeen}]
  dealer_seat int,
  hand_no int not null default 0,
  hand jsonb,                             -- the current / last HandState, private cards included
  next_hand_at timestamptz,
  version bigint not null default 1,      -- compare-and-swap token for pk_commit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pk_tables_public_idx on public.pk_tables (boot, updated_at desc) where code is null;

-- Every coin movement of every hand, once. (hand_id, key) is unique so a retried commit can never pay twice.
create table if not exists public.pk_ledger (
  id bigint generated always as identity primary key,
  table_id uuid not null references public.pk_tables (id) on delete cascade,
  hand_id text not null,
  key text not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,                     -- BOOT | BET | PAYOUT | REFUND
  amount bigint not null,                 -- negative: into the pot; positive: out of it
  created_at timestamptz not null default now(),
  unique (hand_id, key)
);
create index if not exists pk_ledger_user_idx on public.pk_ledger (user_id, created_at desc);

alter table public.pk_tables enable row level security;
alter table public.pk_ledger enable row level security;
revoke all on public.pk_tables, public.pk_ledger from anon, authenticated;

-- Poker bets inside a running hand are never blocked by the per-bet admin limits (like Teen Patti and Rummy, the
-- boot is checked when the player joins a table). Same function as 018 with 'poker' added to the list.
create or replace function public.wallet_move(p_uid uuid, p_amount bigint, p_kind text, p_note text) returns bigint
language plpgsql security definer set search_path = public as $$
declare bal bigint; g text;
begin
  if p_amount = 0 then select coins into bal from wallets where user_id = p_uid; return bal; end if;
  if p_kind = 'bet' and p_amount < 0 then
    g := public.game_key(p_note);
    if g not in ('teen patti', 'rummy', 'poker') then
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

-- Atomic commit: under the row lock, check the version, apply every new ledger entry to the players' wallets
-- (skipping entries already applied) and save the table patch. Any failure rolls the whole thing back.
-- p_patch keys (all optional): seats, dealerSeat, handNo, hand, nextHandAt.
-- p_ledger: [{handId, handNo, key, playerId, kind, amount}] for human players only.
create or replace function public.pk_commit(p_table uuid, p_expected bigint, p_patch jsonb, p_ledger jsonb)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  t pk_tables;
  e jsonb;
  bal bigint;
  amt bigint;
  wkind text;
  note text;
begin
  select * into t from pk_tables where id = p_table for update;
  if not found then raise exception 'PK_NOT_FOUND'; end if;
  if t.version <> p_expected then raise exception 'PK_STALE'; end if;

  for e in select * from jsonb_array_elements(coalesce(p_ledger, '[]')) loop
    insert into pk_ledger (table_id, hand_id, key, user_id, kind, amount)
      values (p_table, e ->> 'handId', e ->> 'key', (e ->> 'playerId')::uuid, e ->> 'kind', (e ->> 'amount')::bigint)
      on conflict (hand_id, key) do nothing;
    if found then
      amt := (e ->> 'amount')::bigint;
      wkind := case when amt > 0 then (case e ->> 'kind' when 'REFUND' then 'refund' else 'win' end) else 'bet' end;
      note := 'Poker • Hand #' || (e ->> 'handNo') ||
              case e ->> 'kind' when 'BOOT' then ' • Boot' when 'PAYOUT' then ' • Won' when 'REFUND' then ' • Refund' else '' end;
      bal := public.wallet_move((e ->> 'playerId')::uuid, amt, wkind, note);
      if bal is null then raise exception 'PK_INSUFFICIENT:%', e ->> 'playerId'; end if;
    end if;
  end loop;

  update pk_tables set
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
revoke execute on function public.pk_commit(uuid, bigint, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.pk_commit(uuid, bigint, jsonb, jsonb) to service_role;

-- Admin → Game Config: the turn time can now be set for Poker as well (the Poker server reads game_cfg('poker') ->> 'turn').
-- Same function as 037 with 'poker' added to the turn list.
create or replace function public.set_game_settings(p_game text, p_cfg jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare old jsonb := public.game_cfg(p_game); new jsonb := public.game_cfg(p_game); k text; v jsonb; n numeric;
        games text[] := array['teen-patti','rummy','andar-bahar','dragon-tiger','lucky-7','aviator','roulette','plinko','blackjack','poker','ludo','carrom','chess','stock-market','cricket'];
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
      if p_game not in ('teen-patti', 'rummy', 'poker') then continue; end if;
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
    elsif k = 'outcome_mode' then
      if v #>> '{}' not in ('fair', 'force_win', 'force_loss') then raise exception 'outcome_mode must be fair, force_win or force_loss'; end if;
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
