-- 027: Stock Market, a quicker round: 7 s to bet, the market runs 14.4 s (80 ticks of 0.18 s), and the next
-- round opens 3 s after the close (≈ 24 s a round instead of ≈ 34 s). Same price model, same fairness.
-- The app takes the tick length from each round, so it works before and after this runs.
-- Safe to run more than once. Run it in the Supabase SQL Editor (after 023).

create or replace function public.sm_tick(r public.sm_rounds) returns int language sql stable as $$
  select least(80, greatest(0, floor(extract(epoch from (now() - r.starts_at)) / 0.18)::int));
$$;

create or replace function public.sm_round() returns public.sm_rounds
language plpgsql volatile security definer set search_path = public as $$
declare r sm_rounds; p numeric := 1; s numeric; v_path numeric[] := array[1.0]; i int;
begin
  perform pg_advisory_xact_lock(7788023);
  select * into r from sm_rounds order by id desc limit 1;
  if r.id is null or now() > r.ends_at + interval '3 seconds' then
    for i in 1..80 loop
      s := 0.035 * (0.3 + 1.4 * random());
      if random() < 0.08 then s := s * 2.5; end if;   -- the odd sharp move
      s := least(s, 0.5 * p, 0.5 * (2 - p));           -- never reaches 0 or 2, still fair
      if random() < 0.5 then p := p + s; else p := p - s; end if;
      v_path := v_path || round(p, 4);
    end loop;
    insert into sm_rounds (starts_at, ends_at, path)
      values (now() + interval '7 seconds', now() + interval '21.4 seconds', v_path)
      returning * into r;
  end if;
  return r;
end;
$$;
