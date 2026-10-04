-- 017: Payouts for games played in the browser (Ludo, Carrom, Chess, Poker) are tied to real stakes.
--
-- Before: game_payout only checked "paid in the last 30 min <= 100 x staked", so a player could stake 10 coins
-- and pay themselves up to 1,000. Now every game_bet is recorded per game, and a payout:
--   • needs open (unpaid) stakes for the same game — the game is the part of the note before the first "•";
--   • can be at most those stakes x the game's best possible return (Ludo 3.6, Carrom 1.8, Chess 1.8,
--     Poker / Teen Patti 6, anything else 2); a refund at most the stakes themselves;
--   • closes those stakes, so one stake pays out once.
-- Starting a new game (an "Entry", "Boot" or "Buy-in" bet) closes the player's older open stakes for that game.
-- Server-run games (Teen Patti, Rummy, casino, Aviator, Roulette, Plinko, Blackjack) don't use these functions.
-- Safe to run more than once. Run it in the Supabase SQL Editor.

create table if not exists public.game_stakes (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  game text not null,
  amount bigint not null check (amount > 0),
  settled boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists game_stakes_open_idx on public.game_stakes (user_id, game) where not settled;
alter table public.game_stakes enable row level security;
revoke all on public.game_stakes from anon, authenticated;

create or replace function public.game_key(p_note text) returns text language sql immutable as $$
  select lower(trim(split_part(coalesce(p_note, ''), '•', 1)));
$$;

create or replace function public.game_max_mult(g text) returns numeric language sql immutable as $$
  select case g when 'ludo' then 3.6 when 'carrom' then 1.8 when 'chess' then 1.8 when 'poker' then 6 when 'teen patti' then 6 else 2 end;
$$;

create or replace function public.game_bet(amount bigint, p_note text) returns bigint
language plpgsql security definer set search_path = public as $$
declare me profiles := public.current_profile(); bal bigint; g text := public.game_key(p_note);
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if amount <= 0 or amount > 1000000 then raise exception 'Invalid amount'; end if;
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

create or replace function public.game_payout(amount bigint, p_note text, p_kind text default 'win') returns bigint
language plpgsql security definer set search_path = public as $$
declare me profiles := public.current_profile(); bal bigint; g text := public.game_key(p_note); open bigint; cap bigint;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if amount <= 0 or p_kind not in ('win', 'refund') then raise exception 'Invalid payout'; end if;
  perform 1 from game_stakes where user_id = me.id and game = g and not settled for update;
  select coalesce(sum(s.amount), 0) into open from game_stakes s
    where s.user_id = me.id and s.game = g and not s.settled and s.created_at > now() - interval '3 hours';
  cap := case when p_kind = 'refund' then open else floor(open * public.game_max_mult(g)) end;
  if open = 0 or amount > cap then raise exception 'Payout rejected'; end if;
  update game_stakes set settled = true where user_id = me.id and game = g and not settled;
  update wallets set coins = coins + amount, updated_at = now() where user_id = me.id returning coins into bal;
  insert into ledger (user_id, amount, balance_after, kind, note) values (me.id, amount, bal, p_kind, p_note);
  return bal;
end;
$$;

revoke execute on function public.game_key(text), public.game_max_mult(text) from public, anon, authenticated;
revoke execute on function public.game_bet(bigint, text), public.game_payout(bigint, text, text) from public, anon;
grant execute on function public.game_bet(bigint, text), public.game_payout(bigint, text, text) to authenticated;
