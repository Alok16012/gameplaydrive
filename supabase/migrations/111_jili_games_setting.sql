-- 111: which JILI games players see — Admin → JILI Games (Super Admin). app_settings 'jili_games' holds the game_uids
-- that are switched off ({"hidden": [...]}); every other game on the SoftAPI account is shown. Anyone signed in can
-- read it (the app filters the lobby), only the Super Admin can change it (existing app_settings policies).
insert into public.app_settings (key, value) values ('jili_games', '{"hidden": []}') on conflict (key) do nothing;
