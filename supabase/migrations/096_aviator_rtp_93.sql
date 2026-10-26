-- 096: Aviator — every round's crash point from one fixed curve: 93% RTP, 7% house edge.
--
-- The chance a round reaches multiplier M is 0.93 / M (1.50x: 62%, 2x: 46.5%, 5x: 18.6%, 10x: 9.3%, 100x: 0.93%),
-- so cashing out at any target returns 93% of the stake on average. About 7% of rounds bust at once (1.00x),
-- which also takes the edge back from 1.01x auto-cash-out bots. The draw uses cryptographic randomness
-- (pgcrypto), not random().
--
-- Before this the shared round asked get_outcome_mode(null, 'aviator'), which re-rolls force_win / force_loss on
-- every call, so rounds came only from those two hand-tuned ranges (no 1.00x busts, nothing past ~40x) and the
-- return was whatever they happened to add up to. Per-player control in av_bet (a force_loss player's bet pulls
-- that round's crash down) is unchanged.
--
-- Safe to run more than once.

begin;

-- The crash point for a new round: floor(93 / (1 - u)) / 100 with u uniform in [0, 1), at least 1.00x, at most 500x.
create or replace function public.av_crash_point() returns numeric
language plpgsql volatile set search_path = public, extensions as $$
declare u float8;
begin
  u := ('x' || encode(extensions.gen_random_bytes(6), 'hex'))::bit(48)::bigint / 281474976710656.0; -- 48 random bits
  return least(500, greatest(1.00, floor(93.0 / (1 - u)) / 100.0));
end;
$$;

create or replace function public.av_round() returns public.av_rounds
language plpgsql security definer set search_path = public as $$
declare
  r av_rounds;
  c numeric;
begin
  perform pg_advisory_xact_lock(7788001);
  select * into r from av_rounds order by id desc limit 1;
  if r.id is null or now() > r.crash_at + interval '3 seconds' then
    c := public.av_crash_point();
    insert into av_rounds (starts_at, crash, crash_at)
      values (now() + interval '7 seconds', c, now() + interval '7 seconds' + make_interval(secs => ln(c) / 0.1))
      returning * into r;
  end if;
  return r;
end;
$$;

revoke execute on function public.av_crash_point() from public, anon, authenticated;

commit;
