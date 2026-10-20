-- 065: Teen Patti pays the player who actually won the hand.
-- 048 asked the random get_outcome_mode() at the end of every hand. It says force_loss about 60% of the time even
-- in plain fair mode, and then:
--   * tp_showdown gave the pot to a bot even though the revealed cards showed the player's hand was better;
--   * tp_finish handed the pot to a RANDOM bot — possibly one that had already packed — even when everyone else had
--     packed and the player was the only one left.
-- Now the best hand among the players still in wins the show (equal hands: the one who asked for the show loses),
-- and tp_finish pays whoever won. Outcome control still applies when the cards are dealt (tp_start_hand, 048).
-- Safe to run more than once. Run after 048 in the Supabase SQL Editor.

CREATE OR REPLACE FUNCTION public.tp_showdown(t tp_tables)
 RETURNS tp_tables
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  best int;
begin
  -- Best hand among the players still in wins. On equal hands the player who asked for the show (whose turn it
  -- is) loses, as in a side show.
  select seat into best from tp_hands
  where table_id = t.id and seat = any (public.tp_active(t.seats))
  order by public.tp_score(cards) desc, (seat = t.turn) asc, seat
  limit 1;
  return public.tp_finish(t, best, 'Show', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.tp_finish(t tp_tables, winner integer, reason text, showdown boolean)
 RETURNS tp_tables
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  w jsonb := t.seats -> winner;
  payout bigint := floor(t.pot * 0.95);
  bal bigint;
  reveal jsonb := '[]';
  h record;
  hand text;
begin
  if (w ->> 'bot')::boolean then
    t.seats := public.tp_seat_set(t.seats, winner, jsonb_build_object('bal', (w ->> 'bal')::bigint + payout));
  else
    bal := public.wallet_move((w ->> 'uid')::uuid, payout, 'win', 'Teen Patti • Hand #' || t.hand_no);
    t.seats := public.tp_seat_set(t.seats, winner, jsonb_build_object('bal', bal));
  end if;

  if showdown then
    for h in select seat, cards from tp_hands where table_id = t.id and seat = any (public.tp_active(t.seats)) loop
      reveal := reveal || jsonb_build_array(jsonb_build_object('seat', h.seat, 'cards', h.cards, 'hand', public.tp_hand_name(public.tp_score(h.cards))));
    end loop;
    select public.tp_hand_name(public.tp_score(cards)) into hand from tp_hands where table_id = t.id and seat = winner;
  end if;

  t.result := jsonb_build_object('seat', winner, 'name', w ->> 'name', 'bot', (w ->> 'bot')::boolean, 'uid', w ->> 'uid',
                                 'amount', payout, 'reason', coalesce(hand, reason), 'reveal', reveal, 'pot', t.pot);
  t.status := 'done';
  t.turn := null;
  t.turn_ends := null;
  t.bot_acts_at := null;
  t.next_hand_at := now() + interval '8 seconds';
  return t;
end;
$function$;

revoke execute on function public.tp_showdown(public.tp_tables) from public, anon, authenticated;
revoke execute on function public.tp_finish(public.tp_tables, int, text, boolean) from public, anon, authenticated;
