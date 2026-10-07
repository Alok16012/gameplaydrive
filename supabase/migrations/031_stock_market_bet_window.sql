-- 031: Stock Market, a longer betting window: 10 s to place bets (the market still runs 14.4 s and the next round
-- opens 3 s after the close). Safe to run more than once. Run after 027.

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
      values (now() + interval '10 seconds', now() + interval '24.4 seconds', v_path)
      returning * into r;
  end if;
  return r;
end;
$$;
