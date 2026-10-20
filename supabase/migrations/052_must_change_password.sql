-- 052: Add must_change_password flag to profiles.
-- When an admin/agent creates a player (or any subordinate) with a temporary password,
-- this flag is set to true. On the next login, the user is forced to change their password.
-- Self-registered players get false (they already chose their own password).

alter table public.profiles
  add column if not exists must_change_password boolean not null default false;

comment on column public.profiles.must_change_password is
  'When true the user must change their password on next login. Set by create_profile for staff-created accounts.';

-- Update create_profile to set must_change_password = true for accounts created by staff
create or replace function public.create_profile(
  p_id uuid, p_actor uuid, p_role public.app_role, p_name text, p_phone text, p_username text, p_parent uuid, p_state text
) returns public.profiles
language plpgsql security definer set search_path = public as $$
declare
  actor profiles;
  parent profiles;
  rank_of jsonb := '{"superadmin":0,"admin":1,"agent":2,"player":3}';
  prefix text := case p_role when 'admin' then 'ADM-' when 'agent' then 'AGT-' else 'GH' end;
  digits int := case p_role when 'player' then 6 else 4 end;
  new_code text;
  result profiles;
begin
  select * into actor from profiles where id = p_actor and status = 'active';
  if actor.id is null then raise exception 'Your account is not active'; end if;
  if (rank_of ->> actor.role::text)::int >= (rank_of ->> p_role::text)::int then
    raise exception '% accounts cannot create % accounts', initcap(actor.role::text), p_role;
  end if;
  select * into parent from profiles where id = coalesce(p_parent, p_actor) and status = 'active';
  if parent.id is null then raise exception 'Owner account not found or frozen'; end if;
  if parent.id <> actor.id and actor.role <> 'superadmin' and not public.is_ancestor(actor.id, parent.id) then
    raise exception 'Owner must be you or someone in your network';
  end if;
  if (rank_of ->> parent.role::text)::int >= (rank_of ->> p_role::text)::int then
    raise exception '% accounts cannot own % accounts', initcap(parent.role::text), p_role;
  end if;
  loop
    new_code := prefix || lpad((floor(random() * power(10, digits)))::int::text, digits, '0');
    exit when not exists (select 1 from profiles where code = new_code);
  end loop;
  insert into profiles (id, code, role, name, phone, username, parent_id, state, must_change_password)
    values (p_id, new_code, p_role, trim(p_name), p_phone, lower(p_username), parent.id, p_state, true)
    returning * into result;
  insert into wallets (user_id) values (p_id);
  insert into audit_log (actor_id, actor_name, action, before, after)
    values (actor.id, coalesce(actor.username, actor.name), initcap(p_role::text) || ' ' || new_code || ' created under ' || parent.name, '—', trim(p_name));
  return result;
end;
$$;
