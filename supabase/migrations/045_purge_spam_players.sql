-- Remove the fake players a script signed up on 2026-10-15 (~26k accounts, random names like "garsghxdc").
-- Run by hand in Supabase → SQL Editor. Run STEP 1 first and check the numbers, then run STEP 2.
--
-- A player counts as spam only if ALL of these hold:
--   • role = player, signed up 15–17 Oct 2026 (IST), before the sign-up guard went live
--   • self-registered straight under the super admin (no agent / referral code)
--   • never touched coins: no ledger rows, coin balance 0, no payment requests
--   • has no downline
-- Deleting the auth user cascades to profiles, wallets, ledger, bets and the rest.

-- STEP 1: preview — how many would go, per day, and a sample of names.
with spam as (
  select p.id, p.name, p.created_at
  from public.profiles p
  left join public.wallets w on w.user_id = p.id
  where p.role = 'player'
    and p.created_at >= '2026-10-15 00:00+05:30'
    and p.created_at <  '2026-10-18 00:00+05:30'
    and p.parent_id = (select id from public.profiles where role = 'superadmin' limit 1)
    and coalesce(w.coins, 0) = 0
    and not exists (select 1 from public.ledger l where l.user_id = p.id)
    and not exists (select 1 from public.payment_requests r where r.user_id = p.id)
    and not exists (select 1 from public.profiles c where c.parent_id = p.id)
)
select (created_at at time zone 'Asia/Kolkata')::date as day, count(*) as players, (array_agg(name))[1:5] as sample
from spam group by 1 order by 1;

-- STEP 2: delete them (same filter).
delete from auth.users u
using public.profiles p
left join public.wallets w on w.user_id = p.id
where u.id = p.id
  and p.role = 'player'
  and p.created_at >= '2026-10-15 00:00+05:30'
  and p.created_at <  '2026-10-18 00:00+05:30'
  and p.parent_id = (select id from public.profiles where role = 'superadmin' limit 1)
  and coalesce(w.coins, 0) = 0
  and not exists (select 1 from public.ledger l where l.user_id = p.id)
  and not exists (select 1 from public.payment_requests r where r.user_id = p.id)
  and not exists (select 1 from public.profiles c where c.parent_id = p.id);
