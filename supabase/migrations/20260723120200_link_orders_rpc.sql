-- Backfill-on-login for customer accounts: claim unclaimed guest orders whose
-- email matches the verified login email, case-insensitively. Kept in SQL so
-- the predicate is exactly the expression orders_unclaimed_email_idx indexes —
-- lower(email) over the (user_id IS NULL AND email IS NOT NULL) partial — which
-- the PostgREST ILIKE operator cannot use.
--
-- Invoker rights (house style, like reserve_pieces): the auth callback calls it
-- with the service-role key; any other role hits the orders table's deny-all
-- RLS and claims nothing. The user_id IS NULL guard makes claims one-shot and
-- user_unlinked_at IS NULL permanently excludes orders released by an account
-- deletion (see docs/customer-accounts-runbook.md).
create or replace function link_orders_to_user(
  p_user_id uuid,
  p_email   text
) returns integer
language sql
set search_path = public, pg_temp
as $$
  with claimed as (
    update orders
       set user_id = p_user_id
     where user_id is null
       and user_unlinked_at is null
       and email is not null
       and lower(email) = lower(p_email)
    returning id
  )
  select count(*)::integer from claimed;
$$;

-- Encode the server-side boundary explicitly: Postgres grants EXECUTE to
-- PUBLIC on new functions by default, which would also surface this via
-- PostgREST /rpc for anon/authenticated. Invoker rights + orders' deny-all RLS
-- already make such calls claim nothing, but the auth callback (service role)
-- is the only intended caller — say so in the ACL.
revoke execute on function link_orders_to_user(uuid, text) from public, anon, authenticated;
grant execute on function link_orders_to_user(uuid, text) to service_role;
