-- 105: Ludo with friends — the host can start a 4-player table before it fills.
--
-- A private table started only when every seat was taken. Now the host (the player who made the table, seat 0) can
-- start it with 2 or 3 players in; the pot is the entries paid so far. Two players get opposite yards (colours 0 and
-- 2, as on a 1 vs 1 table), three get 0, 1, 2. A table still starts by itself when it fills, as before.

create or replace function public.ld_host_start(p_table uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare t ld_tables; n int; colours int[];
begin
  select * into t from ld_tables where id = p_table for update;
  if t.id is null then raise exception 'Table not found'; end if;
  if (t.seats -> 0 ->> 'uid') is distinct from auth.uid()::text then raise exception 'Only the host can start the game'; end if;
  if t.status <> 'waiting' then return public.ld_view(t); end if;
  n := jsonb_array_length(t.seats);
  if n < 2 then raise exception 'Wait for at least one friend to join'; end if;
  colours := case when n = 2 then array[0, 2] else array[0, 1, 2, 3] end;
  t.seats := (select jsonb_agg(e || jsonb_build_object('colour', colours[i]) order by i) from jsonb_array_elements(t.seats) with ordinality x(e, i));
  t.status := 'playing';
  t.turn := floor(random() * n)::int; -- who starts is drawn at random
  t.phase := 'roll'; t.dice := null; t.sixes := 0;
  t.turn_ends := now() + interval '23 seconds';
  t.last := jsonb_build_object('kind', 'start', 'seat', t.turn);
  perform public.ld_save(t);
  return public.ld_view(t);
end;
$$;
revoke all on function public.ld_host_start(uuid) from public, anon;
grant execute on function public.ld_host_start(uuid) to authenticated;
notify pgrst, 'reload schema';
