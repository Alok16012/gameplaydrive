-- 055: a player no longer needs a mobile number — they can sign in with a username and password instead.
-- Every player must still have at least one of the two. Players who have a mobile number keep signing in with it
-- (or with their username, through /api/player-login); a player without one has a username login.
-- Safe to run more than once. Run after 036. Run it in the Supabase SQL Editor.

-- The table check from 001 (role <> 'player' or phone is not null) has no name, so find it by its definition.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.profiles'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%player%' and pg_get_constraintdef(oid) ilike '%phone IS NOT NULL%'
      and pg_get_constraintdef(oid) not ilike '%username%'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.profiles drop constraint if exists profiles_player_login_check;
alter table public.profiles add constraint profiles_player_login_check
  check (role <> 'player' or phone is not null or username is not null);

create or replace function public.update_profile(
  p_actor uuid, p_target uuid, p_name text, p_phone text, p_username text, p_state text, p_password_reset boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  actor profiles;
  t profiles;
  who text;
  changes jsonb := '[]';
  ch jsonb;
begin
  select * into actor from profiles where id = p_actor and status = 'active';
  if actor.id is null then raise exception 'Your account is not active'; end if;
  select * into t from profiles where id = p_target;
  if t.id is null then raise exception 'Account not found'; end if;
  if t.id = actor.id or not (actor.role = 'superadmin' or public.is_ancestor(actor.id, t.id)) then
    raise exception 'You can only edit accounts in your own network';
  end if;

  p_name := trim(coalesce(p_name, ''));
  if p_name = '' then raise exception 'Enter a name'; end if;
  p_phone := nullif(trim(coalesce(p_phone, '')), '');
  if p_phone is not null and p_phone !~ '^[0-9]{10}$' then raise exception 'Enter a 10-digit mobile number'; end if;
  if t.role = 'player' and p_phone is null and nullif(trim(coalesce(p_username, '')), '') is null then
    raise exception 'Players need a username or a mobile number to sign in';
  end if;
  if t.role = 'player' then
    p_username := nullif(lower(trim(coalesce(p_username, ''))), '');
    if p_username is not null and p_username !~ '^[a-z0-9._]{3,}$' then raise exception 'Username: at least 3 letters, numbers, dots or underscores'; end if;
    p_state := nullif(trim(coalesce(p_state, '')), '');
  else
    p_username := lower(trim(coalesce(p_username, '')));
    if p_username !~ '^[a-z0-9._]{3,}$' then raise exception 'Username: at least 3 letters, numbers, dots or underscores'; end if;
    p_state := t.state;
  end if;
  if p_phone is distinct from t.phone and exists (select 1 from profiles where phone = p_phone and id <> t.id) then
    raise exception 'That mobile number is already used by another account';
  end if;
  if p_username is distinct from t.username and exists (select 1 from profiles where username = p_username and id <> t.id) then
    raise exception 'That username is taken';
  end if;

  if p_name <> t.name then changes := changes || jsonb_build_array(jsonb_build_array('Name', t.name, p_name)); end if;
  if p_phone is distinct from t.phone then changes := changes || jsonb_build_array(jsonb_build_array('Mobile', coalesce(t.phone, '—'), coalesce(p_phone, '—'))); end if;
  if p_username is distinct from t.username then changes := changes || jsonb_build_array(jsonb_build_array('Username', coalesce(t.username, '—'), coalesce(p_username, '—'))); end if;
  if p_state is distinct from t.state then changes := changes || jsonb_build_array(jsonb_build_array('State', coalesce(t.state, '—'), coalesce(p_state, '—'))); end if;
  if p_password_reset then changes := changes || jsonb_build_array(jsonb_build_array('Password', '••••', 'reset')); end if;

  update profiles set name = p_name, phone = p_phone, username = p_username, state = p_state where id = t.id;

  who := initcap(t.role::text) || ' ' || t.code;
  for ch in select * from jsonb_array_elements(changes) loop
    insert into audit_log (actor_id, actor_name, action, before, after)
      values (actor.id, coalesce(actor.username, actor.name), who || ' • ' || (ch ->> 0), ch ->> 1, ch ->> 2);
  end loop;

  return jsonb_build_object('old', to_jsonb(t), 'new', (select to_jsonb(p) from profiles p where p.id = t.id), 'changed', jsonb_array_length(changes));
end;
$$;

revoke execute on function public.update_profile(uuid, uuid, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.update_profile(uuid, uuid, text, text, text, text, boolean) to service_role;
