-- 104: Rummy / 21 Card Rummy private tables — the host starts the game.
--
-- A private table used to deal 15 s after each join once two players were in, so the host could not wait for the
-- rest of their friends. Now it waits until the host taps Start (any time two or more are in), or deals by itself
-- 5 s after the table fills (6 players). The host is the first player in (seats, then the waiting list) who has not
-- left, so if the host leaves the next one takes over. Public tables are unchanged (3 s after a join).

create or replace function public.rm_join_wait(t rm_tables)
returns interval
language sql
immutable
as $$
  select case
    when t.code is null then interval '3 seconds'
    when (select count(*) from jsonb_array_elements(t.seats || t.queue) x
          where not coalesce((x ->> 'bot')::boolean, false) and not coalesce((x ->> 'left')::boolean, false)) >= 6 then interval '5 seconds'
    else null -- waits for the host
  end;
$$;

create or replace function public.rm_host(t rm_tables)
returns uuid
language sql
stable
as $$
  select (x ->> 'uid')::uuid from jsonb_array_elements(t.seats || t.queue) with ordinality y(x, i)
  where x ->> 'uid' is not null and not coalesce((x ->> 'bot')::boolean, false) and not coalesce((x ->> 'left')::boolean, false)
  order by i limit 1;
$$;

create or replace function public.rm_host_start(p_table uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare t rm_tables; n int;
begin
  select * into t from rm_tables where id = p_table for update;
  if not found then raise exception 'Table not found'; end if;
  if t.code is null then raise exception 'Only a private table is started by its host'; end if;
  if public.rm_host(t) is distinct from auth.uid() then raise exception 'Only the host can start the game'; end if;
  if t.status <> 'waiting' then return public.rm_view(t); end if;
  select count(*) into n from jsonb_array_elements(t.seats || t.queue) x
    where not coalesce((x ->> 'bot')::boolean, false) and not coalesce((x ->> 'left')::boolean, false);
  if n < 2 then raise exception 'Wait for at least one friend to join'; end if;
  t.next_at := now();
  t := public.rm_advance(t);
  perform public.rm_save(t);
  return public.rm_view(t);
end;
$$;
revoke all on function public.rm_host_start(uuid) from public, anon;
grant execute on function public.rm_host_start(uuid) to authenticated;

-- Private tables waiting right now stop their countdown and wait for their host (unless already full).
update rm_tables set next_at = now() + public.rm_join_wait(rm_tables)
where code is not null and status = 'waiting' and next_at is not null;

CREATE OR REPLACE FUNCTION public.rm_view(t rm_tables)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare me int; my_cards jsonb; my_groups jsonb; p rm_private;
begin
  select i - 1 into me from jsonb_array_elements(t.seats) with ordinality x(v, i) where v ->> 'uid' = auth.uid()::text;
  if me is not null and t.status <> 'waiting' then
    select h.cards, h.groups into my_cards, my_groups from rm_hands h where h.table_id = t.id and h.seat = me;
  end if;
  if t.status <> 'waiting' then select * into p from rm_private where table_id = t.id; end if;
  return jsonb_build_object(
    'id', t.id, 'cards', t.cards, 'mode', t.mode, 'stake', t.stake, 'deals', t.deals, 'code', t.code, 'status', t.status, 'match_no', t.match_no,
    'deal_no', t.deal_no, 'round', t.round, 'turn', t.turn, 'phase', t.phase, 'turn_ends', t.turn_ends, 'next_at', t.next_at,
    'wild', t.wild, 'open_top', t.open_top, 'stock_count', t.stock_count, 'prize', t.prize, 'match_over', t.match_over,
    'result', t.result, 'seats', t.seats,
    'queued', exists (select 1 from jsonb_array_elements(t.queue) q where q ->> 'uid' = auth.uid()::text),
    -- Private tables: who is in before the first deal (the host first) and whether you are the host.
    'lobby', case when t.status = 'waiting' then (select coalesce(jsonb_agg(jsonb_build_object('name', x ->> 'name', 'emoji', x ->> 'emoji', 'me', x ->> 'uid' = auth.uid()::text) order by i), '[]')
               from jsonb_array_elements(t.seats || t.queue) with ordinality y(x, i)
               where not coalesce((x ->> 'bot')::boolean, false) and not coalesce((x ->> 'left')::boolean, false)) end,
    'host_me', t.code is not null and public.rm_host(t) = auth.uid(),
    'me', me, 'my_cards', my_cards, 'my_groups', my_groups,
    'due_at', case when t.status = 'playing' then least(coalesce(t.bot_acts_at, t.turn_ends), t.turn_ends) else t.next_at end,
    'turn_secs', coalesce((public.game_cfg('rummy') ->> 'turn')::int, 30),
    -- Public table information: the open pile (top first) and this deal's moves.
    'discards', coalesce((select jsonb_agg(c order by i) from jsonb_array_elements(p.open) with ordinality x(c, i) where i <= 60), '[]'),
    'log', coalesce((select jsonb_agg(e order by i) from jsonb_array_elements(p.log) with ordinality x(e, i) where (e ->> 'd')::int = t.deal_no), '[]'),
    'open_joker_ok', t.status = 'playing' and public.rm_untouched(t),
    'server_now', now());
end;
$function$;

notify pgrst, 'reload schema';
