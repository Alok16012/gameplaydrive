-- 122: Game access for every account, inherited down the hierarchy. locked_games (115) now counts on admins and agents
-- too: a game switched off for an admin is off for every agent and player under them, and an admin / agent can only
-- switch off more for their own downline, never switch back on what is off above them. Set while creating an ID
-- (Admin / Agent / Player form → Game access) and later from the account's details card → Games.
-- Rummy 13 and 21 Card are separate switches now ("rummy", "rummy21"); an existing "rummy" lock covers both.

begin;

update public.profiles set locked_games = array_append(locked_games, 'rummy21')
  where 'rummy' = any (locked_games) and not ('rummy21' = any (locked_games));

/** The app game id behind a game name or ledger note ("dragon tiger", "cricket: India v …", "21 card rummy"). */
create or replace function public.game_lock_id(p_key text)
returns text
language sql
immutable
as $$
  select case
    when k like 'cricket%' or k like 'football%' or k like 'tennis%' then 'cricket'
    when k like 'jili%' then 'jili'
    when k = 'rummy21' or k like '%21%rummy%' then 'rummy21'
    when k like '%rummy%' then 'rummy'
    else replace(k, ' ', '-')
  end
  from (select lower(trim(coalesce(p_key, ''))) k) x;
$$;

/** Games switched off for an account: its own and every account above it (agent → admin → Super Admin). */
create or replace function public.account_locked_games(p_uid uuid)
returns text[]
language sql
stable
security definer
set search_path to 'public'
as $$
  with recursive up as (
    select id, parent_id, locked_games, 0 as depth from profiles where id = p_uid
    union all
    select p.id, p.parent_id, p.locked_games, up.depth + 1 from profiles p join up on p.id = up.parent_id where up.depth < 10
  )
  select coalesce(array_agg(distinct g order by g), '{}') from up, unnest(up.locked_games) g;
$$;

/** For the admin screens: the account's own switched-off games and those switched off above it (which it can't change). */
create or replace function public.game_access_of(p_uid uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare own text[]; parent uuid;
begin
  if not (public.is_superadmin() or p_uid = auth.uid() or public.can_manage(p_uid)) then raise exception 'Not allowed'; end if;
  select locked_games, parent_id into own, parent from profiles where id = p_uid;
  return jsonb_build_object('own', to_jsonb(coalesce(own, '{}')), 'inherited', to_jsonb(case when parent is null then '{}'::text[] else public.account_locked_games(parent) end));
end;
$$;

/** Refuse when p_game is switched off for this player or anyone above them. */
create or replace function public.player_game_guard(p_uid uuid, p_game text)
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare g text := public.game_lock_id(p_game); names jsonb := '{"cricket":"Cricket Live","teen-patti":"Teen Patti","rummy":"Rummy 13 Cards",
  "rummy21":"21 Card Rummy","poker":"Poker","andar-bahar":"Andar Bahar","dragon-tiger":"Dragon Tiger","lucky-7":"Lucky 7","ludo":"Ludo",
  "stock-market":"Stock Market","aviator":"Aviator","roulette":"Roulette","blackjack":"Blackjack","jili":"JILI Games","plinko":"Plinko",
  "chess":"Chess","matka":"Bharat Matka","9wickets":"9Wickets"}';
begin
  if p_uid is not null and g = any (public.account_locked_games(p_uid)) then
    raise exception '% is locked for your account — please contact your agent', coalesce(names ->> g, initcap(replace(g, '-', ' ')));
  end if;
end;
$$;

/** The signed-in player's switched-off games (their own and their upline's), for the app to mark those tiles. */
create or replace function public.my_locked_games()
returns text[]
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.account_locked_games(auth.uid());
$$;

-- Rummy seats: 13 and 21 Card are separate switches.
create or replace function public.rm_members_lock_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare u uuid;
begin
  for u in select m from unnest(new.members) m
           where tg_op = 'INSERT' or not (m = any (coalesce(old.members, '{}'))) loop
    perform public.player_game_guard(u, case when new.cards = 21 then 'rummy21' else 'rummy' end);
  end loop;
  return new;
end;
$$;
drop trigger if exists rm_tables_lock_guard on public.rm_tables;
create trigger rm_tables_lock_guard before insert or update of members on public.rm_tables
  for each row execute function public.rm_members_lock_guard();

/** Set the games switched off for an account (any role). Games already off above it stay off whatever is sent. */
create or replace function public.set_player_games(target uuid, p_locked text[])
returns text[]
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  ok text[] := array['cricket','teen-patti','rummy','rummy21','poker','andar-bahar','dragon-tiger','lucky-7','ludo','stock-market',
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
$$;

revoke all on function public.account_locked_games(uuid), public.rm_members_lock_guard() from public, anon, authenticated;
revoke all on function public.game_access_of(uuid) from public, anon;
grant execute on function public.game_access_of(uuid) to authenticated;

commit;
notify pgrst, 'reload schema';
