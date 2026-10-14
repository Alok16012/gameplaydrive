-- 038: Roulette split and corner bets.
--   s_A_B          split: two numbers side by side on the table (B = A + 1 in the same column, or B = A + 3)  → 18x
--   q_A_B_C_D      corner: four numbers that meet at a corner (A, A+1, A+3, A+4, A not in the top row)         → 9x
-- Returns include the stake (like a straight number paying 36x). Any other side is still refused as an invalid bet.
-- Safe to run more than once. Run after 012. Run it in the Supabase SQL Editor.

create or replace function public.rl_pay(p_side text, n int) returns int
language plpgsql immutable set search_path = public as $$
declare
  red boolean := n = any (array[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
  a int; b int;
begin
  if p_side ~ '^n_([0-9]|[12][0-9]|3[0-6])$' then return case when substr(p_side, 3)::int = n then 36 else 0 end; end if;
  if p_side ~ '^s_[0-9]{1,2}_[0-9]{1,2}$' then
    a := split_part(p_side, '_', 2)::int; b := split_part(p_side, '_', 3)::int;
    if a < 1 or b > 36 or not (b = a + 3 or (b = a + 1 and a % 3 <> 0)) then return null; end if;
    return case when n = a or n = b then 18 else 0 end;
  end if;
  if p_side ~ '^q_[0-9]{1,2}_[0-9]{1,2}_[0-9]{1,2}_[0-9]{1,2}$' then
    a := split_part(p_side, '_', 2)::int;
    if a < 1 or a > 32 or a % 3 = 0 or p_side <> format('q_%s_%s_%s_%s', a, a + 1, a + 3, a + 4) then return null; end if;
    return case when n in (a, a + 1, a + 3, a + 4) then 9 else 0 end;
  end if;
  return case p_side
    when 'red' then case when red then 2 else 0 end
    when 'black' then case when n > 0 and not red then 2 else 0 end
    when 'even' then case when n > 0 and n % 2 = 0 then 2 else 0 end
    when 'odd' then case when n % 2 = 1 then 2 else 0 end
    when 'low' then case when n between 1 and 18 then 2 else 0 end
    when 'high' then case when n between 19 and 36 then 2 else 0 end
    when 'd1' then case when n between 1 and 12 then 3 else 0 end
    when 'd2' then case when n between 13 and 24 then 3 else 0 end
    when 'd3' then case when n between 25 and 36 then 3 else 0 end
    when 'c1' then case when n > 0 and n % 3 = 1 then 3 else 0 end
    when 'c2' then case when n > 0 and n % 3 = 2 then 3 else 0 end
    when 'c3' then case when n > 0 and n % 3 = 0 then 3 else 0 end
  end;
end;
$$;

revoke execute on function public.rl_pay(text, int) from public, anon, authenticated;
