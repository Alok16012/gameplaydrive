-- 050: Ludo Win/Loss Outcome Control & Force Loss Enforcement
--
-- 1. game_payout: Hard barrier preventing force_loss players from receiving winnings across board games.
-- 2. my_outcome_mode: Fast RPC for client board games to fetch their exact win/loss mode.
-- 3. ld_roll & ld_finish: Rigorous outcome control for private/multiplayer Ludo tables.
--
-- Safe to run more than once. Run in the Supabase SQL Editor.

-- 1. Fast outcome mode lookup RPC for authenticated client games
create or replace function public.my_outcome_mode(p_game text) returns text
language sql security definer set search_path = public as $$
  select coalesce(public.get_outcome_mode(auth.uid(), p_game), 'fair');
$$;
grant execute on function public.my_outcome_mode(text) to authenticated, anon;

-- 2. game_payout with strict Force Loss barrier
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

  -- Rigorous Force Loss Enforcement:
  -- If player is targeted or game mode is force_loss, NEVER payout winnings!
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
revoke execute on function public.game_payout(bigint, text, text) from public, anon;
grant execute on function public.game_payout(bigint, text, text) to authenticated;

-- 3. ld_roll with outcome control for multiplayer Ludo
create or replace function public.ld_roll(t public.ld_tables) returns public.ld_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  d int := 1 + floor(random() * 6)::int;
  opts int[];
  turn_uid uuid;
  p_mode text;
  has_out boolean;
begin
  if t.phase <> 'roll' then raise exception 'Not time to roll'; end if;

  turn_uid := (t.seats -> t.turn ->> 'uid')::uuid;
  if turn_uid is not null then
    p_mode := public.get_outcome_mode(turn_uid, 'ludo');
    if p_mode = 'force_loss' then
      -- If all tokens in yard: do not give 6
      select exists (select 1 from jsonb_array_elements(t.seats -> t.turn -> 'tokens') x where x::int >= 0) into has_out;
      if not has_out then
        d := 1 + floor(random() * 5)::int; -- roll 1 to 5 only
      elsif d = 6 and random() < 0.85 then
        d := 1 + floor(random() * 5)::int;
      end if;
    elsif p_mode = 'force_win' then
      select exists (select 1 from jsonb_array_elements(t.seats -> t.turn -> 'tokens') x where x::int = -1) into has_out;
      if has_out and random() < 0.65 then
        d := 6;
      end if;
    end if;
  end if;

  t.dice := d;
  if d = 6 then t.sixes := t.sixes + 1; else t.sixes := 0; end if;
  if t.sixes >= 3 then
    t.last := jsonb_build_object('kind', 'skip', 'seat', t.turn, 'dice', d, 'why', 'three sixes');
    return public.ld_next(t);
  end if;
  opts := public.ld_movable(t, t.turn, d);
  if cardinality(opts) = 0 then
    t.last := jsonb_build_object('kind', 'nomove', 'seat', t.turn, 'dice', d);
    return public.ld_next(t);
  end if;
  t.phase := 'move';
  t.last := jsonb_build_object('kind', 'roll', 'seat', t.turn, 'dice', d);
  t.turn_ends := greatest(t.turn_ends, now() + interval '10 seconds');
  if cardinality(opts) = 1 then return public.ld_move(t, opts[1]); end if;
  return t;
end;
$$;

-- 4. ld_finish with outcome control
create or replace function public.ld_finish(t public.ld_tables, w int) returns public.ld_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  w_uid uuid;
  p_mode text;
  alt_winner int;
begin
  t.status := 'done'; t.winner := w; t.phase := null; t.turn_ends := null;
  t.prize := floor(t.pot * (1 - public.ld_fee()));

  if t.prize > 0 then
    w_uid := (t.seats -> w ->> 'uid')::uuid;
    if w_uid is not null then
      p_mode := public.get_outcome_mode(w_uid, 'ludo');
      if p_mode = 'force_loss' then
        select (i - 1) into alt_winner from jsonb_array_elements(t.seats) with ordinality x(v, i)
        where (i - 1) <> w and not coalesce((v ->> 'left')::boolean, false) limit 1;
        if alt_winner is not null then
          t.winner := alt_winner;
          perform public.wallet_move((t.seats -> alt_winner ->> 'uid')::uuid, t.prize, 'win', 'Ludo • Private ' || t.code);
        end if;
        return t;
      end if;
    end if;

    perform public.wallet_move((t.seats -> w ->> 'uid')::uuid, t.prize, 'win', 'Ludo • Private ' || t.code);
  end if;
  return t;
end;
$$;
