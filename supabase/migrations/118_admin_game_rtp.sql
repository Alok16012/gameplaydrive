-- 118: Admin → RTP: what each game actually paid back over a period (coins staked vs coins paid back as wins and
-- refunds, from the ledger), next to the RTP / fee the Super Admin has set. Super Admin only.

create or replace function public.admin_game_rtp(p_from timestamptz default now() - interval '30 days', p_to timestamptz default null)
returns table (game text, stakes bigint, returns bigint, bets bigint, players bigint)
language sql
stable
security definer
set search_path to 'public'
as $$
  select public.game_lock_id(public.game_key(note)) game,
         coalesce(-sum(amount) filter (where kind = 'bet'), 0)::bigint stakes,
         coalesce(sum(amount) filter (where kind in ('win', 'refund')), 0)::bigint returns,
         count(*) filter (where kind = 'bet') bets,
         count(distinct user_id) players
  from ledger
  where public.is_superadmin() and kind in ('bet', 'win', 'refund')
    and created_at >= p_from and (p_to is null or created_at < p_to)
  group by 1
  order by 2 desc;
$$;
revoke all on function public.admin_game_rtp(timestamptz, timestamptz) from public, anon;
grant execute on function public.admin_game_rtp(timestamptz, timestamptz) to authenticated;
notify pgrst, 'reload schema';
