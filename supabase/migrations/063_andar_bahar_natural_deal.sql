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
    -- Andar Bahar: Joker at d->0. Deal alternately to Andar (1) and Bahar (2).
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
          if st_andar > st_bahar then
            target_side := 'bahar';
          elsif st_bahar > st_andar then
            target_side := 'andar';
          elsif st_andar > 0 then
            target_side := case when random() < 0.5 then 'andar' else 'bahar' end;
          end if;
        else -- force_win
          if st_andar > st_bahar then
            target_side := 'andar';
          elsif st_bahar > st_andar then
            target_side := 'bahar';
          elsif st_andar > 0 then
            target_side := case when random() < 0.5 then 'andar' else 'bahar' end;
          end if;
        end if;
      end;
    end if;

    -- If fair mode or equal bets, randomly choose winning side so round stays thrilling and deep
    if target_side is null then
      target_side := case when random() < 0.5 then 'andar' else 'bahar' end;
    end if;

    -- Engaging deal length (never 1 or 2 cards!):
    -- Andar wins on odd position: 7, 9, 11, 13, 15, 17, 19
    -- Bahar wins on even position: 8, 10, 12, 14, 16, 18, 20
    if target_side = 'andar' then
      target_idx := (2 * (floor(random() * 7)::int + 3)) + 1;
    else
      target_idx := 2 * (floor(random() * 7)::int + 4);
    end if;

    -- Rearrange deck d so that:
    -- 1) d[0] is joker
    -- 2) d[1 .. target_idx - 1] are guaranteed non-matching cards (no premature finish)
    -- 3) d[target_idx] matches joker's rank (exact decisive finish on target side)
    -- 4) Remaining cards complete the 52-card deck
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

      -- Non-matching cards before target_idx
      for k in 1 .. (target_idx - 1) loop
        new_d := new_d || jsonb_build_array(other_cards -> (k - 1));
      end loop;

      -- The winning matching card at target_idx
      new_d := new_d || jsonb_build_array(match_cards -> 0);

      -- Rest of the deck
      for k in (target_idx - 1) .. (jsonb_array_length(other_cards) - 1) loop
        new_d := new_d || jsonb_build_array(other_cards -> k);
      end loop;
      for k in 1 .. (jsonb_array_length(match_cards) - 1) loop
        new_d := new_d || jsonb_build_array(match_cards -> k);
      end loop;

      d := new_d;
    end;

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
