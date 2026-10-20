-- 071: Blackjack side bets like Infinite Blackjack — four side bets around the main bet, paid as the table card says.
--   • Perfect Pairs (unchanged): perfect 25:1, coloured 12:1, mixed 6:1.
--   • 21+3: suited trips 100:1, straight flush 40:1, three of a kind 25:1 (was 30), straight 10:1, flush 5:1.
--   • Hot 3 (new) — your two cards + the dealer's up-card: 7-7-7 100:1, total 21 suited 20:1, total 21 unsuited 4:1,
--     total 20 2:1, total 19 1:1.
--   • Bust It (new) — pays when the dealer busts, by how many cards it took: 3 cards 1:1, 4 cards 2:1, 5 cards 9:1,
--     6 cards 50:1, 7 cards 100:1, 8+ cards 250:1. With a Bust It bet down the dealer always plays the hand out,
--     even when every player hand has bust or is a blackjack (otherwise the bet could never win).
--   Perfect Pairs, 21+3 and Hot 3 are settled on the deal; Bust It when the hand ends. Each side bet is 0 or
--   10…(your main bet). The old three-argument bj_deal stays as a wrapper so phones on an older build keep working.
-- Safe to run more than once. Run after 070 in the Supabase SQL Editor.

-- 21+3: three of a kind now pays 25:1.
create or replace function public.bj_t3(c jsonb) returns jsonb language plpgsql immutable set search_path = public as $$
declare a int[]; flush boolean; trips boolean; straight boolean;
begin
  select array_agg(public.bj_rank_no(x ->> 'r') order by public.bj_rank_no(x ->> 'r')) into a from jsonb_array_elements(c) x;
  select count(distinct x ->> 's') = 1 into flush from jsonb_array_elements(c) x;
  trips := a[1] = a[3];
  straight := (a[2] = a[1] + 1 and a[3] = a[2] + 1) or a = array[2, 3, 14];
  if trips and flush then return jsonb_build_object('name', 'Suited trips', 'x', 100); end if;
  if straight and flush then return jsonb_build_object('name', 'Straight flush', 'x', 40); end if;
  if trips then return jsonb_build_object('name', 'Three of a kind', 'x', 25); end if;
  if straight then return jsonb_build_object('name', 'Straight', 'x', 10); end if;
  if flush then return jsonb_build_object('name', 'Flush', 'x', 5); end if;
  return null;
end;
$$;

