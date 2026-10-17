-- Index the foreign keys that had none, so deleting a profile doesn't scan these tables.
create index if not exists ledger_counterparty_idx on public.ledger (counterparty);
create index if not exists audit_log_actor_idx on public.audit_log (actor_id);
create index if not exists sport_bets_settled_by_idx on public.sport_bets (settled_by);
