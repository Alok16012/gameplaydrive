-- 024: Rummy — every move on the table is visible, and the starting open joker can be picked.
--   • Move log: each turn is recorded as "who • picked from Open (which card) or Closed • which card they threw".
--     Players get this deal's log, so they can see whether an opponent took the open card or drew blind.
--   • Discard pile: the open pile (top first) is sent to every player — in real Rummy the thrown cards are public.
--     When the closed deck runs out and the open pile is reshuffled into it, that is logged too (the same card can
--     then come round again).
--   • Seat note: the last move stays readable under each opponent ("Open 7♥ • threw K♠" / "Closed • threw K♠"),
--     instead of the discard overwriting where the card came from.
--   • Open joker: a joker thrown by a player still can't be picked from the open pile, but when the deal's
--     starting open card is a joker (nobody has played yet) the first player may take it.
-- Safe to run more than once. Run it in the Supabase SQL Editor after 023.

alter table public.rm_private add column if not exists log jsonb not null default '[]';

-- Has anyone played a turn in this deal yet? (The starting open card is still on top until someone has.)
create or replace function public.rm_untouched(t public.rm_tables) returns boolean language sql immutable as $$
  select not exists (select 1 from jsonb_array_elements(t.seats) s where coalesce((s ->> 'turns')::int, 0) > 0);
$$;

-- Card label for notes, e.g. "K♠" (printed jokers "JK").
create or replace function public.rm_card_txt(c jsonb) returns text language sql immutable as $$
  select case when c is null then '' else coalesce(c ->> 'r', '') || coalesce(c ->> 's', '') end;
$$;

-- Append to this table's move log (kept to the last 120 entries).
create or replace function public.rm_log(p_table uuid, e jsonb) returns void
language sql volatile security definer set search_path = public as $$
  update rm_private set log = (select coalesce(jsonb_agg(x order by i), '[]') from (
      select x, i from jsonb_array_elements(log || jsonb_build_array(e)) with ordinality y(x, i) order by i desc limit 120) z)
  where table_id = p_table;
$$;

create or replace function public.rm_draw(t public.rm_tables, seat int, src text) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare p rm_private; card jsonb; top jsonb; reshuffled boolean := false;
begin
  if t.phase <> 'draw' then raise exception 'You have already drawn a card'; end if;
  select * into p from rm_private where table_id = t.id for update;
  if src = 'open' then
    card := p.open -> 0;
    if card is null then raise exception 'The open pile is empty'; end if;
    if public.rm_isj(card, public.rm_wk(t)) and not public.rm_untouched(t) then
      raise exception 'A joker thrown by a player can''t be picked from the open pile';
    end if;
    p.open := p.open - 0;
  else
    if jsonb_array_length(p.stock) = 0 then
      -- Closed deck ran out: reshuffle the open pile (except its top card).
      top := p.open -> 0;
      p.stock := (select coalesce(jsonb_agg(c order by random()), '[]') from jsonb_array_elements(p.open - 0) c);
      p.open := case when top is null then '[]' else jsonb_build_array(top) end;
      reshuffled := true;
    end if;
    card := p.stock -> 0;
    p.stock := p.stock - 0;
  end if;
  update rm_private set stock = p.stock, open = p.open where table_id = t.id;
  if reshuffled then perform public.rm_log(t.id, jsonb_build_object('d', t.deal_no, 'reshuffle', true)); end if;
  update rm_hands set cards = cards || jsonb_build_array(card) where table_id = t.id and rm_hands.seat = rm_draw.seat;
  t.open_top := p.open -> 0;
  t.stock_count := jsonb_array_length(p.stock);
  t.phase := 'discard';
  t.seats := public.rm_seat_set(t.seats, seat, jsonb_build_object('turns', (t.seats -> seat ->> 'turns')::int + 1,
               'picked', case when src = 'open' then card -> 'id' end,
               'src', case when src = 'open' then 'open' else 'closed' end,
               'took', case when src = 'open' then card end,
               'action', case when src = 'open' then 'Picked ' || public.rm_card_txt(card) || ' from Open' else 'Picked from Closed' end));
  return t;
end;
$$;

create or replace function public.rm_discard(t public.rm_tables, seat int, card_id int) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare c jsonb; s jsonb := t.seats -> seat; src text := coalesce(t.seats -> seat ->> 'src', 'closed');
begin
  if t.phase <> 'discard' then raise exception 'Draw a card first'; end if;
  if (s ->> 'picked')::int = card_id and not (s ->> 'bot')::boolean then raise exception 'You can''t discard the card you just picked from the open pile'; end if;
  t := public.rm_throw(t, seat, card_id);
  c := t.open_top;
  perform public.rm_log(t.id, jsonb_build_object('d', t.deal_no, 'seat', seat, 'name', s ->> 'name', 'src', src,
    'took', case when src = 'open' then s -> 'took' end, 'threw', c));
  t.seats := public.rm_seat_set(t.seats, seat, jsonb_build_object('action',
    case when src = 'open' then 'Open ' || public.rm_card_txt(s -> 'took') else 'Closed' end || ' • threw ' || public.rm_card_txt(c)));
  return public.rm_pass(t, seat);
end;
$$;

create or replace function public.rm_view(t public.rm_tables) returns jsonb
language plpgsql stable security definer set search_path = public as $$
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
    'me', me, 'my_cards', my_cards, 'my_groups', my_groups,
    'due_at', case when t.status = 'playing' then least(coalesce(t.bot_acts_at, t.turn_ends), t.turn_ends) else t.next_at end,
    'turn_secs', coalesce((public.game_cfg('rummy') ->> 'turn')::int, 30),
    -- Public table information: the open pile (top first) and this deal's moves.
    'discards', coalesce((select jsonb_agg(c order by i) from jsonb_array_elements(p.open) with ordinality x(c, i) where i <= 60), '[]'),
    'log', coalesce((select jsonb_agg(e order by i) from jsonb_array_elements(p.log) with ordinality x(e, i) where (e ->> 'd')::int = t.deal_no), '[]'),
    'open_joker_ok', t.status = 'playing' and public.rm_untouched(t),
    'server_now', now());
end;
$$;

revoke execute on function public.rm_untouched(public.rm_tables), public.rm_card_txt(jsonb), public.rm_log(uuid, jsonb),
  public.rm_draw(public.rm_tables, int, text), public.rm_discard(public.rm_tables, int, int), public.rm_view(public.rm_tables)
  from public, anon, authenticated;
