-- 053: Allow both Super Admin and Admin to update the WhatsApp contact number for ID & Support.
-- Supports pre-filled message and custom note.

create or replace function public.set_support_contact(
  p_whatsapp text,
  p_note text default null,
  p_message text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  num text := regexp_replace(coalesce(p_whatsapp, ''), '\D', '', 'g');
  old jsonb := coalesce((select value from app_settings where key = 'support'), '{}'::jsonb);
  v jsonb;
begin
  if me.id is null or me.role not in ('superadmin', 'admin') then
    raise exception 'Only an Admin or Super Admin can change the WhatsApp contact number';
  end if;
  if length(num) = 10 then num := '91' || num; end if;
  if num <> '' and (length(num) < 11 or length(num) > 15) then
    raise exception 'Enter the WhatsApp number with country code, e.g. +91 98765 43210';
  end if;
  v := jsonb_strip_nulls(jsonb_build_object(
    'whatsapp', nullif(num, ''),
    'note', nullif(trim(coalesce(p_note, '')), ''),
    'message', nullif(trim(coalesce(p_message, '')), '')
  ));
  insert into app_settings (key, value) values ('support', v)
    on conflict (key) do update set value = excluded.value;
  insert into audit_log (actor_id, actor_name, action, before, after)
    values (me.id, coalesce(me.username, me.name), 'WhatsApp contact for ID changed', old::text, v::text);
  return v;
end;
$$;

create or replace function public.support_contact() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select value from app_settings where key = 'support'), '{}'::jsonb);
$$;

grant execute on function public.set_support_contact(text, text, text) to authenticated;
grant execute on function public.support_contact() to anon, authenticated;
