-- 115: Lock or unlock games for one player. The Super Admin (or anyone above the player who can manage them, as for
-- the daily limit) picks the games a player may not play — Admin → Players → the player's details → Games. The app
-- shows those tiles as "Locked" and the server refuses them:
--   • every bet line written to the ledger (Dragon Tiger, Andar Bahar, Lucky 7, Roulette, Plinko, Blackjack, Aviator,
--     Stock Market, Cricket, Ludo / Chess entries) — trigger on ledger;
--   • taking a seat at a Rummy (13 and 21 Card) or Ludo table, or creating / joining a Chess table — triggers on the
--     tables, so a player already in a running deal is not thrown out mid-hand;
--   • Teen Patti, Poker and JILI check player_game_guard() before seating / launching (app/lib/server).
-- profiles.locked_games holds app game ids; "rummy" covers 13 and 21 Card. Every change goes to the audit log.

begin;

alter table public.profiles add column if not exists locked_games text[] not null default '{}';

/** The app game id behind a ledger note's game part ("dragon tiger", "cricket: India v …", "21 card rummy"). */
create or replace function public.game_lock_id(p_key text)
returns text
language sql
immutable
as $$
  select case
    when k like 'cricket%' or k like 'football%' or k like 'tennis%' then 'cricket'
    when k like 'jili%' then 'jili'
    when k like '%rummy%' then 'rummy'
    else replace(k, ' ', '-')
  end
  from (select lower(trim(coalesce(p_key, ''))) k) x;
$$;

/** Refuse when p_game (an app game id or a game name) is locked for this player. */
create or replace function public.player_game_guard(p_uid uuid, p_game text)
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare g text := public.game_lock_id(p_game); names jsonb := '{"cricket":"Cricket Live","teen-patti":"Teen Patti","rummy":"Rummy",
  "poker":"Poker","andar-bahar":"Andar Bahar","dragon-tiger":"Dragon Tiger","lucky-7":"Lucky 7","ludo":"Ludo","stock-market":"Stock Market",
  "aviator":"Aviator","roulette":"Roulette","blackjack":"Blackjack","jili":"JILI Games","plinko":"Plinko","chess":"Chess"}';
begin
  if p_uid is not null and exists (select 1 from profiles where id = p_uid and g = any (locked_games)) then
    raise exception '% is locked for your account — please contact your agent', coalesce(names ->> g, initcap(replace(g, '-', ' ')));
  end if;
end;
$$;

-- Bets: every new stake line in the ledger. Teen Patti / Poker / Rummy lines come from hands already running (their
-- seats are checked instead) and JILI lines settle rounds already played in the game (checked at launch).
create or replace function public.ledger_lock_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare g text;
begin
  if new.kind = 'bet' and new.amount < 0 then
    g := public.game_lock_id(public.game_key(new.note));
    if g not in ('teen-patti', 'poker', 'rummy', 'jili') then perform public.player_game_guard(new.user_id, g); end if;
  end if;
  return new;
end;
$$;
drop trigger if exists ledger_lock_guard on public.ledger;
create trigger ledger_lock_guard before insert on public.ledger for each row execute function public.ledger_lock_guard();

-- Seats: a player newly added to a Rummy / Ludo table's members (TG_ARGV[0] is the game).
create or replace function public.members_lock_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare u uuid;
begin
  for u in select m from unnest(new.members) m
           where tg_op = 'INSERT' or not (m = any (coalesce(old.members, '{}'))) loop
    perform public.player_game_guard(u, tg_argv[0]);
  end loop;
  return new;
end;
$$;
drop trigger if exists rm_tables_lock_guard on public.rm_tables;
create trigger rm_tables_lock_guard before insert or update of members on public.rm_tables
  for each row execute function public.members_lock_guard('rummy');
drop trigger if exists ld_tables_lock_guard on public.ld_tables;
create trigger ld_tables_lock_guard before insert or update of members on public.ld_tables
  for each row execute function public.members_lock_guard('ludo');

-- Chess: the host creating a table, a guest joining one.
create or replace function public.ch_lock_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'INSERT' then perform public.player_game_guard(new.host, 'chess'); end if;
  if new.guest is not null and (tg_op = 'INSERT' or new.guest is distinct from old.guest) then
    perform public.player_game_guard(new.guest, 'chess');
  end if;
  return new;
end;
$$;
drop trigger if exists ch_tables_lock_guard on public.ch_tables;
create trigger ch_tables_lock_guard before insert or update of guest on public.ch_tables
  for each row execute function public.ch_lock_guard();

/** Set the games a player may not play (app game ids; an empty list unlocks everything). */
create or replace function public.set_player_games(target uuid, p_locked text[])
returns text[]
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  ok text[] := array['cricket','teen-patti','rummy','poker','andar-bahar','dragon-tiger','lucky-7','ludo','stock-market',
                     'aviator','roulette','blackjack','jili','plinko','chess'];
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

/** The signed-in player's locked games, for the app to mark those tiles. */
create or replace function public.my_locked_games()
returns text[]
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce((select locked_games from profiles where id = auth.uid()), '{}');
$$;

revoke all on function public.game_lock_id(text), public.player_game_guard(uuid, text), public.ledger_lock_guard(),
  public.members_lock_guard(), public.ch_lock_guard() from public, anon, authenticated;
revoke all on function public.set_player_games(uuid, text[]), public.my_locked_games() from public, anon;
grant execute on function public.set_player_games(uuid, text[]), public.my_locked_games() to authenticated;

commit;
notify pgrst, 'reload schema';
