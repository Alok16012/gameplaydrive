-- 063: Andar Bahar plays out naturally instead of ending on the first card or two.
-- When outcome control picked a side, casino_round moved the card matching the joker to position 1 or 2 of the
-- deck, so almost every round (fair mode applies control most of the time) was decided on the first card. It also
-- copied the wrong suit while swapping, which could put the same card in the deck twice. Now the deck keeps its
-- natural order and, only if the first match would land on the wrong side, that one card swaps places with the
-- next non-matching card. Everything else in casino_round is as in 062 (round details are still saved).
-- Safe to run more than once. Run after 062 in the Supabase SQL Editor.

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
      for idx0 in 0 .. 15 loop
        for idx1 in (idx0 + 1) .. 16 loop
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
          if (mode = 'force_loss' and cand_pay < best_pay) or (mode = 'force_win' and cand_pay > best_pay) then
            best_pay := cand_pay;
            best_c0 := cand_c0;
            best_c1 := cand_c1;
            best_w := cand_w;
            if (mode = 'force_loss' and best_pay = 0) or (mode = 'force_win' and best_pay > stake * 1.5) then
              exit;
            end if;
          end if;
        end loop;
        if (mode = 'force_loss' and best_pay = 0) or (mode = 'force_win' and best_pay > stake * 1.5) then
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
        if (mode = 'force_loss' and cand_pay < best_pay) or (mode = 'force_win' and cand_pay > best_pay) then
          best_pay := cand_pay;
          best_c0 := cand_c0;
          best_w := cand_w;
          if (mode = 'force_loss' and best_pay = 0) or (mode = 'force_win' and best_pay > stake * 1.5) then
            exit;
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
    joker := d -> 0;
    if mode in ('force_loss', 'force_win') then
      for b in select * from jsonb_array_elements(coalesce(p_bets, '[]')) loop
        if (b ->> 'side') in ('andar', 'bahar') then
          if mode = 'force_loss' then
            target_side := case when b ->> 'side' = 'andar' then 'bahar' else 'andar' end;
          else
            target_side := b ->> 'side';
          end if;
          exit;
        end if;
      end loop;

      if target_side is not null then
        -- Cards go Andar, Bahar, Andar, … from position 1, so Andar wins when the first card matching the joker
        -- sits at an odd position and Bahar at an even one. If the natural first match is on the wrong side, swap it
        -- with the next card that doesn't match: the round lasts about as long as it naturally would and no card is
        -- duplicated. (029 moved the match to position 1 or 2, so every controlled round ended on the first
        -- card or two.)
        for guard in 1 .. 4 loop
          target_idx := null;
          for k in 1 .. 51 loop
            if (d -> k ->> 'r') = (joker ->> 'r') then target_idx := k; exit; end if;
          end loop;
          exit when target_idx is null or (target_idx % 2 = 1) = (target_side = 'andar');
          for j in target_idx + 1 .. 51 loop
            if (d -> j ->> 'r') <> (joker ->> 'r') then
              c := d -> j;
              d := jsonb_set(jsonb_set(d, array[j::text], d -> target_idx), array[target_idx::text], c);
              exit;
            end if;
          end loop;
        end loop;
      end if;
    end if;

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
    insert into casino_rounds (user_id, game, round, bets, cards, winner, stake, payout)
      values (me.id, p_game, nullif(p_round, ''), coalesce(p_bets, '[]'), cards, winner, stake, ret::bigint);
  else
    select coins into bal from wallets where user_id = me.id;
  end if;
  return jsonb_build_object('cards', cards, 'winner', winner, 'payout', ret, 'stake', stake, 'balance', bal);
end;
$$;
