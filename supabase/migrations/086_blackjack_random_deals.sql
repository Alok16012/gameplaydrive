-- 086: Blackjack — every hand is dealt from the shuffled shoe; no more fixed cards.
--
-- 073 dealt the same cards whenever the outcome was set: 10♠ 7♦ against 9♣ 9♥ in force_loss, A♠ K♥ against 7♦ 9♣ in
-- force_win — a player saw the same hand over and over. Now the opening deal always comes from the six-deck shoe.
-- In force_loss neither side gets a natural (the player plays the hand out), and when the player stands the
-- dealer's hole card and draw are picked from the shoe so the dealer finishes one point higher (17 at least; 21
-- against a player's 21 is a push). In force_win the dealer never has a natural, and when the player stands with a live
-- total the dealer draws from the shoe into a bust if it would otherwise win or tie. A player who busts has lost
-- on their own either way. Cards used this way leave the shoe, so no card appears twice in a hand.
--
-- Safe to run more than once.

begin;

-- The outcome mode is rolled once, at the deal, and kept with the hand: get_outcome_mode() re-rolls on every call,
-- so reading it again at the finish could steer the dealer the other way from the deal.
alter table public.bj_hands add column if not exists mode text;

-- The first card in the shoe worth `v` (10 = any ten-value card; 11 = an ace), removed from it: {card, shoe}.
create or replace function public.bj_take(shoe jsonb, v int) returns jsonb
language plpgsql immutable set search_path = public as $$
declare i int; c jsonb;
begin
  for i in 0 .. jsonb_array_length(shoe) - 1 loop
    c := shoe -> i;
    if (v = 11 and c ->> 'r' = 'A') or (v between 2 and 10 and c ->> 'r' <> 'A' and public.bj_value(c ->> 'r') = v) then
      return jsonb_build_object('card', c, 'shoe', shoe - i);
    end if;
  end loop;
  return null;
end;
$$;

-- Dealer cards (up card kept) that total exactly `target` from the shoe: the hole card alone when that is not a
-- natural, otherwise a small hole card and one draw. Returns {dealer, shoe}, or null when the shoe can't do it.
create or replace function public.bj_dealer_to(up jsonb, shoe jsonb, target int) returns jsonb
language plpgsql immutable set search_path = public as $$
declare u int := public.bj_value(up ->> 'r'); need int; t jsonb; t2 jsonb; hole int; s2 jsonb;
begin
  if up ->> 'r' = 'A' then u := 11; end if;
  need := target - u;
  if need between 2 and 10 and not (u + need = 21) then
    t := public.bj_take(shoe, need);
    if t is not null then return jsonb_build_object('dealer', jsonb_build_array(up, t -> 'card'), 'shoe', t -> 'shoe'); end if;
  end if;
  -- Hole card that leaves the dealer on 12-16 (so it must draw), then the card that lands on target.
  for hole in 2 .. 10 loop
    continue when u + hole < 12 or u + hole > 16;
    need := target - u - hole;
    continue when need < 2 or need > 10;
    t := public.bj_take(shoe, hole);
    continue when t is null;
    t2 := public.bj_take(t -> 'shoe', need);
    continue when t2 is null;
    return jsonb_build_object('dealer', jsonb_build_array(up, t -> 'card', t2 -> 'card'), 'shoe', t2 -> 'shoe');
  end loop;
  -- An ace as the up card (soft hands): hole 2-5 gives soft 13-16, then draw.
  if u = 11 then
    for hole in 2 .. 5 loop
      need := target - 11 - hole;
      continue when need < 2 or need > 10;
      t := public.bj_take(shoe, hole);
      continue when t is null;
      t2 := public.bj_take(t -> 'shoe', need);
      continue when t2 is null;
      return jsonb_build_object('dealer', jsonb_build_array(up, t -> 'card', t2 -> 'card'), 'shoe', t2 -> 'shoe');
    end loop;
  end if;
  return null;
end;
$$;

