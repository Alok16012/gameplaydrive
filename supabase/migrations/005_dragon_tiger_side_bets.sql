-- 005: Dragon Tiger side bets, and a re-run of the function permissions.
--
-- Side bets (total return per coin, stake included):
--   pair            Dragon and Tiger show the same rank            ×12
--   d_even / t_even card rank is even (2,4,6,8,10,Q)               ×2.1
--   d_odd  / t_odd  card rank is odd (A,3,5,7,9,J,K)               ×1.79
--   d_black/t_black ♠ or ♣                                         ×1.95
--   d_red  / t_red  ♥ or ♦                                         ×1.95
--   d_<R>  / t_<R>  exact rank, e.g. d_A, t_10, d_K                ×12
-- Main bets are unchanged (Dragon/Tiger ×2, Tie ×9, Dragon/Tiger stakes get 50% back on a tie).
--
-- Safe to run more than once. Run it in the Supabase SQL Editor.

create or replace function public.dt_pay(p_side text, p_d jsonb, p_t jsonb, p_winner text) returns numeric
language plpgsql immutable set search_path = public as $$
declare c jsonb; key text; v int;
begin
  if p_side in ('dragon', 'tiger', 'tie') then
    return case when p_side = p_winner then (case p_side when 'tie' then 9 else 2 end) else 0 end;
  end if;
  if p_side = 'pair' then return case when p_d ->> 'r' = p_t ->> 'r' then 12 else 0 end; end if;
  c := case left(p_side, 1) when 'd' then p_d else p_t end;
  key := substr(p_side, 3);
  v := public.card_low(c ->> 'r');
  return case key
    when 'even' then case when v % 2 = 0 then 2.1 else 0 end
    when 'odd' then case when v % 2 = 1 then 1.79 else 0 end
    when 'black' then case when c ->> 's' in ('♠', '♣') then 1.95 else 0 end
    when 'red' then case when c ->> 's' in ('♥', '♦') then 1.95 else 0 end
    else case when key = c ->> 'r' then 12 else 0 end
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
            or (p_game = 'dragon-tiger' and (b ->> 'side') ~ '^(pair|[dt]_(even|odd|black|red|A|[2-9]|10|J|Q|K))$'))
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

  -- Payouts (stake included): 1:1 → ×2, Tie 8:1 → ×9, Exactly 7 11:1 → ×12. Dragon Tiger tie refunds 50% of side bets.
  for b in select * from jsonb_array_elements(coalesce(p_bets, '[]')) loop
    if p_game = 'dragon-tiger' then
      if public.dt_pay(b ->> 'side', d -> 0, d -> 1, winner) > 0 then
        ret := ret + (b ->> 'v')::bigint * public.dt_pay(b ->> 'side', d -> 0, d -> 1, winner);
        won_side := true;
      elsif winner = 'tie' and b ->> 'side' in ('dragon', 'tiger') then
        ret := ret + (b ->> 'v')::bigint / 2.0;
      end if;
      continue;
    end if;
    if b ->> 'side' = winner then
      ret := ret + (b ->> 'v')::bigint * (case b ->> 'side' when 'tie' then 9 when 'seven' then 12 else 2 end);
      won_side := true;
    elsif p_game = 'dragon-tiger' and winner = 'tie' then
      ret := ret + (b ->> 'v')::bigint / 2.0;
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

-- ---------------------------------------------------------------- permissions (same as setup_all.sql)

revoke execute on all functions in schema public from public, anon;
grant usage on schema public to authenticated;
grant execute on all functions in schema public to authenticated, service_role;
do $$
declare f text;
begin
  -- Internal engine functions: only callable from other functions, never directly from the app.
  foreach f in array array[
    'create_profile(uuid, uuid, public.app_role, text, text, text, uuid, text)', 'write_audit(text, text, text)',
    'wallet_move(uuid, bigint, text, text)', 'make_bot(text[])', 'dt_pay(text, jsonb, jsonb, text)',
    'tp_set_turn(public.tp_tables, int)', 'tp_start_hand(public.tp_tables)', 'tp_finish(public.tp_tables, int, text, boolean)',
    'tp_showdown(public.tp_tables)', 'tp_apply(public.tp_tables, int, text)', 'tp_bot_move(public.tp_tables)',
    'tp_advance(public.tp_tables)', 'tp_save(public.tp_tables)', 'tp_view(public.tp_tables)', 'tp_pay(public.tp_tables, int, bigint)',
    'tp_pass(public.tp_tables, int)', 'tp_request_sideshow(public.tp_tables, int)', 'tp_resolve_sideshow(public.tp_tables, boolean)',
    'rm_set_turn(public.rm_tables, int)', 'rm_start(public.rm_tables)', 'rm_end_deal(public.rm_tables, int)', 'rm_pass(public.rm_tables, int)',
    'rm_draw(public.rm_tables, int, text)', 'rm_throw(public.rm_tables, int, int)', 'rm_discard(public.rm_tables, int, int)',
    'rm_declare(public.rm_tables, int, int, jsonb)', 'rm_drop(public.rm_tables, int)', 'rm_timeout(public.rm_tables)',
    'rm_bot_move(public.rm_tables)', 'rm_advance(public.rm_tables)', 'rm_save(public.rm_tables)', 'rm_view(public.rm_tables)']
  loop
    execute 'revoke execute on function public.' || f || ' from authenticated';
  end loop;
end $$;
