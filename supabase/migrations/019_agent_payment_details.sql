-- 019: Agent UPI and QR payment details for player deposits.
--   • Agents (and Admins/Super Admins who manage players) can configure their UPI ID, payee name, QR code, and payment instructions.
--   • Strict Row-Level Security:
--       - Staff can only view and edit their own payment details.
--       - Active players can ONLY see the payment details of the direct parent agent who created them.
--       - No player can see any other agent's payment details.
--   • Helper RPC get_my_agent_payment_info() for players to easily fetch their agent's payment details.
-- Safe to run more than once. Run after 018. Run it in the Supabase SQL Editor.

create table if not exists public.agent_payment_details (
  agent_id uuid primary key references public.profiles(id) on delete cascade,
  upi_id text,
  qr_code_url text,
  payee_name text,
  phone text,
  payment_note text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.agent_payment_details enable row level security;

-- Drop existing policies if re-running
drop policy if exists "agents manage own payment details" on public.agent_payment_details;
drop policy if exists "superadmin manages all payment details" on public.agent_payment_details;
drop policy if exists "players see parent payment details" on public.agent_payment_details;

-- Staff manage own payment details
create policy "agents manage own payment details" on public.agent_payment_details
  for all to authenticated
  using (agent_id = auth.uid())
  with check (agent_id = auth.uid());

-- Super Admin can manage all
create policy "superadmin manages all payment details" on public.agent_payment_details
  for all to authenticated
  using (public.is_superadmin())
  with check (public.is_superadmin());

-- Players can ONLY see their own parent's active payment details
create policy "players see parent payment details" on public.agent_payment_details
  for select to authenticated
  using (
    is_active = true and exists (
      select 1 from public.profiles
      where id = auth.uid() and parent_id = agent_payment_details.agent_id and status = 'active'
    )
  );

-- RPC for Player App: returns ONLY caller's own agent's payment info
create or replace function public.get_my_agent_payment_info()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me profiles;
  parent_prof profiles;
  p_details record;
begin
  select * into me from profiles where id = auth.uid() and status = 'active';
  if me.id is null or me.parent_id is null then return null; end if;
  
  select * into parent_prof from profiles where id = me.parent_id;
  if parent_prof.id is null then return null; end if;

  select * into p_details from agent_payment_details where agent_id = me.parent_id and is_active = true;
  
  return jsonb_build_object(
    'has_payment_details', (p_details.agent_id is not null),
    'agent_name', parent_prof.name,
    'agent_code', parent_prof.code,
    'agent_phone', coalesce(p_details.phone, parent_prof.phone),
    'upi_id', p_details.upi_id,
    'qr_code_url', p_details.qr_code_url,
    'payee_name', coalesce(p_details.payee_name, parent_prof.name),
    'payment_note', p_details.payment_note,
    'is_active', coalesce(p_details.is_active, false)
  );
end;
$$;

grant execute on function public.get_my_agent_payment_info() to authenticated;
