-- 058: a correct rummy declaration is never turned into a wrong show.
-- 049 rejected a declaration as "Wrong show (80)" — dropping the player from the deal — whenever
-- get_outcome_mode() said force_loss. That function is random (about 60% force_loss even in plain fair mode), so
-- most correct declarations were thrown out. Now every declaration is scored on the cards. Win / Loss Control
-- (Force Loss etc.) is unchanged everywhere else, including when the deal is settled (rm_end_deal).
-- Safe to run more than once (also if an earlier version of 058 was run). Run after 049 in the Supabase SQL Editor.

create or replace function public.rm_declare(t public.rm_tables, seat int, card_id int, p_groups jsonb) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  cards jsonb;
  groups jsonb;
  sc jsonb;
  ids int[];
  want int[];
begin
  if t.phase <> 'discard' then raise exception 'Draw a card before declaring'; end if;
  t := public.rm_throw(t, seat, card_id);
  select h.cards into cards from rm_hands h where h.table_id = t.id and h.seat = rm_declare.seat;
  select array_agg((y #>> '{}')::int order by (y #>> '{}')::int) into ids from jsonb_array_elements(coalesce(p_groups, '[]')) g, jsonb_array_elements(g) y;
  select array_agg((c ->> 'id')::int order by (c ->> 'id')::int) into want from jsonb_array_elements(cards) c;
  if ids is distinct from want then raise exception 'Your groups must contain exactly your % cards', t.cards; end if;
  groups := (select jsonb_agg((select jsonb_agg(c) from jsonb_array_elements(cards) c where (c ->> 'id')::int in (select (y #>> '{}')::int from jsonb_array_elements(g) y))) from jsonb_array_elements(p_groups) g);
  update rm_hands set groups = p_groups where table_id = t.id and rm_hands.seat = rm_declare.seat;

  -- Scored as it is for everyone: outcome control (Force Loss) never turns a correct show into a wrong one.
  -- It still applies when the deal is settled (rm_end_deal).
  sc := public.rm_score_groups(groups, public.rm_wk(t));

  -- 21 cards: 3 tunnelas or 8 doubles in hand is a rummy however they are arranged.
  if not (sc ->> 'valid')::boolean and t.cards = 21 and public.rm_special21(cards) is not null then
    update rm_hands set groups = (select jsonb_agg((select jsonb_agg(y -> 'id') from jsonb_array_elements(g) y)) from jsonb_array_elements(public.rm_special21(cards)) g)
      where table_id = t.id and rm_hands.seat = rm_declare.seat;
    sc := '{"valid": true, "points": 0}';
  end if;

  if (sc ->> 'valid')::boolean then
    t.seats := public.rm_seat_set(t.seats, seat, '{"action": "Declared!"}');
    return public.rm_end_deal(t, seat);
  end if;

  -- Wrong declaration: full points (80, or 120 with 21 cards) and out of this deal; the others play on.
  t.seats := public.rm_seat_set(t.seats, seat, '{"wrong": true, "action": "Wrong show"}');
  return public.rm_pass(t, seat);
end;
$$;

-- Helper from the earlier version of this migration, no longer used.
drop function if exists public.rm_targeted_loss(uuid);
