-- 021: Help & Support contact — a WhatsApp number (and an optional short note) that the Super Admin sets and
-- every player sees on the Help screen and the login page. Only for support chats.
-- Safe to run more than once. Run after 018. Run it in the Supabase SQL Editor.

insert into public.app_settings (key, value) values ('support', '{}'::jsonb) on conflict (key) do nothing;

-- Super Admin: set (or clear, with an empty number) the support WhatsApp number. Stored as digits with the
-- country code (a 10-digit Indian number gets 91 in front). Every change goes to the audit log.
create or replace function public.set_support_contact(p_whatsapp text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  num text := regexp_replace(coalesce(p_whatsapp, ''), '\D', '', 'g');
  old jsonb := coalesce((select value from app_settings where key = 'support'), '{}'::jsonb);
  v jsonb;
begin
  if not public.is_superadmin() then raise exception 'Only the Super Admin can change the support number'; end if;
  if length(num) = 10 then num := '91' || num; end if;
  if num <> '' and (length(num) < 11 or length(num) > 15) then
    raise exception 'Enter the WhatsApp number with country code, e.g. +91 98765 43210';
  end if;
  if length(coalesce(p_note, '')) > 140 then raise exception 'Keep the note under 140 characters'; end if;
  v := jsonb_strip_nulls(jsonb_build_object('whatsapp', nullif(num, ''), 'note', nullif(trim(coalesce(p_note, '')), '')));
  insert into app_settings (key, value) values ('support', v) on conflict (key) do update set value = excluded.value;
  insert into audit_log (actor_id, actor_name, action, before, after)
    values (me.id, me.name, 'Support contact changed', old::text, v::text);
  return v;
end;
$$;

-- Anyone may read it, signed in or not (the login page shows it too).
create or replace function public.support_contact() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select value from app_settings where key = 'support'), '{}'::jsonb);
$$;

revoke execute on function public.set_support_contact(text, text) from public, anon;
grant execute on function public.set_support_contact(text, text) to authenticated;
grant execute on function public.support_contact() to anon, authenticated;
