-- Cricket exchange bets, kept on the server so they can be settled.
-- Players place bets through place_sport_bet (stake/liability debited, exposure and profit computed here, never
-- trusted from the browser). The Super Admin declares each market's result with settle_sport_market, which
-- pays every open bet on that market in one transaction and writes it all to the ledger.

create table public.sport_bets (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  sport text not null default 'cricket',
  event_id text not null,
  event_name text not null,
  market_type text not null check (market_type in ('MATCH_ODDS', 'BOOKMAKER', 'FANCY', 'TIE', 'TOSS')),
  market_name text not null,
  runner_name text not null,
  bet_type text not null check (bet_type in ('BACK', 'LAY')),
  odds numeric not null check (odds > 0),
  line numeric,                     -- fancy: the runs line (YES = BACK, NO = LAY)
  stake bigint not null check (stake > 0),
  exposure bigint not null check (exposure >= 0),
  profit bigint not null check (profit >= 0),
  status text not null default 'OPEN' check (status in ('OPEN', 'WON', 'LOST', 'VOID')),
  result text,
  payout bigint not null default 0,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  settled_by uuid references public.profiles (id) on delete set null
);
create index sport_bets_user_idx on public.sport_bets (user_id, created_at desc);
create index sport_bets_open_idx on public.sport_bets (event_id, market_name) where status = 'OPEN';

alter table public.sport_bets enable row level security;
create policy "see own and downline sport bets" on public.sport_bets for select to authenticated
  using (user_id = auth.uid() or public.can_manage(user_id));

-- ---------------------------------------------------------------- place a bet

create or replace function public.place_sport_bet(
  p_sport text, p_event_id text, p_event_name text, p_market_type text, p_market_name text,
  p_runner_name text, p_bet_type text, p_odds numeric, p_line numeric, p_stake bigint
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  rate numeric;
  v_exposure bigint;
  v_profit bigint;
  bal bigint;
  new_id bigint;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if p_stake is null or p_stake < 100 or p_stake > 500000 then raise exception 'Invalid stake'; end if;
  if p_bet_type not in ('BACK', 'LAY') then raise exception 'Invalid bet type'; end if;
  if p_market_type not in ('MATCH_ODDS', 'BOOKMAKER', 'FANCY', 'TIE', 'TOSS') then raise exception 'Invalid market'; end if;
  if coalesce(trim(p_event_id), '') = '' or coalesce(trim(p_market_name), '') = '' or coalesce(trim(p_runner_name), '') = '' then
    raise exception 'Invalid bet';
  end if;
  if p_market_type = 'FANCY' and p_line is null then raise exception 'Invalid fancy line'; end if;

  -- Bookmaker rates are quoted per 100 (e.g. 85 = 0.85 profit per coin); exchange odds are decimal.
  rate := case when p_market_type = 'BOOKMAKER' then p_odds / 100 else p_odds - 1 end;
  if rate is null or rate <= 0 or rate > 1000 then raise exception 'Invalid odds'; end if;

  if p_bet_type = 'BACK' then
    v_exposure := p_stake;
    v_profit := round(p_stake * rate);
  else
    v_exposure := round(p_stake * rate);
    v_profit := p_stake;
  end if;

  bal := public.wallet_move(me.id, -v_exposure, 'bet',
    upper(coalesce(p_sport, 'cricket')) || ': ' || p_event_name || ' • ' || p_runner_name
    || ' [' || p_bet_type || ' @ ' || p_odds || ' | Stake: ' || p_stake || ']');
  if bal is null then raise exception 'Not enough coins'; end if;

  insert into sport_bets (user_id, sport, event_id, event_name, market_type, market_name, runner_name, bet_type,
                          odds, line, stake, exposure, profit)
  values (me.id, coalesce(p_sport, 'cricket'), p_event_id, p_event_name, p_market_type, p_market_name, p_runner_name,
          p_bet_type, p_odds, p_line, p_stake, v_exposure, v_profit)
  returning id into new_id;

  return jsonb_build_object('id', new_id, 'balance', bal, 'exposure', v_exposure, 'profit', v_profit);
end;
$$;

-- ---------------------------------------------------------------- declare a result (Super Admin)

-- p_result: the winning runner's name for MATCH_ODDS / BOOKMAKER / TIE / TOSS markets, the final runs for a
-- FANCY market, or 'VOID' to refund every open bet on the market.
-- Winning bets get back their exposure plus profit; void bets get their exposure back; losing bets get nothing.
create or replace function public.settle_sport_market(p_event_id text, p_market_name text, p_result text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b sport_bets;
  is_void boolean := upper(trim(coalesce(p_result, ''))) = 'VOID';
  runs numeric;
  won boolean;
  pay bigint;
  n_won int := 0; n_lost int := 0; n_void int := 0; total_paid bigint := 0;
  note text;
begin
  if not public.is_superadmin() then raise exception 'Only the Super Admin can declare results'; end if;
  if coalesce(trim(p_result), '') = '' then raise exception 'Choose a result'; end if;

  for b in
    select * from sport_bets where event_id = p_event_id and market_name = p_market_name and status = 'OPEN'
    order by id for update
  loop
    if is_void then
      won := null;
    elsif b.market_type = 'FANCY' then
      begin
        runs := trim(p_result)::numeric;
      exception when others then
        raise exception 'Enter the final runs as a number for a fancy market';
      end;
      -- YES (BACK) wins when the runs reach the line; NO (LAY) wins when they fall short.
      won := case when b.bet_type = 'BACK' then runs >= b.line else runs < b.line end;
    else
      won := (b.bet_type = 'BACK') = (lower(trim(b.runner_name)) = lower(trim(p_result)));
    end if;

    pay := case when won is null then b.exposure when won then b.exposure + b.profit else 0 end;
    note := upper(b.sport) || ': ' || b.event_name || ' • ' || b.market_name || ' • ' || b.runner_name
      || ' [' || b.bet_type || '] • Result: ' || trim(p_result);
    if pay > 0 then
      perform public.wallet_move(b.user_id, pay, case when won is null then 'refund' else 'win' end, note);
    end if;

    update sport_bets
      set status = case when won is null then 'VOID' when won then 'WON' else 'LOST' end,
          result = trim(p_result), payout = pay, settled_at = now(), settled_by = auth.uid()
      where id = b.id;

    if won is null then n_void := n_void + 1; elsif won then n_won := n_won + 1; else n_lost := n_lost + 1; end if;
    total_paid := total_paid + pay;
  end loop;

  if n_won + n_lost + n_void = 0 then raise exception 'No open bets on this market'; end if;

  perform public.write_audit('Declared result', p_event_id || ' • ' || p_market_name,
    trim(p_result) || ' (won ' || n_won || ', lost ' || n_lost || ', void ' || n_void || ', paid ' || total_paid || ')');

  return jsonb_build_object('won', n_won, 'lost', n_lost, 'void', n_void, 'paid', total_paid);
end;
$$;

revoke execute on function public.place_sport_bet(text, text, text, text, text, text, text, numeric, numeric, bigint),
  public.settle_sport_market(text, text, text) from public, anon;
grant execute on function public.place_sport_bet(text, text, text, text, text, text, text, numeric, numeric, bigint),
  public.settle_sport_market(text, text, text) to authenticated;
