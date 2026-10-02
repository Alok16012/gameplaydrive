-- 008: Teen Patti limits closer to standard tables.
--   • Pot limit raised from boot × 60 to boot × 1024 (the automatic show was kicking in by round 3-4).
--   • Raise is capped so the blind stake never goes above boot × 128 (seen chaal ≤ boot × 256).
-- Safe to run more than once. Run it in the Supabase SQL Editor.

create or replace function public.tp_pass(t public.tp_tables, seat int) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare active int[] := public.tp_active(t.seats); n int := jsonb_array_length(t.seats); nxt int := seat;
begin
  if array_length(active, 1) = 1 then return public.tp_finish(t, active[1], 'Everyone else packed', false); end if;
  if t.pot >= t.boot * 1024 then return public.tp_showdown(t); end if; -- pot limit (boot × 1024): automatic show
  loop
    nxt := (nxt + 1) % n;
    if nxt <= seat and nxt = active[1] then t.round := t.round + 1; end if;
    exit when nxt = any (active);
  end loop;
  return public.tp_set_turn(t, nxt);
end;
$$;

create or replace function public.tp_apply(t public.tp_tables, seat int, action text) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare seen boolean := (t.seats -> seat ->> 'seen')::boolean; amt bigint;
begin
  if action in ('pack', 'timeout') then
    t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('packed', true, 'action', case action when 'pack' then 'Pack' else 'Timed out' end));
  else
    if action = 'raise' then t.stake := least(t.stake * 2, t.boot * 128); end if; -- chaal limit: blind stake ≤ boot × 128
    amt := case when seen then t.stake * 2 else t.stake end;
    t := public.tp_pay(t, seat, amt);
    t.seats := public.tp_seat_set(t.seats, seat, jsonb_build_object('action',
      case action when 'show' then 'Show' when 'raise' then 'Raise ' || amt else (case when seen then 'Chaal ' else 'Blind ' end) || amt end));
    if action = 'show' then
      if array_length(public.tp_active(t.seats), 1) = 1 then return public.tp_finish(t, (public.tp_active(t.seats))[1], 'Everyone else packed', false); end if;
      return public.tp_showdown(t);
    end if;
  end if;
  return public.tp_pass(t, seat);
end;
$$;

revoke execute on function public.tp_pass(public.tp_tables, int) from public, anon, authenticated;
revoke execute on function public.tp_apply(public.tp_tables, int, text) from public, anon, authenticated;
