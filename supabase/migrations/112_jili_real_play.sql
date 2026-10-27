-- 112: JILI with coins (iGaming SoftAPI, seamless). 1 coin = ₹1 (play currency INR).
--
-- The app launches a game with the player's coin balance (/api/jili/launch → our VPS proxy → SoftAPI). SoftAPI keeps
-- the in-game balance and, after every round, POSTs a settle notice to /api/jili/callback; jili_settle writes it to
-- the ledger — the stake as a bet line, the win as a win line ("JILI • <game> • Round #<id>"), so it shows in Game
-- History and every report — and moves the coins. serial_number makes every notice count once. SoftAPI needs a
-- whole-number player id, so each player gets one in jili_players. Amounts below a coin are carried, never lost.
-- The bet already happened in the game, so no bet limits are checked here (they are checked at launch); if the
-- wallet can't cover a stake (coins spent elsewhere meanwhile) it goes to 0 and the shortfall is recorded.

create table if not exists public.jili_players (
  num bigint generated always as identity (start with 100001) primary key,
  user_id uuid not null unique references public.profiles (id) on delete cascade,
  carry numeric not null default 0, -- fraction of a coin not yet applied
  created_at timestamptz not null default now()
);

create table if not exists public.jili_tx (
  serial text primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  game_uid text, game_name text, game_round text,
  bet numeric not null default 0, win numeric not null default 0, credit numeric,
  coins_change bigint not null default 0, shortfall bigint not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists jili_tx_user_idx on public.jili_tx (user_id, created_at desc);
alter table public.jili_players enable row level security;
alter table public.jili_tx enable row level security;
revoke all on public.jili_players, public.jili_tx from anon, authenticated;

/** The player's SoftAPI id (created on first use). Server only. */
create or replace function public.jili_player_num(p_user uuid)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $$
declare n bigint;
begin
  select num into n from jili_players where user_id = p_user;
  if n is null then
    insert into jili_players (user_id) values (p_user) on conflict (user_id) do nothing;
    select num into n from jili_players where user_id = p_user;
  end if;
  return n;
end;
$$;

/** One settle notice from SoftAPI. Server only (called with the service key from /api/jili/callback). */
create or replace function public.jili_settle(p_serial text, p_member bigint, p_game_uid text, p_game_name text, p_round text,
                                              p_bet numeric, p_win numeric, p_credit numeric)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  uid uuid; c numeric; total numeric; b bigint; w bigint; bal bigint; short bigint := 0; note text; rid text;
begin
  if p_serial is null or p_serial = '' then raise exception 'serial_number missing'; end if;
  if exists (select 1 from jili_tx where serial = p_serial) then return jsonb_build_object('duplicate', true); end if;
  select user_id, carry into uid, c from jili_players where num = p_member for update;
  if uid is null then raise exception 'unknown member %', p_member; end if;
  p_bet := greatest(coalesce(p_bet, 0), 0); p_win := greatest(coalesce(p_win, 0), 0);

  -- Whole coins only: the stake rounded up, the win making up the exact net, the fraction carried to next time.
  total := p_win - p_bet + c;
  b := ceil(p_bet)::bigint;
  w := (floor(total) + b)::bigint;
  update jili_players set carry = total - floor(total) where num = p_member;

  rid := coalesce(nullif(regexp_replace(coalesce(p_round, ''), '[^0-9]', '', 'g'), ''), regexp_replace(p_serial, '[^0-9]', '', 'g'));
  note := 'JILI • ' || coalesce(nullif(trim(p_game_name), ''), 'Game ' || coalesce(p_game_uid, '')) || ' • Round #' || coalesce(nullif(rid, ''), '0');

  if b > 0 then
    update wallets set coins = coins - b, updated_at = now() where user_id = uid and coins >= b returning coins into bal;
    if bal is null then -- not enough coins left: take what is there, note the rest
      select coins into bal from wallets where user_id = uid for update;
      short := b - bal;
      update wallets set coins = 0, updated_at = now() where user_id = uid;
      b := bal; bal := 0;
    end if;
    if b > 0 then insert into ledger (user_id, amount, balance_after, kind, note) values (uid, -b, bal, 'bet', note || ' • Bet'); end if;
  end if;
  if w > 0 then
    update wallets set coins = coins + w, updated_at = now() where user_id = uid returning coins into bal;
    insert into ledger (user_id, amount, balance_after, kind, note) values (uid, w, bal, 'win', note || ' • Win');
  end if;

  insert into jili_tx (serial, user_id, game_uid, game_name, game_round, bet, win, credit, coins_change, shortfall)
  values (p_serial, uid, p_game_uid, p_game_name, p_round, p_bet, p_win, p_credit, w - b, short);
  select coins into bal from wallets where user_id = uid;
  return jsonb_build_object('ok', true, 'balance', bal, 'coins_change', w - b, 'shortfall', short);
end;
$$;

revoke all on function public.jili_player_num(uuid) from public, anon, authenticated;
revoke all on function public.jili_settle(text, bigint, text, text, text, numeric, numeric, numeric) from public, anon, authenticated;
notify pgrst, 'reload schema';
