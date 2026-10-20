-- 072: Plinko — one ball may pay up to 10,00,000 (was 1,00,000 in 040), so every board takes bigger bets:
--   16 rows / high (1000x): max bet 1,000 (was 100) • 12 rows / high (170x): 5,882 (was 588)
--   16 rows / medium (110x): 9,090 (was 909) • every other board: 10,000.
-- The multipliers shown are still exactly what is paid. Safe to run more than once. Run after 071.

create or replace function public.plinko_max_bet(p_rows int, p_risk text) returns bigint
language sql stable set search_path = public as $$
  select least(10000, floor(1000000 / (select max(m) from unnest(public.plinko_table(p_rows, p_risk)) m)))::bigint;
$$;
