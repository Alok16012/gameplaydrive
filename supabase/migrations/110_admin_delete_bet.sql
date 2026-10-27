-- 110: Super Admin can delete a player's bet. The bet disappears everywhere — the player's Game History and coin
-- statement, the admin reports, the round lookup — and its coins are reversed as if it had never been placed: the
-- stake comes back and any winnings are taken back (one wallet change, no ledger line). A "bet" is one row of the
-- Game History: the ledger lines of one round (the admin screen sends their ids). The round's detail rows for that
-- player go too (casino round, roulette spin, blackjack hand, Aviator / Stock Market bets, Teen Patti / Poker hand
-- lines). Logged in the audit log for the Super Admin only (no account code in the text, so it is not filed under
-- the player and their agent / admin don't see it).

create or replace function public.admin_delete_bet(p_user uuid, p_ledger_ids bigint[])
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  net bigint; n int; bal bigint; note0 text; g_name text; num text; t0 timestamptz; t1 timestamptz; who text;
begin
  if not public.is_superadmin() then raise exception 'Only the Super Admin can delete bets'; end if;
  if coalesce(array_length(p_ledger_ids, 1), 0) = 0 then raise exception 'Nothing to delete'; end if;
  perform 1 from wallets where user_id = p_user for update;

  select coalesce(sum(amount), 0), count(*), min(note), min(created_at), max(created_at)
    into net, n, note0, t0, t1
  from ledger where id = any (p_ledger_ids) and user_id = p_user and kind in ('bet', 'win', 'refund');
  if n = 0 then raise exception 'That bet is already gone'; end if;
  if n <> array_length(p_ledger_ids, 1) then raise exception 'Only game bets can be deleted'; end if;

  -- Reverse its coins: a lost stake comes back (net < 0), winnings go back (net > 0).
  select coins into bal from wallets where user_id = p_user;
  if bal - net < 0 then
    raise exception 'The player has only % coins — taking back this bet''s winnings needs %', bal, net;
  end if;
  update wallets set coins = coins - net where user_id = p_user;

  -- The round's own records for this player.
  g_name := split_part(note0, ' • ', 1);
  num := substring(note0 from '(?:Hand|Round|Spin) #([0-9]+)');
  if num is not null then
    if g_name in ('Dragon Tiger', 'Andar Bahar', 'Lucky 7') then
      delete from casino_rounds where user_id = p_user and round = num
        and casino_rounds.game = case g_name when 'Dragon Tiger' then 'dragon-tiger' when 'Andar Bahar' then 'andar-bahar' else 'lucky-7' end
        and created_at between t0 - interval '5 minutes' and t1 + interval '5 minutes'; -- round numbers repeat across days
    elsif g_name = 'Roulette' then
      delete from rl_spins where user_id = p_user and (round = num or id::text = substring(note0 from 'Spin #([0-9]+)'))
        and created_at between t0 - interval '5 minutes' and t1 + interval '5 minutes';
    elsif g_name = 'Blackjack' then
      delete from bj_hands where user_id = p_user and id::text = num;
    elsif g_name = 'Aviator' then
      delete from av_bets where user_id = p_user and round_id::text = num;
    elsif g_name = 'Stock Market' then
      delete from sm_bets where user_id = p_user and round_id::text = num;
    elsif g_name = 'Teen Patti' then
      delete from tp2_ledger where user_id = p_user and hand_id like '%:' || num
        and created_at between t0 - interval '10 minutes' and t1 + interval '10 minutes';
    elsif g_name = 'Poker' then
      delete from pk_ledger where user_id = p_user and hand_id like '%:' || num
        and created_at between t0 - interval '10 minutes' and t1 + interval '10 minutes';
    end if;
  end if;

  delete from ledger where id = any (p_ledger_ids) and user_id = p_user;

  select name into who from profiles where id = p_user;
  insert into audit_log (actor_id, actor_name, action, before, after)
  values (auth.uid(), coalesce((select coalesce(username, name) from profiles where id = auth.uid()), 'superadmin'),
          'Deleted a bet of ' || coalesce(who, 'a player') || ' • ' || coalesce(note0, '') || ' • coins ' || case when net < 0 then '+' else '−' end || abs(net),
          bal::text, (bal - net)::text);

  return jsonb_build_object('deleted', n, 'coins_change', -net, 'balance', bal - net);
end;
$$;
revoke all on function public.admin_delete_bet(uuid, bigint[]) from public, anon;
grant execute on function public.admin_delete_bet(uuid, bigint[]) to authenticated;
notify pgrst, 'reload schema';
