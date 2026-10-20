-- Migration 054: Cascade Account Freeze to all downline accounts
-- When an account (Admin, Agent, etc.) is frozen, all accounts under it recursively
-- (agents, players) are also frozen automatically.
-- On unfreeze, caller can unfreeze the whole downline tree or just the account.

drop function if exists public.set_account_status(uuid, text);
drop function if exists public.set_account_status(uuid, text, boolean);

create or replace function public.set_account_status(
  target uuid, 
  new_status text, 
  cascade_downline boolean default true
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  old text;
  who text;
  rows_updated integer := 0;
begin
  if new_status not in ('active', 'frozen') then 
    raise exception 'Invalid status'; 
  end if;

  if not public.can_manage(target) then 
    raise exception 'Not allowed'; 
  end if;

  select status, initcap(role::text) || ' ' || code into old, who 
  from profiles 
  where id = target;

  if who is null then
    raise exception 'Account not found';
  end if;

  -- If activating, prevent activation if any ancestor account is currently frozen
  if new_status = 'active' then
    if exists (
      with recursive up as (
        select id, parent_id, status from profiles where id = target
        union all
        select p.id, p.parent_id, p.status from profiles p join up on p.id = up.parent_id
      )
      select 1 from up where id <> target and status = 'frozen'
    ) then
      raise exception 'Cannot activate account because its parent/ancestor account is frozen. Please activate the parent account first.';
    end if;
  end if;

  if cascade_downline then
    -- Freezes (or unfreezes) target AND all downline accounts recursively
    with recursive down as (
      select id from profiles where id = target
      union all
      select p.id from profiles p join down on p.parent_id = down.id
    )
    update profiles
    set status = new_status
    where id in (select id from down);

    get diagnostics rows_updated = row_count;

    perform public.write_audit(
      who || case when rows_updated > 1 then ' (and ' || (rows_updated - 1) || ' downline accounts)' else '' end, 
      old, 
      new_status
    );
  else
    -- Single account update only
    update profiles set status = new_status where id = target;
    rows_updated := 1;
    perform public.write_audit(who, old, new_status);
  end if;

  return rows_updated;
end;
$$;

grant execute on function public.set_account_status(uuid, text, boolean) to authenticated, service_role;