-- Hot 3 on three cards (your two + the dealer's up-card): {name, x} or null. Ace counts 11 or 1, whichever is better.
create or replace function public.bj_hot3(c jsonb) returns jsonb language plpgsql immutable set search_path = public as $$
declare t int := public.bj_total(c); suited boolean; sevens boolean;
begin
  select count(distinct x ->> 's') = 1 into suited from jsonb_array_elements(c) x;
  select bool_and(x ->> 'r' = '7') into sevens from jsonb_array_elements(c) x;
  if sevens then return jsonb_build_object('name', '7-7-7', 'x', 100); end if;
  if t = 21 and suited then return jsonb_build_object('name', 'Total 21 suited', 'x', 20); end if;
  if t = 21 then return jsonb_build_object('name', 'Total 21', 'x', 4); end if;
  if t = 20 then return jsonb_build_object('name', 'Total 20', 'x', 2); end if;
  if t = 19 then return jsonb_build_object('name', 'Total 19', 'x', 1); end if;
  return null;
end;
$$;

-- Bust It on the dealer's finished hand: {name, x} when the dealer bust, by card count; else null.
create or replace function public.bj_bustit(d jsonb) returns jsonb language sql immutable set search_path = public as $$
  select case
    when public.bj_total(d) <= 21 then null
    when jsonb_array_length(d) >= 8 then jsonb_build_object('name', 'Bust with 8+ cards', 'x', 250)
    when jsonb_array_length(d) = 7 then jsonb_build_object('name', 'Bust with 7 cards', 'x', 100)
    when jsonb_array_length(d) = 6 then jsonb_build_object('name', 'Bust with 6 cards', 'x', 50)
    when jsonb_array_length(d) = 5 then jsonb_build_object('name', 'Bust with 5 cards', 'x', 9)
    when jsonb_array_length(d) = 4 then jsonb_build_object('name', 'Bust with 4 cards', 'x', 2)
    else jsonb_build_object('name', 'Bust with 3 cards', 'x', 1)
  end;
$$;

-- Save the side-bet results too (Bust It is written at the end of the hand).
create or replace function public.bj_save(h public.bj_hands) returns void
language sql volatile security definer set search_path = public as $$
  update bj_hands set shoe = h.shoe, dealer = h.dealer, hands = h.hands, active = h.active, status = h.status,
    payout = h.payout, side = h.side, updated_at = now() where id = h.id;
$$;

-- Finish the round: the dealer draws to 17 when any player hand is still live, or when Bust It is riding; then
-- every hand is settled, and the Bust It bet is paid if the dealer bust.
create or replace function public.bj_finish(h public.bj_hands) returns public.bj_hands
language plpgsql volatile security definer set search_path = public as $$
declare
  x jsonb; i int; pt int; dt int; res text; pay bigint; total bigint := 0; staked bigint := 0; any_win boolean := false;
  live boolean := false; dealer_bj boolean := public.bj_natural(h.dealer); settled jsonb := '[]';
  bi_bet bigint := coalesce((h.side -> 'bi' ->> 'bet')::bigint, 0); bir jsonb; bi_pay bigint := 0;
begin
  for x in select * from jsonb_array_elements(h.hands) loop
    if public.bj_total(x -> 'cards') <= 21 and not (public.bj_natural(x -> 'cards') and not (x ->> 'split')::boolean) then live := true; end if;
  end loop;
  if (live or bi_bet > 0) and not dealer_bj then
    while public.bj_total(h.dealer) < 17 loop
      h.dealer := h.dealer || jsonb_build_array(h.shoe -> 0);
      h.shoe := h.shoe - 0;
    end loop;
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
$$;

-- The deal, with all four side bets.
drop function if exists public.bj_deal(bigint);
create or replace function public.bj_deal(p_bet bigint, p_pp bigint, p_t3 bigint, p_h3 bigint, p_bi bigint) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile(); h bj_hands; s jsonb; p jsonb; d jsonb;
  ppr jsonb; t3r jsonb; h3r jsonb; pay bigint := 0; sd jsonb; note text; three jsonb;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if p_bet < 10 or p_bet > 10000 then raise exception 'Bet between 10 and 10,000 coins'; end if;
  p_pp := coalesce(p_pp, 0); p_t3 := coalesce(p_t3, 0); p_h3 := coalesce(p_h3, 0); p_bi := coalesce(p_bi, 0);
  if least(p_pp, p_t3, p_h3, p_bi) < 0 then raise exception 'Invalid side bet'; end if;
  if (p_pp > 0 and p_pp < 10) or (p_t3 > 0 and p_t3 < 10) or (p_h3 > 0 and p_h3 < 10) or (p_bi > 0 and p_bi < 10) then raise exception 'Side bets start at 10 coins'; end if;
  if greatest(p_pp, p_t3, p_h3, p_bi) > p_bet then raise exception 'A side bet can''t be more than your main bet'; end if;
  if exists (select 1 from bj_hands where user_id = me.id and status = 'playing') then raise exception 'Finish your current hand first'; end if;
  select jsonb_agg(jsonb_build_object('r', r, 's', su) order by random()) into s
    from unnest(array['A','2','3','4','5','6','7','8','9','10','J','Q','K']) r
    cross join unnest(array['♠','♥','♦','♣']) su
    cross join generate_series(1, 6);
  p := jsonb_build_array(s -> 0, s -> 2);
  d := jsonb_build_array(s -> 1, s -> 3);
  insert into bj_hands (user_id, bet, shoe, dealer, hands)
    values (me.id, p_bet, s - 0 - 0 - 0 - 0, d,
            jsonb_build_array(jsonb_build_object('cards', p, 'bet', p_bet, 'done', false, 'doubled', false, 'split', false)))
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
$$;

-- Older builds still call the three-argument version.
create or replace function public.bj_deal(p_bet bigint, p_pp bigint default 0, p_t3 bigint default 0) returns jsonb
language sql volatile security definer set search_path = public as $$
  select public.bj_deal(p_bet, p_pp, p_t3, 0, 0);
$$;

revoke execute on function public.bj_hot3(jsonb), public.bj_bustit(jsonb), public.bj_finish(public.bj_hands), public.bj_save(public.bj_hands) from public, anon, authenticated;
revoke execute on function public.bj_deal(bigint, bigint, bigint, bigint, bigint), public.bj_deal(bigint, bigint, bigint) from public, anon;
grant execute on function public.bj_deal(bigint, bigint, bigint, bigint, bigint), public.bj_deal(bigint, bigint, bigint) to authenticated;
