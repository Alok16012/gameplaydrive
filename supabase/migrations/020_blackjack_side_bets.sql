-- 020: Blackjack side bets, settled by the server on the deal (coins only, like every other bet).
--   • Perfect Pairs — your first two cards: perfect pair (same suit) 25:1, coloured pair 12:1, mixed pair 6:1.
--   • 21+3 — your two cards plus the dealer's up-card as a three-card hand: suited trips 100:1,
--     straight flush 40:1, three of a kind 30:1, straight 10:1, flush 5:1.
--   Each side bet is 0 or 10…(your main bet). They are paid (or lost) straight away; the main hand plays on.
-- Safe to run more than once. Run after 012 (and 018). Run it in the Supabase SQL Editor.

alter table public.bj_hands add column if not exists side jsonb not null default '{}'::jsonb;

create or replace function public.bj_rank_no(r text) returns int language sql immutable as $$
  select case r when 'A' then 14 when 'K' then 13 when 'Q' then 12 when 'J' then 11 else r::int end;
$$;

-- Perfect Pairs on two cards: {name, x} (x = pays x to 1) or null.
create or replace function public.bj_pp(c jsonb) returns jsonb language sql immutable set search_path = public as $$
  select case
    when c -> 0 ->> 'r' <> c -> 1 ->> 'r' then null
    when c -> 0 ->> 's' = c -> 1 ->> 's' then jsonb_build_object('name', 'Perfect pair', 'x', 25)
    when (c -> 0 ->> 's' in ('♥', '♦')) = (c -> 1 ->> 's' in ('♥', '♦')) then jsonb_build_object('name', 'Coloured pair', 'x', 12)
    else jsonb_build_object('name', 'Mixed pair', 'x', 6)
  end;
$$;

-- 21+3 on three cards: {name, x} or null.
create or replace function public.bj_t3(c jsonb) returns jsonb language plpgsql immutable set search_path = public as $$
declare a int[]; flush boolean; trips boolean; straight boolean;
begin
  select array_agg(public.bj_rank_no(x ->> 'r') order by public.bj_rank_no(x ->> 'r')) into a from jsonb_array_elements(c) x;
  select count(distinct x ->> 's') = 1 into flush from jsonb_array_elements(c) x;
  trips := a[1] = a[3];
  straight := (a[2] = a[1] + 1 and a[3] = a[2] + 1) or a = array[2, 3, 14];
  if trips and flush then return jsonb_build_object('name', 'Suited trips', 'x', 100); end if;
  if straight and flush then return jsonb_build_object('name', 'Straight flush', 'x', 40); end if;
  if trips then return jsonb_build_object('name', 'Three of a kind', 'x', 30); end if;
  if straight then return jsonb_build_object('name', 'Straight', 'x', 10); end if;
  if flush then return jsonb_build_object('name', 'Flush', 'x', 5); end if;
  return null;
end;
$$;

-- The player's view now carries the side-bet results.
create or replace function public.bj_view(h public.bj_hands) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  is_open boolean := h.status = 'playing';
  cur jsonb := h.hands -> h.active;
  bal bigint;
begin
  select coins into bal from wallets where user_id = h.user_id;
  return jsonb_build_object(
    'id', h.id,
    'bet', h.bet,
    'status', h.status,
    'active', h.active,
    'payout', h.payout,
    'balance', bal,
    'side', h.side,
    'dealer', case when is_open then jsonb_build_array(h.dealer -> 0) else h.dealer end,
    'dealer_total', case when is_open then public.bj_total(jsonb_build_array(h.dealer -> 0)) else public.bj_total(h.dealer) end,
    'hands', (select jsonb_agg(x || jsonb_build_object('total', public.bj_total(x -> 'cards')) order by i)
              from jsonb_array_elements(h.hands) with ordinality t(x, i)),
    'can_double', is_open and jsonb_array_length(cur -> 'cards') = 2 and coalesce(bal, 0) >= (cur ->> 'bet')::bigint,
    'can_split', is_open and jsonb_array_length(h.hands) = 1 and jsonb_array_length(cur -> 'cards') = 2
                 and public.bj_value(cur -> 'cards' -> 0 ->> 'r') = public.bj_value(cur -> 'cards' -> 1 ->> 'r')
                 and coalesce(bal, 0) >= h.bet
  );
end;
$$;

drop function if exists public.bj_deal(bigint);
create or replace function public.bj_deal(p_bet bigint, p_pp bigint default 0, p_t3 bigint default 0) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile(); h bj_hands; s jsonb; p jsonb; d jsonb;
  ppr jsonb; t3r jsonb; pay bigint := 0; sd jsonb; note text;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if p_bet < 10 or p_bet > 10000 then raise exception 'Bet between 10 and 10,000 coins'; end if;
  p_pp := coalesce(p_pp, 0); p_t3 := coalesce(p_t3, 0);
  if p_pp < 0 or p_t3 < 0 or (p_pp > 0 and p_pp < 10) or (p_t3 > 0 and p_t3 < 10) then raise exception 'Side bets start at 10 coins'; end if;
  if p_pp > p_bet or p_t3 > p_bet then raise exception 'A side bet can''t be more than your main bet'; end if;
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

  -- Side bets: staked and settled on the deal.
  if p_pp > 0 or p_t3 > 0 then
    note := 'Blackjack • Hand #' || h.id || ' • side bets';
    if p_pp > 0 and public.wallet_move(me.id, -p_pp, 'bet', note) is null then raise exception 'Not enough coins for the side bets'; end if;
    if p_t3 > 0 and public.wallet_move(me.id, -p_t3, 'bet', note) is null then raise exception 'Not enough coins for the side bets'; end if;
    if p_pp > 0 then ppr := public.bj_pp(p); end if;
    if p_t3 > 0 then t3r := public.bj_t3(p || jsonb_build_array(d -> 0)); end if;
    sd := jsonb_build_object(
      'pp', case when p_pp > 0 then jsonb_build_object('bet', p_pp, 'hit', ppr, 'pay', case when ppr is null then 0 else p_pp * ((ppr ->> 'x')::int + 1) end) end,
      't3', case when p_t3 > 0 then jsonb_build_object('bet', p_t3, 'hit', t3r, 'pay', case when t3r is null then 0 else p_t3 * ((t3r ->> 'x')::int + 1) end) end
    );
    pay := coalesce((sd -> 'pp' ->> 'pay')::bigint, 0) + coalesce((sd -> 't3' ->> 'pay')::bigint, 0);
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

revoke execute on function public.bj_view(public.bj_hands) from public, anon, authenticated;
revoke execute on function public.bj_deal(bigint, bigint, bigint) from public, anon;
grant execute on function public.bj_deal(bigint, bigint, bigint) to authenticated;
