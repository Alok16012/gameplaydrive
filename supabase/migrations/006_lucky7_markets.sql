-- 006: Lucky 7 markets (exchange-style board). Run after 005 in the Supabase SQL Editor. Safe to run more than once.
--
-- One card is dealt. Odds are the total return per coin staked (stake included):
--   low               A to 6                              ×2      (a 7 loses Low and High)
--   high              8 to K                              ×2
--   even              2, 4, 6, 8, 10, Q                   ×2.1
--   odd               A, 3, 5, 7, 9, J, K                 ×1.79
--   black / red       ♠ ♣ / ♥ ♦                           ×1.95
--   g_a23 / g_456 / g_8910 / g_jqk   card in that group   ×4      (7 is in no group)
--   c_A … c_K         exact card                          ×12
-- The older bets below / seven / above (×2 / ×12 / ×2) still settle, for app versions that use them.

create or replace function public.l7_pay(p_side text, p_card jsonb) returns numeric
language plpgsql immutable set search_path = public as $$
declare v int := public.card_low(p_card ->> 'r'); s text := p_card ->> 's';
begin
  return case p_side
    when 'low' then case when v <= 6 then 2 else 0 end
    when 'high' then case when v >= 8 then 2 else 0 end
    when 'below' then case when v < 7 then 2 else 0 end
    when 'above' then case when v > 7 then 2 else 0 end
    when 'seven' then case when v = 7 then 12 else 0 end
    when 'even' then case when v % 2 = 0 then 2.1 else 0 end
    when 'odd' then case when v % 2 = 1 then 1.79 else 0 end
    when 'black' then case when s in ('♠', '♣') then 1.95 else 0 end
    when 'red' then case when s in ('♥', '♦') then 1.95 else 0 end
    when 'g_a23' then case when v between 1 and 3 then 4 else 0 end
    when 'g_456' then case when v between 4 and 6 then 4 else 0 end
    when 'g_8910' then case when v between 8 and 10 then 4 else 0 end
    when 'g_jqk' then case when v between 11 and 13 then 4 else 0 end
    else case when p_side = 'c_' || (p_card ->> 'r') then 12 else 0 end
  end;
end;
$$;

create or replace function public.casino_round(p_game text, p_bets jsonb, p_round text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  names jsonb := '{"dragon-tiger":"Dragon Tiger","andar-bahar":"Andar Bahar","lucky-7":"Lucky 7"}';
  valid text[];
  d jsonb := public.new_deck();
  b jsonb;
  stake bigint := 0;
  ret numeric := 0;
  won_side boolean := false;
  bal bigint;
  cards jsonb;
  winner text;
  joker jsonb; andar jsonb := '[]'; bahar jsonb := '[]'; side text := 'andar'; c jsonb; i int := 1;
  note text;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  valid := case p_game when 'dragon-tiger' then array['dragon','tie','tiger'] when 'andar-bahar' then array['andar','bahar'] when 'lucky-7' then array['below','seven','above'] end;
  if valid is null then raise exception 'Unknown game'; end if;
  for b in select * from jsonb_array_elements(coalesce(p_bets, '[]')) loop
    if not ((b ->> 'side') = any (valid)
            or (p_game = 'dragon-tiger' and (b ->> 'side') ~ '^(pair|[dt]_(even|odd|black|red|A|[2-9]|10|J|Q|K))$')
            or (p_game = 'lucky-7' and (b ->> 'side') ~ '^(low|high|even|odd|black|red|g_(a23|456|8910|jqk)|c_(A|[2-9]|10|J|Q|K))$'))
       or (b ->> 'v')::bigint <= 0 then raise exception 'Invalid bet'; end if;
    stake := stake + (b ->> 'v')::bigint;
  end loop;
  if stake > 100000 then raise exception 'Max 100,000 coins per round'; end if;

  if p_game = 'dragon-tiger' then
    cards := jsonb_build_object('dragon', d -> 0, 'tiger', d -> 1);
    winner := case when card_low(d -> 0 ->> 'r') = card_low(d -> 1 ->> 'r') then 'tie'
                   when card_low(d -> 0 ->> 'r') > card_low(d -> 1 ->> 'r') then 'dragon' else 'tiger' end;
  elsif p_game = 'lucky-7' then
    cards := jsonb_build_object('card', d -> 0);
    winner := case when card_low(d -> 0 ->> 'r') < 7 then 'below' when card_low(d -> 0 ->> 'r') = 7 then 'seven' else 'above' end;
  else
    -- Andar Bahar: centre joker, deal alternately (Andar first) until a card matches the joker's rank.
    joker := d -> 0;
    loop
      c := d -> i;
      if side = 'andar' then andar := andar || jsonb_build_array(c); else bahar := bahar || jsonb_build_array(c); end if;
      exit when c ->> 'r' = joker ->> 'r';
      side := case side when 'andar' then 'bahar' else 'andar' end;
      i := i + 1;
    end loop;
    cards := jsonb_build_object('joker', joker, 'andar', andar, 'bahar', bahar);
    winner := side;
  end if;

  for b in select * from jsonb_array_elements(coalesce(p_bets, '[]')) loop
    if p_game = 'dragon-tiger' then
      if public.dt_pay(b ->> 'side', d -> 0, d -> 1, winner) > 0 then
        ret := ret + (b ->> 'v')::bigint * public.dt_pay(b ->> 'side', d -> 0, d -> 1, winner);
        won_side := true;
      elsif winner = 'tie' and b ->> 'side' in ('dragon', 'tiger') then
        ret := ret + (b ->> 'v')::bigint / 2.0;
      end if;
    elsif p_game = 'lucky-7' then
      if public.l7_pay(b ->> 'side', d -> 0) > 0 then
        ret := ret + (b ->> 'v')::bigint * public.l7_pay(b ->> 'side', d -> 0);
        won_side := true;
      end if;
    elsif b ->> 'side' = winner then
      ret := ret + (b ->> 'v')::bigint * 2;
      won_side := true;
    end if;
  end loop;
  ret := floor(ret);

  note := (names ->> p_game) || case when p_round <> '' then ' • Round #' || p_round else '' end;
  if stake > 0 then
    bal := public.wallet_move(me.id, -stake, 'bet', note);
    if bal is null then raise exception 'Not enough coins'; end if;
    if ret > 0 then bal := public.wallet_move(me.id, ret::bigint, case when won_side then 'win' else 'refund' end, note); end if;
  else
    select coins into bal from wallets where user_id = me.id;
  end if;
  return jsonb_build_object('cards', cards, 'winner', winner, 'payout', ret, 'stake', stake, 'balance', bal);
end;
$$;

revoke execute on function public.l7_pay(text, jsonb) from public, anon, authenticated;
revoke execute on function public.casino_round(text, jsonb, text) from public, anon;
grant execute on function public.casino_round(text, jsonb, text) to authenticated;
