create table public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null check (type in ('deposit', 'withdraw')),
  amount bigint,
  utr text,
  bank_details text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.payment_requests enable row level security;

create policy "Users can view their own payment requests"
  on public.payment_requests for select
  using (auth.uid() = user_id);

create policy "Users can insert their own payment requests"
  on public.payment_requests for insert
  with check (auth.uid() = user_id);

create policy "Admins and agents can view all payment requests"
  on public.payment_requests for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role in ('superadmin', 'admin', 'agent')
    )
  );

create policy "Admins and agents can update payment requests"
  on public.payment_requests for update
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role in ('superadmin', 'admin', 'agent')
    )
  );

