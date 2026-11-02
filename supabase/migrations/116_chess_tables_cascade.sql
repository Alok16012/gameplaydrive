-- 116: Deleting a player who ever hosted or joined a Chess table failed ("violates foreign key constraint
-- ch_tables_host_fkey"): ch_tables referenced profiles without on delete. Their tables go with them now, like every
-- other game's rows.

begin;
alter table public.ch_tables drop constraint if exists ch_tables_host_fkey;
alter table public.ch_tables add constraint ch_tables_host_fkey foreign key (host) references public.profiles (id) on delete cascade;
alter table public.ch_tables drop constraint if exists ch_tables_guest_fkey;
alter table public.ch_tables add constraint ch_tables_guest_fkey foreign key (guest) references public.profiles (id) on delete cascade;
commit;
