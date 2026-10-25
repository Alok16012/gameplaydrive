-- 087: Roulette — 0 comes up about once in forty spins, whatever the bets; the rest is random.
--
-- 079 drew a losing spin from the numbers that leave the player down. When the bets cover the whole table (red and
-- black, odd and even, all three dozens…) the only such number is 0, so 0 came up on every one of those spins, and
-- players noticed. Now every spin first decides, with a 1-in-40 chance, whether the ball lands on 0 at all; when it
-- doesn't, 0 is out of the draw and the number comes from 1-36: at random among the numbers that leave the player
-- down (force_loss) or up (force_win), or, when no such number exists, among those that pay the least / the most.
-- Fair spins: the same 1-in-40 for 0, then any of 1-36.
--
-- Safe to run more than once.

begin;

create or replace function public.rl_pick(p_bets jsonb, p_mode text) returns int
language plpgsql volatile set search_path = public as $$
declare
  stake bigint := 0; b jsonb; cand_n int; cand_pay bigint; pays bigint[] := '{}';
  wanted int[] := '{}'; edge int[] := '{}'; edge_pay bigint;
begin
  -- The ball lands on 0 about once in forty spins, and only then.
  if random() < 1.0 / 40 then return 0; end if;

  for b in select * from jsonb_array_elements(p_bets) loop stake := stake + (b ->> 'v')::bigint; end loop;
  for cand_n in 0 .. 36 loop
    cand_pay := 0;
    for b in select * from jsonb_array_elements(p_bets) loop
      cand_pay := cand_pay + (b ->> 'v')::bigint * coalesce(public.rl_pay(b ->> 'side', cand_n), 0);
    end loop;
    pays := pays || cand_pay;
  end loop;

  if p_mode = 'force_loss' then
    -- Every number from 1 to 36 that leaves the player down; failing that, the ones that pay them the least.
    edge_pay := null;
    for cand_n in 1 .. 36 loop
      if pays[cand_n + 1] < stake then wanted := wanted || cand_n; end if;
      if edge_pay is null or pays[cand_n + 1] < edge_pay then edge_pay := pays[cand_n + 1]; edge := array[cand_n];
      elsif pays[cand_n + 1] = edge_pay then edge := edge || cand_n; end if;
    end loop;
  elsif p_mode = 'force_win' then
    edge_pay := null;
    for cand_n in 1 .. 36 loop
      if pays[cand_n + 1] > stake then wanted := wanted || cand_n; end if;
      if edge_pay is null or pays[cand_n + 1] > edge_pay then edge_pay := pays[cand_n + 1]; edge := array[cand_n];
      elsif pays[cand_n + 1] = edge_pay then edge := edge || cand_n; end if;
    end loop;
  else
    return 1 + floor(random() * 36)::int;
  end if;

  if coalesce(array_length(wanted, 1), 0) = 0 then wanted := edge; end if;
  return wanted[1 + floor(random() * array_length(wanted, 1))::int];
end;
$$;

revoke execute on function public.rl_pick(jsonb, text) from public, anon, authenticated;

commit;
