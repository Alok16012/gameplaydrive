-- 121: 9Wickets (iGaming SoftAPI brand 141, game 11539, symbol 9W) — a transfer-wallet sportsbook on its own SoftAPI
-- account (NINE_TOKEN / NINE_SECRET). Unlike JILI / Matka there is no per-bet callback: the player moves coins into
-- the 9Wickets wallet (a session), bets inside the sportsbook, and takes what is left back out (cash out). Each
-- session is one Game History row: the transfer in as the stake ("9Wickets • Session #N • Transfer in"), the cash
-- out as the payout ("… • Cash out"). Server only (service key from /api/nine/*).

begin;

create table if not exists public.nw_sessions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  coins_in bigint not null,                 -- coins moved into 9Wickets at launch
  coins_out bigint,                         -- coins brought back at cash out
  session_id text,                          -- SoftAPI session id
  status text not null default 'starting' check (status in ('starting', 'open', 'closed', 'cancelled')),
  launched_at timestamptz not null default now(),
  closed_at timestamptz,
  note text
);
create index if not exists nw_sessions_user_idx on public.nw_sessions (user_id, launched_at desc);
alter table public.nw_sessions enable row level security;
revoke all on public.nw_sessions from anon, authenticated;

/** The player's open session, if any (one at a time). */
create or replace function public.nw_open(p_user uuid)
returns public.nw_sessions
language sql
stable
security definer
set search_path to 'public'
as $$
  select * from nw_sessions where user_id = p_user and status in ('starting', 'open') order by id desc limit 1;
$$;

/** Take coins out of the wallet for a new session (before the SoftAPI credit + launch). Refused when the game is
 *  closed or locked for the player (ledger trigger), or a session is already open. */
create or replace function public.nw_start(p_user uuid, p_coins bigint)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $$
declare sid bigint; bal bigint;
begin
  if p_coins < 10 then raise exception 'Take at least 10 coins into 9Wickets'; end if;
  if exists (select 1 from nw_sessions where user_id = p_user and status in ('starting', 'open')) then
    raise exception 'A 9Wickets session is already open — cash it out first';
  end if;
  perform public.game_guard('9wickets', p_coins, true);
  perform public.player_game_guard(p_user, '9wickets');
  perform public.check_bet_room(p_user, p_coins);
  insert into nw_sessions (user_id, coins_in) values (p_user, p_coins) returning id into sid;
  bal := public.wallet_move(p_user, -p_coins, 'bet', '9Wickets • Session #' || sid || ' • Transfer in');
  if bal is null then raise exception 'Not enough coins'; end if;
  insert into game_stakes (user_id, game, amount, settled) values (p_user, '9wickets', p_coins, true);
  return sid;
end;
$$;

/** The SoftAPI credit + launch went through. */
create or replace function public.nw_opened(p_id bigint, p_session text)
returns void
language sql
security definer
set search_path to 'public'
as $$
  update nw_sessions set status = 'open', session_id = p_session where id = p_id and status = 'starting';
$$;

/** The launch failed: the coins come straight back. */
create or replace function public.nw_cancel(p_id bigint, p_why text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare s nw_sessions;
begin
  select * into s from nw_sessions where id = p_id and status = 'starting' for update;
  if s.id is null then return; end if;
  perform public.wallet_move(s.user_id, s.coins_in, 'refund', '9Wickets • Session #' || s.id || ' • Entry returned');
  update nw_sessions set status = 'cancelled', closed_at = now(), coins_out = coins_in, note = p_why where id = s.id;
end;
$$;

/** Cash out: the coins SoftAPI debited from the 9Wickets wallet come back to the player; the session closes. */
create or replace function public.nw_close(p_id bigint, p_coins bigint)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $$
declare s nw_sessions; bal bigint;
begin
  select * into s from nw_sessions where id = p_id and status in ('starting', 'open') for update;
  if s.id is null then raise exception 'Session already closed'; end if;
  if p_coins > 0 then
    bal := public.wallet_move(s.user_id, p_coins, 'win', '9Wickets • Session #' || s.id || ' • Cash out');
  else
    select coins into bal from wallets where user_id = s.user_id;
  end if;
  update nw_sessions set status = 'closed', closed_at = now(), coins_out = p_coins where id = s.id;
  return bal;
end;
$$;

revoke all on function public.nw_open(uuid), public.nw_start(uuid, bigint), public.nw_opened(bigint, text), public.nw_cancel(bigint, text), public.nw_close(bigint, bigint)
  from public, anon, authenticated;

-- "9wickets" joins the games that can be locked and configured; its transfer line is checked like any bet.
create or replace function public.player_game_guard(p_uid uuid, p_game text)
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare g text := public.game_lock_id(p_game); names jsonb := '{"cricket":"Cricket Live","teen-patti":"Teen Patti","rummy":"Rummy",
  "poker":"Poker","andar-bahar":"Andar Bahar","dragon-tiger":"Dragon Tiger","lucky-7":"Lucky 7","ludo":"Ludo","stock-market":"Stock Market",
  "aviator":"Aviator","roulette":"Roulette","blackjack":"Blackjack","jili":"JILI Games","plinko":"Plinko","chess":"Chess","matka":"Bharat Matka","9wickets":"9Wickets"}';
begin
  if p_uid is not null and exists (select 1 from profiles where id = p_uid and g = any (locked_games)) then
    raise exception '% is locked for your account — please contact your agent', coalesce(names ->> g, initcap(replace(g, '-', ' ')));
  end if;
end;
$$;

CREATE OR REPLACE FUNCTION public.set_game_settings(p_game text, p_cfg jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare old jsonb := public.game_cfg(p_game); new jsonb := public.game_cfg(p_game); k text; v jsonb; n numeric;
        games text[] := array['teen-patti','rummy','andar-bahar','dragon-tiger','lucky-7','aviator','roulette','plinko','blackjack','poker','ludo','carrom','chess','stock-market','cricket','jili','matka','9wickets'];
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
    elsif k = 'rtp' then
      if p_game not in ('dragon-tiger', 'andar-bahar', 'lucky-7', 'aviator', 'roulette', 'plinko', 'blackjack', 'teen-patti', 'rummy', 'poker', 'ludo', 'chess') then continue; end if;
      if v = 'null'::jsonb or v = '""'::jsonb then new := new - k; continue; end if;
      n := (v #>> '{}')::numeric;
      if n < 70 or n > 99 then raise exception 'RTP must be between 70%% and 99%%'; end if;
      new := new || jsonb_build_object(k, round(n, 1));
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
$function$;

CREATE OR REPLACE FUNCTION public.set_player_games(target uuid, p_locked text[])
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  ok text[] := array['cricket','teen-patti','rummy','poker','andar-bahar','dragon-tiger','lucky-7','ludo','stock-market',
                     'aviator','roulette','blackjack','jili','plinko','chess','matka','9wickets'];
  clean text[]; old text[]; who text;
begin
  if not public.can_manage(target) then raise exception 'Not allowed'; end if;
  select coalesce(array_agg(distinct g order by g), '{}') into clean from unnest(coalesce(p_locked, '{}')) g;
  if exists (select 1 from unnest(clean) g where not (g = any (ok))) then raise exception 'Unknown game'; end if;
  select locked_games, initcap(role::text) || ' ' || code into old, who from profiles where id = target;
  if who is null then raise exception 'Account not found'; end if;
  update profiles set locked_games = clean where id = target;
  perform public.write_audit(who || ' • games locked',
    case when cardinality(old) = 0 then 'none' else array_to_string(old, ', ') end,
    case when cardinality(clean) = 0 then 'none' else array_to_string(clean, ', ') end);
  return clean;
end;
$function$;

commit;
notify pgrst, 'reload schema';
