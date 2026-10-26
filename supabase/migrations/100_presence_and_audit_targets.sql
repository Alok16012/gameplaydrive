-- 100: who is online, and an Audit Log that admins / agents can actually use.
--
-- presence: the player app (and the admin console) calls touch_seen() every minute while it is open, so the
-- console can show Online (seen in the last ~2 minutes) / Offline with the last time a player was online.
-- Started from each account's last sign-in (login_events) so the "last online" column isn't empty on day one.
--
-- audit_log.target_id: the account an entry is about ("Coins to GH804658 (…)", "Agent AGT-9552 • Name", …), taken
-- from the account code in the action text. Admins and agents saw only entries *they or their downline* wrote, so
-- coins the Super Admin gave them or their players never showed up for them; now they also see entries about
-- themselves and their downline. /api/login-event writes a "Signed in" entry about the account itself.

create table if not exists public.presence (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  last_seen timestamptz not null default now()
);
alter table public.presence enable row level security;
revoke all on public.presence from anon, authenticated;
grant select on public.presence to authenticated;
drop policy if exists "see own and downline presence" on public.presence;
create policy "see own and downline presence" on public.presence for select
  using (public.is_superadmin() or user_id = auth.uid() or public.can_manage(user_id));

insert into public.presence (user_id, last_seen)
select user_id, max(created_at) from public.login_events group by user_id
on conflict (user_id) do nothing;

create or replace function public.touch_seen()
returns void
language sql
security definer
set search_path to 'public'
as $$
  insert into presence (user_id, last_seen)
  select auth.uid(), now() where auth.uid() is not null
  on conflict (user_id) do update set last_seen = now()
  where presence.last_seen < now() - interval '20 seconds';
$$;
revoke all on function public.touch_seen() from public, anon;
grant execute on function public.touch_seen() to authenticated;

alter table public.audit_log add column if not exists target_id uuid; -- no FK: entries outlive deleted accounts
create index if not exists audit_log_target_idx on public.audit_log (target_id);

create or replace function public.audit_target()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.target_id is null then
    select id into new.target_id from profiles
    where code = substring(new.action from '(GH[0-9]{4,}|ADM-[0-9]+|AGT-[0-9]+|SA-[0-9]+)');
  end if;
  return new;
end;
$$;
drop trigger if exists audit_log_target on public.audit_log;
create trigger audit_log_target before insert on public.audit_log for each row execute function public.audit_target();

update public.audit_log a set target_id = p.id
from public.profiles p
where a.target_id is null and p.code = substring(a.action from '(GH[0-9]{4,}|ADM-[0-9]+|AGT-[0-9]+|SA-[0-9]+)');

drop policy if exists "see own and downline audit" on public.audit_log;
create policy "see own and downline audit" on public.audit_log for select
  using (public.is_superadmin() or actor_id = auth.uid() or public.can_manage(actor_id)
         or target_id = auth.uid() or public.can_manage(target_id));
