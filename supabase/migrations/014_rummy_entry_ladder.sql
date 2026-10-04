-- 014: New entry ladder for Pool 101, Pool 201 and Deals tables: 50, 100, 250, 500, 1,000, 2,500, 5,000, 10,000.
-- Points tables keep 1 to 100 per point. The old entries (10, 25) stay accepted so an app that hasn't refreshed yet
-- can still sit down. Run after 013. Safe to run more than once.

create or replace function public.rm_valid_stake(p_mode text, p_stake bigint, p_deals int) returns boolean
language sql immutable as $$
  select case when p_mode = 'points' then p_stake in (1, 2, 5, 10, 20, 50, 100)
              when p_mode in ('pool101', 'pool201') then p_stake in (10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000)
              when p_mode = 'deals' then p_stake in (10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000) and p_deals in (2, 3)
              else false end;
$$;
