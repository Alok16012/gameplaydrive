-- 120: Bharat Matka (iGaming SoftAPI brand 202, game 1001325) on the JILI pipeline, from its own SoftAPI account
-- (MATKA_TOKEN / MATKA_SECRET). jili_settle takes the ledger note's game label ("Matka • Bharat Matka • Round #…"),
-- and "matka" joins the games that can be locked (per player and in Game Config).

begin;

drop function if exists public.jili_settle(text, bigint, text, text, text, numeric, numeric, numeric);
CREATE OR REPLACE FUNCTION public.jili_settle(p_serial text, p_member bigint, p_game_uid text, p_game_name text, p_round text, p_bet numeric, p_win numeric, p_credit numeric, p_label text DEFAULT 'JILI'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid; c numeric; total numeric; b bigint; w bigint; bal bigint; short bigint := 0; note text; rid text;
begin
  if p_serial is null or p_serial = '' then raise exception 'serial_number missing'; end if;
  if exists (select 1 from jili_tx where serial = p_serial) then return jsonb_build_object('duplicate', true); end if;
  select user_id, carry into uid, c from jili_players where num = p_member for update;
  if uid is null then raise exception 'unknown member %', p_member; end if;
  p_bet := greatest(coalesce(p_bet, 0), 0); p_win := greatest(coalesce(p_win, 0), 0);

  -- Whole coins only: the stake rounded up, the win making up the exact net, the fraction carried to next time.
  total := p_win - p_bet + c;
  b := ceil(p_bet)::bigint;
  w := (floor(total) + b)::bigint;
  update jili_players set carry = total - floor(total) where num = p_member;

  rid := coalesce(nullif(regexp_replace(coalesce(p_round, ''), '[^0-9]', '', 'g'), ''), regexp_replace(p_serial, '[^0-9]', '', 'g'));
  note := coalesce(nullif(trim(p_label), ''), 'JILI') || ' • ' || coalesce(nullif(trim(p_game_name), ''), 'Game ' || coalesce(p_game_uid, '')) || ' • Round #' || coalesce(nullif(rid, ''), '0');

  if b > 0 then
    update wallets set coins = coins - b, updated_at = now() where user_id = uid and coins >= b returning coins into bal;
    if bal is null then -- not enough coins left: take what is there, note the rest
      select coins into bal from wallets where user_id = uid for update;
      short := b - bal;
      update wallets set coins = 0, updated_at = now() where user_id = uid;
      b := bal; bal := 0;
    end if;
    if b > 0 then insert into ledger (user_id, amount, balance_after, kind, note) values (uid, -b, bal, 'bet', note || ' • Bet'); end if;
  end if;
  if w > 0 then
    update wallets set coins = coins + w, updated_at = now() where user_id = uid returning coins into bal;
    insert into ledger (user_id, amount, balance_after, kind, note) values (uid, w, bal, 'win', note || ' • Win');
  end if;

  insert into jili_tx (serial, user_id, game_uid, game_name, game_round, bet, win, credit, coins_change, shortfall)
  values (p_serial, uid, p_game_uid, p_game_name, p_round, p_bet, p_win, p_credit, w - b, short);
  select coins into bal from wallets where user_id = uid;
  return jsonb_build_object('ok', true, 'balance', bal, 'coins_change', w - b, 'shortfall', short);
end;
$function$;
revoke all on function public.jili_settle(text, bigint, text, text, text, numeric, numeric, numeric, text) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_game_settings(p_game text, p_cfg jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare old jsonb := public.game_cfg(p_game); new jsonb := public.game_cfg(p_game); k text; v jsonb; n numeric;
        games text[] := array['teen-patti','rummy','andar-bahar','dragon-tiger','lucky-7','aviator','roulette','plinko','blackjack','poker','ludo','carrom','chess','stock-market','cricket','jili','matka'];
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
      if p_game not in ('teen-patti', 'rummy', 'poker') then continue; end if;
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
    elsif k = 'rtp' then
      if p_game not in ('dragon-tiger', 'andar-bahar', 'lucky-7', 'aviator', 'roulette', 'plinko', 'blackjack', 'teen-patti', 'rummy', 'poker', 'ludo', 'chess') then continue; end if;
      if v = 'null'::jsonb or v = '""'::jsonb then new := new - k; continue; end if;
      n := (v #>> '{}')::numeric;
      if n < 70 or n > 99 then raise exception 'RTP must be between 70%% and 99%%'; end if;
      new := new || jsonb_build_object(k, round(n, 1));
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
$function$;

CREATE OR REPLACE FUNCTION public.set_player_games(target uuid, p_locked text[])
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  ok text[] := array['cricket','teen-patti','rummy','poker','andar-bahar','dragon-tiger','lucky-7','ludo','stock-market',
                     'aviator','roulette','blackjack','jili','plinko','chess','matka'];
  clean text[]; old text[]; who text;
begin
  if not public.can_manage(target) then raise exception 'Not allowed'; end if;
  select coalesce(array_agg(distinct g order by g), '{}') into clean from unnest(coalesce(p_locked, '{}')) g;
  if exists (select 1 from unnest(clean) g where not (g = any (ok))) then raise exception 'Unknown game'; end if;
  select locked_games, initcap(role::text) || ' ' || code into old, who from profiles where id = target;
  if who is null then raise exception 'Account not found'; end if;
  update profiles set locked_games = clean where id = target;
  perform public.write_audit(who || ' • games locked',
    case when cardinality(old) = 0 then 'none' else array_to_string(old, ', ') end,
    case when cardinality(clean) = 0 then 'none' else array_to_string(clean, ', ') end);
  return clean;
end;
$function$;

CREATE OR REPLACE FUNCTION public.player_game_guard(p_uid uuid, p_game text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare g text := public.game_lock_id(p_game); names jsonb := '{"cricket":"Cricket Live","teen-patti":"Teen Patti","rummy":"Rummy",
  "poker":"Poker","andar-bahar":"Andar Bahar","dragon-tiger":"Dragon Tiger","lucky-7":"Lucky 7","ludo":"Ludo","stock-market":"Stock Market",
  "aviator":"Aviator","roulette":"Roulette","blackjack":"Blackjack","jili":"JILI Games","plinko":"Plinko","chess":"Chess","matka":"Bharat Matka"}';
begin
  if p_uid is not null and exists (select 1 from profiles where id = p_uid and g = any (locked_games)) then
    raise exception '% is locked for your account — please contact your agent', coalesce(names ->> g, initcap(replace(g, '-', ' ')));
  end if;
end;
$function$;

-- Matka settle lines, like JILI's, record rounds already played in the provider's game (the lock is checked at launch).
create or replace function public.ledger_lock_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare g text;
begin
  if new.kind = 'bet' and new.amount < 0 then
    g := public.game_lock_id(public.game_key(new.note));
    if g not in ('teen-patti', 'poker', 'rummy', 'jili', 'matka') then perform public.player_game_guard(new.user_id, g); end if;
  end if;
  return new;
end;
$$;

commit;
notify pgrst, 'reload schema';
