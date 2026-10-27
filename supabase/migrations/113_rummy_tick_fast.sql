-- 113: Rummy — rm_tick no longer queues and no longer rewrites an unchanged table.
--
-- Every player's screen calls rm_tick when a timer falls due; each call locked the table row, refreshed the caller's
-- ping and rewrote the whole row even when nothing happened. With 4-6 screens at a table the calls lined up behind
-- one another (up to 5-6 s) and every rewrite went out over realtime. Now: if another call is already advancing the
-- table (row locked), this one just returns the table as it stands; the caller's ping is refreshed at most every 15 s;
-- and the row is written only when something changed.

create or replace function public.rm_tick(p_table uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare t rm_tables; old rm_tables; me int;
begin
  select * into t from rm_tables where id = p_table and auth.uid() = any (members) for update skip locked;
  if not found then
    select * into t from rm_tables where id = p_table and auth.uid() = any (members);
    if not found then raise exception 'You are not at this table'; end if;
    return public.rm_view(t); -- someone else is advancing it right now
  end if;
  old := t;
  select i - 1 into me from jsonb_array_elements(t.seats) with ordinality x(v, i)
    where v ->> 'uid' = auth.uid()::text
      and coalesce((v ->> 'ping')::timestamptz, '-infinity'::timestamptz) < now() - interval '15 seconds';
  if me is not null then t.seats := jsonb_set(t.seats, array[me::text, 'ping'], to_jsonb(now())); end if;
  t := public.rm_abandon(t);
  t := public.rm_advance(t);
  if t is distinct from old then perform public.rm_save(t); end if;
  return public.rm_view(t);
end;
$function$;
