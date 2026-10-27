-- 103: Roulette — the inside bets a real table takes on the edges of the number grid: street (3 numbers, 12x),
-- six line (6 numbers, 6x), split with zero (0-1 / 0-2 / 0-3, 18x), trio (0-1-2 / 0-2-3, 12x) and first four
-- (0-1-2-3, 9x). Payouts are total returns per coin, like the rest of rl_pay. rl_pick reads rl_pay, so the ball
-- picker and settlement need no change. This is rl_pay as it was live, with the new bets added.

CREATE OR REPLACE FUNCTION public.rl_pay(p_side text, n integer)
 RETURNS integer
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare
  red boolean := n = any (array[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
  a int; b int;
begin
  if p_side ~ '^n_([0-9]|[12][0-9]|3[0-6])$' then return case when substr(p_side, 3)::int = n then 36 else 0 end; end if;
  if p_side ~ '^s_[0-9]{1,2}_[0-9]{1,2}$' then
    a := split_part(p_side, '_', 2)::int; b := split_part(p_side, '_', 3)::int;
    if a = 0 and b between 1 and 3 then return case when n in (0, b) then 18 else 0 end; end if; -- 0 with 1, 2 or 3
    if a < 1 or b > 36 or not (b = a + 3 or (b = a + 1 and a % 3 <> 0)) then return null; end if;
    return case when n = a or n = b then 18 else 0 end;
  end if;
  if p_side ~ '^q_[0-9]{1,2}_[0-9]{1,2}_[0-9]{1,2}_[0-9]{1,2}$' then
    a := split_part(p_side, '_', 2)::int;
    if a < 1 or a > 32 or a % 3 = 0 or p_side <> format('q_%s_%s_%s_%s', a, a + 1, a + 3, a + 4) then return null; end if;
    return case when n in (a, a + 1, a + 3, a + 4) then 9 else 0 end;
  end if;
  -- Street (a row of three: a, a+1, a+2) and six line (two rows: a … a+5), on the outer edge of the number grid.
  if p_side ~ '^st_[0-9]{1,2}$' then
    a := substr(p_side, 4)::int;
    if a < 1 or a > 34 or a % 3 <> 1 then return null; end if;
    return case when n between a and a + 2 then 12 else 0 end;
  end if;
  if p_side ~ '^sl_[0-9]{1,2}$' then
    a := substr(p_side, 4)::int;
    if a < 1 or a > 31 or a % 3 <> 1 then return null; end if;
    return case when n between a and a + 5 then 6 else 0 end;
  end if;
  -- With the zero: trios 0-1-2 / 0-2-3 and the first four 0-1-2-3.
  if p_side = 't_0_1_2' then return case when n in (0, 1, 2) then 12 else 0 end; end if;
  if p_side = 't_0_2_3' then return case when n in (0, 2, 3) then 12 else 0 end; end if;
  if p_side = 'ff' then return case when n between 0 and 3 then 9 else 0 end; end if;
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
$function$;
