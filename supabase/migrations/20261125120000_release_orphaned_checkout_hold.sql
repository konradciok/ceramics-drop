-- Checkout: free a hold only when no live order owns it.
--
-- Two checkout POSTs with the same attemptId share one order id, and so one
-- hold. Request A creates its PaymentIntent but has not inserted its orders row
-- yet; request B (same attemptId) fails at Stripe, finds no order and frees the
-- hold. A then inserts its pending order and hands its buyer a payable
-- client_secret while the pieces are `available` again (double-sell).
--
-- This function is half of the fix. It locks the order's reserved piece rows
-- FIRST and only then checks for a live order, in a later statement, which
-- under READ COMMITTED reads a fresh snapshot. It frees nothing while a live
-- order exists. The other half is in src/app/api/checkout/route.ts: after its
-- orders insert, a checkout calls reserve_pieces again before it answers with
-- the client_secret. That call locks the same rows, so the two serialise on
-- the piece rows:
--   * release first: the re-reserve waits, then finds the rows freed and
--     re-takes them, or reports them taken and the checkout rolls back;
--   * re-reserve first: its orders insert committed before the release's
--     check, so the release sees the live order and frees nothing.
--
-- `pending` and `paid` both own the hold: the webhook's markPaid sets the order
-- to paid before it sets the pieces to sold, so a paid order's rows can still
-- read `reserved` for a moment.
--
-- Expand-only: a new function, no existing function or caller changes. If the
-- worker deploys before this migration, its release call errors and the hold
-- stays until the 15-minute reservation TTL (fails safe).
begin;

create function public.release_orphaned_checkout_hold(p_order_id uuid, p_target_status text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_order_id is null then
    raise exception 'order_id_required';
  end if;
  if p_target_status is null or p_target_status not in ('available', 'sold') then
    raise exception 'invalid_release_target';
  end if;

  -- Same lock order as reserve_pieces (piece_state rows by product_id).
  perform 1 from piece_state
   where order_id = p_order_id and status = 'reserved'
   order by product_id
   for update;

  if exists (
    select 1 from orders
     where id = p_order_id and status in ('pending', 'paid')
  ) then
    return 'live_order';
  end if;

  update piece_state
     set status = p_target_status::piece_status,
         reserved_until = null,
         order_id = null
   where order_id = p_order_id and status = 'reserved';

  return 'released';
end;
$$;

revoke all on function public.release_orphaned_checkout_hold(uuid, text) from public, anon, authenticated;
grant execute on function public.release_orphaned_checkout_hold(uuid, text) to service_role;

commit;
