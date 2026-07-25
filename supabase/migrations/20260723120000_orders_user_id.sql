-- Customer accounts: link orders to Supabase Auth users.
-- ON DELETE SET NULL is a safety backstop only — account deletion runs through
-- a runbook procedure (unlink + stamp user_unlinked_at, THEN delete the auth
-- user) so order rows survive as guest-like rows for accounting/legal retention
-- (see docs/customer-accounts-runbook.md).
-- RLS stance unchanged: orders stays enabled/deny-all with zero policies; all
-- reads continue through the service-role client, filtered server-side by the
-- JWT-verified user id.
alter table orders
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  -- Stamped by the account-deletion procedure; excludes these rows from
  -- backfill-on-login forever, so deleted-account history can never be
  -- silently re-claimed by a later login with the same email address.
  add column if not exists user_unlinked_at timestamptz;

create index if not exists orders_user_id_idx
  on orders(user_id) where user_id is not null;

-- Backfill-on-login runs:
--   WHERE user_id IS NULL AND user_unlinked_at IS NULL AND lower(email) = lower($1)
create index if not exists orders_unclaimed_email_idx
  on orders(lower(email)) where user_id is null and email is not null;