-- Dealer cards (up card kept) from the shoe that bust: a hole card leaving 12-16, then a ten-value card.
create or replace function public.bj_dealer_bust(up jsonb, shoe jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare u int := public.bj_value(up ->> 'r'); t jsonb; t2 jsonb; hole int;
begin
  if up ->> 'r' = 'A' then u := 11; end if;
  for hole in reverse 10 .. 2 loop
    continue when u = 11 or u + hole < 12 or u + hole > 16; -- an ace up card is soft: handled below
    t := public.bj_take(shoe, hole);
    continue when t is null;
    t2 := public.bj_take(t -> 'shoe', 10);
    continue when t2 is null;
    return jsonb_build_object('dealer', jsonb_build_array(up, t -> 'card', t2 -> 'card'), 'shoe', t2 -> 'shoe');
  end loop;
  if u = 11 then
    -- Soft hand: ace + hole 2-5 (soft 13-16), draw a 10 (hard 13-16), draw another 10: bust.
    for hole in 2 .. 5 loop
      t := public.bj_take(shoe, hole);
      continue when t is null;
      t2 := public.bj_take(t -> 'shoe', 10);
      continue when t2 is null;
      t := public.bj_take(t2 -> 'shoe', 10);
      continue when t is null;
      return jsonb_build_object('dealer', jsonb_build_array(up, (public.bj_take(shoe, hole)) -> 'card', t2 -> 'card', t -> 'card'), 'shoe', t -> 'shoe');
    end loop;
  end if;
  return null;
end;
$$;

CREATE OR REPLACE FUNCTION public.bj_deal(p_bet bigint, p_pp bigint, p_t3 bigint, p_h3 bigint, p_bi bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me profiles := public.current_profile(); h bj_hands; s jsonb; p jsonb; d jsonb;
  ppr jsonb; t3r jsonb; h3r jsonb; pay bigint := 0; sd jsonb; note text; three jsonb;
  mode text; tries int := 0;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if p_bet < 10 or p_bet > 10000 then raise exception 'Bet between 10 and 10,000 coins'; end if;
  p_pp := coalesce(p_pp, 0); p_t3 := coalesce(p_t3, 0); p_h3 := coalesce(p_h3, 0); p_bi := coalesce(p_bi, 0);
  if least(p_pp, p_t3, p_h3, p_bi) < 0 then raise exception 'Invalid side bet'; end if;
  if (p_pp > 0 and p_pp < 10) or (p_t3 > 0 and p_t3 < 10) or (p_h3 > 0 and p_h3 < 10) or (p_bi > 0 and p_bi < 10) then raise exception 'Side bets start at 10 coins'; end if;
  if greatest(p_pp, p_t3, p_h3, p_bi) > p_bet then raise exception 'A side bet can''t be more than your main bet'; end if;
  if exists (select 1 from bj_hands where user_id = me.id and status = 'playing') then raise exception 'Finish your current hand first'; end if;

  mode := public.get_outcome_mode(me.id, 'blackjack');

  -- Six decks, shuffled; the opening deal is always the top of the shoe. When the outcome is set, a deal that would
  -- settle the hand on the spot (a natural for the side meant to lose, or for either side in force_loss, where the
  -- player should get to play) is reshuffled — the cards still come from the shoe.
  loop
    select jsonb_agg(jsonb_build_object('r', r, 's', su) order by random()) into s
      from unnest(array['A','2','3','4','5','6','7','8','9','10','J','Q','K']) r
      cross join unnest(array['♠','♥','♦','♣']) su
      cross join generate_series(1, 6);
    p := jsonb_build_array(s -> 0, s -> 2);
    d := jsonb_build_array(s -> 1, s -> 3);
    tries := tries + 1;
    exit when tries >= 40
      or (mode = 'force_loss' and not public.bj_natural(p) and not public.bj_natural(d))
      or (mode = 'force_win' and not public.bj_natural(d))
      or mode not in ('force_loss', 'force_win');
  end loop;

  insert into bj_hands (user_id, bet, shoe, dealer, hands, mode)
    values (me.id, p_bet, s - 0 - 0 - 0 - 0, d,
            jsonb_build_array(jsonb_build_object('cards', p, 'bet', p_bet, 'done', false, 'doubled', false, 'split', false)), mode)
    returning * into h;
  if public.wallet_move(me.id, -p_bet, 'bet', 'Blackjack • Hand #' || h.id) is null then raise exception 'Not enough coins'; end if;

  if p_pp > 0 or p_t3 > 0 or p_h3 > 0 or p_bi > 0 then
    note := 'Blackjack • Hand #' || h.id || ' • side bets';
    if p_pp > 0 and public.wallet_move(me.id, -p_pp, 'bet', note) is null then raise exception 'Not enough coins for the side bets'; end if;
    if p_t3 > 0 and public.wallet_move(me.id, -p_t3, 'bet', note) is null then raise exception 'Not enough coins for the side bets'; end if;
    if p_h3 > 0 and public.wallet_move(me.id, -p_h3, 'bet', note) is null then raise exception 'Not enough coins for the side bets'; end if;
    if p_bi > 0 and public.wallet_move(me.id, -p_bi, 'bet', note) is null then raise exception 'Not enough coins for the side bets'; end if;
    three := p || jsonb_build_array(d -> 0);
    if p_pp > 0 then ppr := public.bj_pp(p); end if;
    if p_t3 > 0 then t3r := public.bj_t3(three); end if;
    if p_h3 > 0 then h3r := public.bj_hot3(three); end if;
    sd := jsonb_build_object(
      'pp', case when p_pp > 0 then jsonb_build_object('bet', p_pp, 'hit', ppr, 'pay', case when ppr is null then 0 else p_pp * ((ppr ->> 'x')::int + 1) end) end,
      't3', case when p_t3 > 0 then jsonb_build_object('bet', p_t3, 'hit', t3r, 'pay', case when t3r is null then 0 else p_t3 * ((t3r ->> 'x')::int + 1) end) end,
      'h3', case when p_h3 > 0 then jsonb_build_object('bet', p_h3, 'hit', h3r, 'pay', case when h3r is null then 0 else p_h3 * ((h3r ->> 'x')::int + 1) end) end,
      'bi', case when p_bi > 0 then jsonb_build_object('bet', p_bi, 'pending', true) end
    );
    pay := coalesce((sd -> 'pp' ->> 'pay')::bigint, 0) + coalesce((sd -> 't3' ->> 'pay')::bigint, 0) + coalesce((sd -> 'h3' ->> 'pay')::bigint, 0);
    if pay > 0 then perform public.wallet_move(me.id, pay, 'win', note); end if;
    update bj_hands set side = jsonb_strip_nulls(sd) where id = h.id returning * into h;
  end if;

  if public.bj_natural(p) or public.bj_natural(d) then
    h := public.bj_finish(h);
    perform public.bj_save(h);
  end if;
  return public.bj_view(h);
end;
$function$;

CREATE OR REPLACE FUNCTION public.bj_finish(h bj_hands)
 RETURNS bj_hands
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  x jsonb; i int; pt int; dt int; res text; pay bigint; total bigint := 0; staked bigint := 0; any_win boolean := false;
  live boolean := false; dealer_bj boolean := public.bj_natural(h.dealer); settled jsonb := '[]';
  bi_bet bigint := coalesce((h.side -> 'bi' ->> 'bet')::bigint, 0); bir jsonb; bi_pay bigint := 0;
  mode text; max_pts int := 0; fix jsonb; shoe0 jsonb;
begin
  mode := coalesce(h.mode, public.get_outcome_mode(h.user_id, 'blackjack'));

  for x in select * from jsonb_array_elements(h.hands) loop
    pt := public.bj_total(x -> 'cards');
    if pt <= 21 and not (public.bj_natural(x -> 'cards') and not (x ->> 'split')::boolean) then
      live := true;
      if pt > max_pts then max_pts := pt; end if;
    end if;
  end loop;

  if (live or bi_bet > 0) and not dealer_bj then
    shoe0 := h.shoe;
    while public.bj_total(h.dealer) < 17 loop
      h.dealer := h.dealer || jsonb_build_array(h.shoe -> 0);
      h.shoe := h.shoe - 0;
    end loop;
    dt := public.bj_total(h.dealer);
    -- The outcome, when set, is decided by what the dealer draws — from the shoe, never made-up cards. The dealer's
    -- up card stays; the hole card and draw are replaced with shoe cards that reach the needed total.
    if mode = 'force_loss' and live and (dt > 21 or dt <= max_pts) then
      -- one or two points over the player (never the same margin every hand), 17 at least, 21 at most
      fix := public.bj_dealer_to(h.dealer -> 0, shoe0, greatest(17, least(21, max_pts + 1 + floor(random() * 2)::int)));
      if fix is not null then h.dealer := fix -> 'dealer'; h.shoe := fix -> 'shoe'; end if;
    elsif mode = 'force_win' and live and dt <= 21 and dt >= max_pts then
      fix := public.bj_dealer_bust(h.dealer -> 0, shoe0);
      if fix is not null then h.dealer := fix -> 'dealer'; h.shoe := fix -> 'shoe'; end if;
    end if;
  end if;
  dt := public.bj_total(h.dealer);

  for i in 0 .. jsonb_array_length(h.hands) - 1 loop
    x := h.hands -> i;
    pt := public.bj_total(x -> 'cards');
    if pt > 21 then res := 'bust'; pay := 0;
    elsif public.bj_natural(x -> 'cards') and not (x ->> 'split')::boolean then
      if dealer_bj then res := 'push'; pay := (x ->> 'bet')::bigint;
      else res := 'blackjack'; pay := floor((x ->> 'bet')::bigint * 2.5); end if;
    elsif dealer_bj then res := 'lose'; pay := 0;
    elsif dt > 21 or pt > dt then res := 'win'; pay := (x ->> 'bet')::bigint * 2;
    elsif pt = dt then res := 'push'; pay := (x ->> 'bet')::bigint;
    else res := 'lose'; pay := 0; end if;
    if res in ('win', 'blackjack') then any_win := true; end if;
    total := total + pay;
    staked := staked + (x ->> 'bet')::bigint;
    settled := settled || jsonb_build_array(x || jsonb_build_object('done', true, 'result', res, 'payout', pay));
  end loop;

  h.hands := settled;
  h.status := 'done';
  h.payout := total;
  h.updated_at := now();
  if total > 0 then
    perform public.wallet_move(h.user_id, total, case when any_win then 'win' else 'refund' end, 'Blackjack • Hand #' || h.id);
  end if;

  if bi_bet > 0 then
    bir := public.bj_bustit(h.dealer);
    if bir is not null then
      bi_pay := bi_bet * ((bir ->> 'x')::int + 1);
      perform public.wallet_move(h.user_id, bi_pay, 'win', 'Blackjack • Hand #' || h.id || ' • Bust It');
    end if;
    h.side := jsonb_set(h.side, '{bi}', jsonb_strip_nulls(jsonb_build_object('bet', bi_bet, 'hit', bir, 'pay', bi_pay)));
  end if;
  return h;
end;
$function$;

revoke execute on function public.bj_take(jsonb, int), public.bj_dealer_to(jsonb, jsonb, int), public.bj_dealer_bust(jsonb, jsonb) from public, anon, authenticated;

commit;
