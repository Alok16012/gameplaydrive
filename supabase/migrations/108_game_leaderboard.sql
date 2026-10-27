-- 108: Leaderboard for the card tables (Teen Patti, Poker, Rummy / 21 Card Rummy): today's biggest winners at that
-- game (India time), by net coins won (wins and refunds less stakes, from the ledger), top 10 with first names only,
-- plus where the caller stands.

create or replace function public.game_leaderboard(p_game text)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with day as (select (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata') s),
  nets as (
    select l.user_id, sum(l.amount) net
    from ledger l, day
    where p_game in ('Teen Patti', 'Poker', 'Rummy')
      and l.created_at >= day.s and l.kind in ('bet', 'win', 'refund')
      and split_part(l.note, ' • ', 1) = p_game
    group by l.user_id),
  ranked as (select n.user_id, n.net, rank() over (order by n.net desc) r from nets n)
  select jsonb_build_object(
    'top', coalesce((select jsonb_agg(jsonb_build_object('rank', x.r, 'name', split_part(p.name, ' ', 1), 'net', x.net, 'me', p.id = auth.uid()) order by x.r)
                     from (select * from ranked order by r limit 10) x join profiles p on p.id = x.user_id), '[]'),
    'me', (select jsonb_build_object('rank', r, 'net', net) from ranked where user_id = auth.uid()),
    'players', (select count(*) from nets));
$$;
revoke all on function public.game_leaderboard(text) from public, anon;
grant execute on function public.game_leaderboard(text) to authenticated;
notify pgrst, 'reload schema';
