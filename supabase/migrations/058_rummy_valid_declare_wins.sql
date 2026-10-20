-- 058: a valid rummy declaration always wins.
-- 049 rejected a declaration as a wrong show whenever get_outcome_mode() returned 'force_loss'. That function is
-- probabilistic: in plain "fair" mode it returns 'force_loss' about 60% of the time (and 85% under a game/global
-- force-loss setting), so most correct declarations were thrown out as "Wrong show (80)".
-- Now only an account the Super Admin targeted by name (player, or its agent / admin) in Win / Loss Control is
-- affected; everyone else's hand is scored as it is.
-- Safe to run more than once. Run after 049. Run it in the Supabase SQL Editor.

-- True when the account, or the nearest account above it with a setting, is set to force_loss in outcome_control
-- (the same direct-target lookup get_outcome_mode starts with, without the random part).
create or replace function public.rm_targeted_loss(p_uid uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  ctrl jsonb;
  m text;
begin
  if p_uid is null then return false; end if;
  select value into ctrl from app_settings where key = 'outcome_control';
  if ctrl is null then return false; end if;
  with recursive up as (
    select id, parent_id, 1 as depth from profiles where id = p_uid
    union all
    select p.id, p.parent_id, up.depth + 1 from profiles p join up on p.id = up.parent_id
  )
  select coalesce(ctrl -> 'players' ->> up.id::text, ctrl -> 'agents' ->> up.id::text,
                  ctrl -> 'admins' ->> up.id::text, ctrl -> 'accounts' ->> up.id::text)
    into m
  from up
  where coalesce(ctrl -> 'players' ->> up.id::text, ctrl -> 'agents' ->> up.id::text,
                 ctrl -> 'admins' ->> up.id::text, ctrl -> 'accounts' ->> up.id::text) in ('force_win', 'force_loss', 'fair')
  order by depth asc
  limit 1;
  return m = 'force_loss';
end;
$$;
revoke execute on function public.rm_targeted_loss(uuid) from public, anon, authenticated;

create or replace function public.rm_declare(t public.rm_tables, seat int, card_id int, p_groups jsonb) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  cards jsonb;
  groups jsonb;
  sc jsonb;
  ids int[];
  want int[];
  p_uid uuid;
begin
  if t.phase <> 'discard' then raise exception 'Draw a card before declaring'; end if;
  t := public.rm_throw(t, seat, card_id);
  select h.cards into cards from rm_hands h where h.table_id = t.id and h.seat = rm_declare.seat;
  select array_agg((y #>> '{}')::int order by (y #>> '{}')::int) into ids from jsonb_array_elements(coalesce(p_groups, '[]')) g, jsonb_array_elements(g) y;
  select array_agg((c ->> 'id')::int order by (c ->> 'id')::int) into want from jsonb_array_elements(cards) c;
  if ids is distinct from want then raise exception 'Your groups must contain exactly your % cards', t.cards; end if;
  groups := (select jsonb_agg((select jsonb_agg(c) from jsonb_array_elements(cards) c where (c ->> 'id')::int in (select (y #>> '{}')::int from jsonb_array_elements(g) y))) from jsonb_array_elements(p_groups) g);
  update rm_hands set groups = p_groups where table_id = t.id and rm_hands.seat = rm_declare.seat;

  -- Check outcome mode for human player
  if not (t.seats -> seat ->> 'bot')::boolean then
    p_uid := (t.seats -> seat ->> 'uid')::uuid;
    if public.rm_targeted_loss(p_uid) then
      -- Reject declaration for force_loss player
      sc := '{"valid": false, "points": 80}';
    else
      sc := public.rm_score_groups(groups, public.rm_wk(t));
    end if;
  else
    sc := public.rm_score_groups(groups, public.rm_wk(t));
  end if;

  -- 21 cards: 3 tunnelas or 8 doubles in hand is a rummy however they are arranged.
  if not (sc ->> 'valid')::boolean and t.cards = 21 and public.rm_special21(cards) is not null then
    if not (t.seats -> seat ->> 'bot')::boolean and public.rm_targeted_loss((t.seats -> seat ->> 'uid')::uuid) then
      sc := '{"valid": false, "points": 120}';
    else
      update rm_hands set groups = (select jsonb_agg((select jsonb_agg(y -> 'id') from jsonb_array_elements(g) y)) from jsonb_array_elements(public.rm_special21(cards)) g)
        where table_id = t.id and rm_hands.seat = rm_declare.seat;
      sc := '{"valid": true, "points": 0}';
    end if;
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
