-- 090: Admin console — players whose net winnings have reached 2× / 3× what they deposited.
--
-- win_alerts(p_days): for every player who received coins in the period (transfer_in from an agent, or coins
-- minted straight to them) and whose game result in the same period — wins + refunds − bets — is at least twice
-- that, one row with the figures. p_days = 0 means all time. Called by /api/win-alerts with the service role,
-- which applies the caller's downline; never callable from the app directly.
--
-- Safe to run more than once.

begin;

create or replace function public.win_alerts(p_days int default 7) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'code', p.code, 'name', p.name, 'username', p.username, 'parent_id', p.parent_id,
           'deposits', l.dep, 'bets', l.bets, 'wins', l.wins, 'refunds', l.refunds, 'net', l.net,
           'multiple', round(l.net::numeric / l.dep, 2), 'balance', w.coins, 'lastWinAt', l.last_win)
         order by l.net::numeric / l.dep desc), '[]')
  from (
    select user_id,
           coalesce(sum(amount) filter (where kind in ('transfer_in', 'mint')), 0) dep,
           coalesce(-sum(amount) filter (where kind = 'bet'), 0) bets,
           coalesce(sum(amount) filter (where kind = 'win'), 0) wins,
           coalesce(sum(amount) filter (where kind = 'refund'), 0) refunds,
           coalesce(sum(amount) filter (where kind = 'win'), 0) + coalesce(sum(amount) filter (where kind = 'refund'), 0)
             - coalesce(-sum(amount) filter (where kind = 'bet'), 0) net,
           max(created_at) filter (where kind = 'win') last_win
    from ledger
    where p_days <= 0 or created_at > now() - make_interval(days => p_days)
    group by user_id
  ) l
  join profiles p on p.id = l.user_id and p.role = 'player'
  join wallets w on w.user_id = p.id
  where l.dep > 0 and l.net >= 2 * l.dep;
$$;

revoke execute on function public.win_alerts(int) from public, anon, authenticated;

commit;
