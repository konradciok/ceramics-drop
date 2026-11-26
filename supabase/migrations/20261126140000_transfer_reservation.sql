-- Hand a pending checkout's live reservation to the buyer's next attempt.
--
-- Used by POST /api/checkout/edit ("Zmień" on the payment step): the buyer
-- goes back to the delivery form, so the old PaymentIntent is cancelled and
-- the old order expired. Its pieces move to the new attempt id in one
-- statement, so they are never `available` in between — no other buyer can
-- take them while the form is being corrected. The new checkout POST then
-- finds them reserved for its own order id, which reserve_pieces accepts.
--
-- Only still-live holds move (an expired one must pass the new-sale rules
-- again through reserve_pieces). The hold is renewed to p_ttl_secs, clamped
-- like reserve_pieces. Calling it with the arguments swapped moves the hold
-- back (the edit endpoint does that when Stripe refuses to cancel).
-- piece_state.order_id carries no foreign key, so p_to need not exist yet —
-- the same as reserve_pieces, which runs before the order row is written.
create function public.transfer_reservation(p_from uuid, p_to uuid, p_ttl_secs integer)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  moved integer;
begin
  if p_from is null or p_to is null or p_from = p_to then
    raise exception 'invalid_transfer';
  end if;
  update piece_state
     set order_id = p_to,
         reserved_until = now() + make_interval(secs => least(greatest(coalesce(p_ttl_secs, 900), 60), 3600))
   where order_id = p_from
     and status = 'reserved'
     and reserved_until > now();
  get diagnostics moved = row_count;
  return moved;
end;
$$;

revoke all on function public.transfer_reservation(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.transfer_reservation(uuid, uuid, integer) to service_role;
