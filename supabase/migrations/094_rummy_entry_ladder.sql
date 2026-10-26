-- 094: Rummy Pool 101 / Pool 201 / Deals — entries 5, 10, 25 ... 2,500; 5,000 and 10,000 retired (13 and 21 cards).
--
-- Safe to run more than once.

begin;

create or replace function public.rm_valid_stake(p_mode text, p_stake numeric, p_deals int) returns boolean
language sql immutable as $$
  select case when p_mode = 'points' then p_stake in (0.25, 0.5, 1, 2, 5, 10, 20, 50)
              when p_mode in ('pool101', 'pool201') then p_stake in (5, 10, 25, 50, 100, 250, 500, 1000, 2500)
              when p_mode = 'deals' then p_stake in (5, 10, 25, 50, 100, 250, 500, 1000, 2500) and p_deals in (2, 3)
              else false end;
$$;

revoke execute on function public.rm_valid_stake(text, numeric, int) from public, anon;
grant execute on function public.rm_valid_stake(text, numeric, int) to authenticated;

commit;
