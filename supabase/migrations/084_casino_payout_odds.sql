-- 084: Dragon Tiger and Lucky 7 pay the advertised odds (migration 073 overpaid every win by one stake).
--
-- dt_pay() and l7_pay() return the total return multiple — 2 for a 1:1 bet (stake back plus the same again),
-- 9 for Tie at 1:8, 12 for Pair / Seven at 11:1 — and the screen shows these as ×2, ×9, ×12. 073's settlement
-- multiplied the stake by (1 + that), so a 6,000 Tiger bet returned 18,000 instead of 12,000, a 100 Seven bet 1,300
-- instead of 1,200. Andar Bahar was right. The settlement now multiplies by the multiple alone, as the odds say and
-- as the force_loss / force_win candidate scoring in the same function already does.
--
-- Safe to run more than once.

begin;

CREATE OR REPLACE FUNCTION public.casino_round(p_game text, p_bets jsonb, p_round text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  mode text;
  best_pay numeric;
  cand_pay numeric;
  cand_c0 jsonb;
  cand_c1 jsonb;
  cand_w text;
  best_c0 jsonb := null;
  best_c1 jsonb := null;
  best_w text := null;
  target_side text := null;
  target_idx int;
  rank_diff int;
  best_diff int := 99;
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

  mode := public.get_outcome_mode(me.id, p_game);

  if p_game = 'dragon-tiger' then
    if mode in ('force_loss', 'force_win') then
      best_pay := case when mode = 'force_loss' then 999999999999 else -1 end;
      for idx0 in 0 .. 25 loop
        for idx1 in (idx0 + 1) .. 26 loop
          cand_c0 := d -> idx0;
          cand_c1 := d -> idx1;
          cand_w := case when card_low(cand_c0 ->> 'r') = card_low(cand_c1 ->> 'r') then 'tie'
                         when card_low(cand_c0 ->> 'r') > card_low(cand_c1 ->> 'r') then 'dragon' else 'tiger' end;
          cand_pay := 0;
          for b in select * from jsonb_array_elements(coalesce(p_bets, '[]')) loop
            if public.dt_pay(b ->> 'side', cand_c0, cand_c1, cand_w) > 0 then
              cand_pay := cand_pay + (b ->> 'v')::bigint * public.dt_pay(b ->> 'side', cand_c0, cand_c1, cand_w);
            elsif cand_w = 'tie' and b ->> 'side' in ('dragon', 'tiger') then
              cand_pay := cand_pay + (b ->> 'v')::bigint / 2.0;
            end if;
          end loop;

          rank_diff := abs(card_low(cand_c0 ->> 'r') - card_low(cand_c1 ->> 'r'));

          if mode = 'force_loss' then
            -- Prefer 0 payout, and among 0 payouts prefer a tight 1-point difference (nail-biter!)
            if cand_pay = 0 and rank_diff < best_diff and rank_diff >= 1 then
              best_pay := 0;
              best_diff := rank_diff;
              best_c0 := cand_c0;
              best_c1 := cand_c1;
              best_w := cand_w;
              if best_diff = 1 then exit; end if;
            elsif cand_pay < best_pay then
              best_pay := cand_pay;
              best_c0 := cand_c0;
              best_c1 := cand_c1;
              best_w := cand_w;
            end if;
          elsif mode = 'force_win' then
            if cand_pay > best_pay then
              best_pay := cand_pay;
              best_c0 := cand_c0;
              best_c1 := cand_c1;
              best_w := cand_w;
              if best_pay > stake * 1.5 then exit; end if;
            end if;
          end if;
        end loop;
        if (mode = 'force_loss' and best_diff = 1) or (mode = 'force_win' and best_pay > stake * 1.5) then
          exit;
        end if;
      end loop;

      if best_c0 is not null then
        cards := jsonb_build_object('dragon', best_c0, 'tiger', best_c1);
        winner := best_w;
        d := jsonb_build_array(best_c0, best_c1) || d;
      else
        cards := jsonb_build_object('dragon', d -> 0, 'tiger', d -> 1);
        winner := case when card_low(d -> 0 ->> 'r') = card_low(d -> 1 ->> 'r') then 'tie'
                       when card_low(d -> 0 ->> 'r') > card_low(d -> 1 ->> 'r') then 'dragon' else 'tiger' end;
      end if;
    else
      cards := jsonb_build_object('dragon', d -> 0, 'tiger', d -> 1);
      winner := case when card_low(d -> 0 ->> 'r') = card_low(d -> 1 ->> 'r') then 'tie'
                     when card_low(d -> 0 ->> 'r') > card_low(d -> 1 ->> 'r') then 'dragon' else 'tiger' end;
    end if;

  elsif p_game = 'lucky-7' then
    if mode in ('force_loss', 'force_win') then
      best_pay := case when mode = 'force_loss' then 999999999999 else -1 end;
      for idx0 in 0 .. 51 loop
        cand_c0 := d -> idx0;
        cand_w := case when card_low(cand_c0 ->> 'r') < 7 then 'below' when card_low(cand_c0 ->> 'r') = 7 then 'seven' else 'above' end;
        cand_pay := 0;
        for b in select * from jsonb_array_elements(coalesce(p_bets, '[]')) loop
          if public.l7_pay(b ->> 'side', cand_c0) > 0 then
            cand_pay := cand_pay + (b ->> 'v')::bigint * public.l7_pay(b ->> 'side', cand_c0);
          end if;
        end loop;

        rank_diff := abs(card_low(cand_c0 ->> 'r') - 7);

        if mode = 'force_loss' then
          -- Prefer near misses (ranks 6, 8, or 7) so players see close calls
          if cand_pay = 0 and rank_diff <= 1 then
            best_pay := 0;
            best_c0 := cand_c0;
            best_w := cand_w;
            exit;
          elsif cand_pay < best_pay then
            best_pay := cand_pay;
            best_c0 := cand_c0;
            best_w := cand_w;
          end if;
        elsif mode = 'force_win' then
          if cand_pay > best_pay then
            best_pay := cand_pay;
            best_c0 := cand_c0;
            best_w := cand_w;
            if best_pay > stake * 1.5 then exit; end if;
          end if;
        end if;
      end loop;

      if best_c0 is not null then
        cards := jsonb_build_object('card', best_c0);
        winner := best_w;
        d := jsonb_build_array(best_c0) || d;
      else
        cards := jsonb_build_object('card', d -> 0);
        winner := case when card_low(d -> 0 ->> 'r') < 7 then 'below' when card_low(d -> 0 ->> 'r') = 7 then 'seven' else 'above' end;
      end if;
    else
      cards := jsonb_build_object('card', d -> 0);
      winner := case when card_low(d -> 0 ->> 'r') < 7 then 'below' when card_low(d -> 0 ->> 'r') = 7 then 'seven' else 'above' end;
    end if;

  else
    -- Andar Bahar: Preserved engaging 7 to 20 cards deal from migration 064
    joker := d -> 0;
    target_side := null;

    if mode in ('force_loss', 'force_win') then
      declare
        st_andar bigint := 0;
        st_bahar bigint := 0;
      begin
        for b in select * from jsonb_array_elements(coalesce(p_bets, '[]')) loop
          if (b ->> 'side') = 'andar' then st_andar := st_andar + (b ->> 'v')::bigint; end if;
          if (b ->> 'side') = 'bahar' then st_bahar := st_bahar + (b ->> 'v')::bigint; end if;
        end loop;

        if mode = 'force_loss' then
          if st_andar > st_bahar then target_side := 'bahar';
          elsif st_bahar > st_andar then target_side := 'andar';
          elsif st_andar > 0 then target_side := case when random() < 0.5 then 'andar' else 'bahar' end;
          end if;
        else
          if st_andar > st_bahar then target_side := 'andar';
          elsif st_bahar > st_andar then target_side := 'bahar';
          elsif st_andar > 0 then target_side := case when random() < 0.5 then 'andar' else 'bahar' end;
          end if;
        end if;
      end;
    end if;

    if target_side is null then
      target_side := case when random() < 0.5 then 'andar' else 'bahar' end;
    end if;

    -- Deep deal (7 to 20 cards)
    if target_side = 'andar' then
      target_idx := (2 * (floor(random() * 7)::int + 3)) + 1;
    else
      target_idx := 2 * (floor(random() * 7)::int + 4);
    end if;

    declare
      match_cards jsonb := '[]'::jsonb;
      other_cards jsonb := '[]'::jsonb;
      new_d jsonb := jsonb_build_array(joker);
      k int;
    begin
      for k in 1 .. 51 loop
        if (d -> k ->> 'r') = (joker ->> 'r') then
          match_cards := match_cards || jsonb_build_array(d -> k);
        else
          other_cards := other_cards || jsonb_build_array(d -> k);
        end if;
      end loop;

      for k in 1 .. (target_idx - 1) loop
        new_d := new_d || jsonb_build_array(other_cards -> (k - 1));
      end loop;
      new_d := new_d || jsonb_build_array(match_cards -> 0);
      for k in (target_idx - 1) .. (jsonb_array_length(other_cards) - 1) loop
        new_d := new_d || jsonb_build_array(other_cards -> k);
      end loop;
      for k in 1 .. (jsonb_array_length(match_cards) - 1) loop
        new_d := new_d || jsonb_build_array(match_cards -> k);
      end loop;
      d := new_d;
    end;

    while i <= 51 loop
      c := d -> i;
      if side = 'andar' then
        andar := andar || jsonb_build_array(c);
        if (c ->> 'r') = (joker ->> 'r') then winner := 'andar'; exit; end if;
        side := 'bahar';
      else
        bahar := bahar || jsonb_build_array(c);
        if (c ->> 'r') = (joker ->> 'r') then winner := 'bahar'; exit; end if;
        side := 'andar';
      end if;
      i := i + 1;
    end loop;
    cards := jsonb_build_object('joker', joker, 'andar', andar, 'bahar', bahar);
  end if;

  for b in select * from jsonb_array_elements(coalesce(p_bets, '[]')) loop
    if p_game = 'dragon-tiger' then
      if public.dt_pay(b ->> 'side', cards -> 'dragon', cards -> 'tiger', winner) > 0 then
        ret := ret + (b ->> 'v')::bigint * public.dt_pay(b ->> 'side', cards -> 'dragon', cards -> 'tiger', winner);
        won_side := true;
      elsif winner = 'tie' and (b ->> 'side') in ('dragon', 'tiger') then
        ret := ret + (b ->> 'v')::bigint / 2.0;
      end if;
    elsif p_game = 'lucky-7' then
      if public.l7_pay(b ->> 'side', cards -> 'card') > 0 then
        ret := ret + (b ->> 'v')::bigint * public.l7_pay(b ->> 'side', cards -> 'card');
        won_side := true;
      end if;
    else
      if (b ->> 'side') = winner then
        ret := ret + (b ->> 'v')::bigint * case when winner = 'andar' then 1.9 else 2.0 end;
        won_side := true;
      end if;
    end if;
  end loop;

  -- Both ledger lines carry the round number, so a round can be looked up from the ledger alone.
  note := (names ->> p_game) || case when p_round <> '' then ' • Round #' || p_round else '' end;
  if public.wallet_move(me.id, -stake, 'bet', note || ' • Bet') is null then raise exception 'Not enough coins'; end if;
  if ret > 0 then
    bal := public.wallet_move(me.id, floor(ret)::bigint, 'win', note || case when won_side then ' • Win' else ' • Loss' end);
  else
    select coins into bal from wallets where user_id = me.id;
  end if;

  -- The round itself (bets, cards, winner, stake, payout) for Reports → Find a round. Dropped by 073; restored.
  insert into casino_rounds (user_id, game, round, bets, cards, winner, stake, payout)
    values (me.id, p_game, nullif(p_round, ''), coalesce(p_bets, '[]'), cards, winner, stake, floor(ret)::bigint);

  insert into game_stakes (user_id, game, amount, settled) values (me.id, p_game, stake, true);

  return jsonb_build_object('cards', cards, 'winner', winner, 'payout', floor(ret)::bigint, 'balance', bal);
end;
$function$;

commit;
