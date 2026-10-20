-- 059: lifetime game P&L per account, for the P&L column in the Admin console (read through /api/pl).
-- net = wins + refunds − bets from the ledger, with stakes still riding on open cricket bets added back (they are
-- neither won nor lost yet). Positive: the player is up; negative: the player is down.
-- Server only (service role). Safe to run more than once. Run it in the Supabase SQL Editor.

create or replace function public.game_pl_by_user() returns table (user_id uuid, net bigint)
language sql stable security definer set search_path = public as $$
  select l.user_id,
         (sum(l.amount) + coalesce((select sum(b.exposure) from sport_bets b where b.user_id = l.user_id and b.status = 'OPEN'), 0))::bigint
  from ledger l
  where l.kind in ('bet', 'win', 'refund')
  group by l.user_id;
$$;

revoke execute on function public.game_pl_by_user() from public, anon, authenticated;
grant execute on function public.game_pl_by_user() to service_role;
