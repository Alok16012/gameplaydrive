-- Teen Patti: compulsory Seen after 3 blind chaals (was 4). Sets the Admin → Game Config value, which both the
-- Supabase tables (tp_apply) and the Railway game server read; the server picks it up within 30 s.
insert into public.app_settings (key, value) values ('games', '{}')
on conflict (key) do nothing;
update public.app_settings
set value = jsonb_set(value, '{teen-patti}', coalesce(value -> 'teen-patti', '{}') || '{"blind_limit": 3}')
where key = 'games';
