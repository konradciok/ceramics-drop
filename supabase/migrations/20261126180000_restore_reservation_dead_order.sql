-- restore_transferred_reservation: never park a hold under a dead order.
--
-- The edit endpoint restores the hold when Stripe will not cancel the old
-- PaymentIntent (the buyer's other tab just paid, or a transient error). If
-- the payment landed first, markPaid already ran against the old order while
-- the pieces sat under the unsent attempt id: it sold nothing, refunded the
-- payment and marked the order `failed`. Moving the pieces back under that
-- order (as the first version did) left them `reserved` for a full TTL under
-- an order no consumer revisits — the shop could not sell them until it
-- lapsed. The same holds for an order the `payment_intent.canceled` webhook
-- already expired.
--
-- Now: when the old order is dead (failed / expired / refunded) the held
-- pieces are released instead — back on sale, or back to `sold` for a
-- private-sale order (the same target as every other release, see
-- releaseTargetStatus) — and 0 is returned. A pending order, a paid one
-- (markPaid mid-flight still finds its pieces) or a missing row behave as
-- before. The order row is locked for the statement so its status cannot
-- move between the read and the update.
create or replace function public.restore_transferred_reservation(p_attempt uuid, p_order uuid, p_ttl_secs integer)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  moved integer;
  o record;
begin
  if p_attempt is null or p_order is null or p_attempt = p_order then
    raise exception 'invalid_transfer';
  end if;
  if exists (select 1 from orders where id = p_attempt) then
    raise exception 'transfer_target_exists';
  end if;

  select status, private_sale_id into o from orders where id = p_order for update;

  if found and o.status in ('failed', 'expired', 'refunded') then
    update piece_state
       set status = (case when o.private_sale_id is not null then 'sold' else 'available' end)::piece_status,
           order_id = null,
           reserved_until = null
     where order_id = p_attempt
       and status = 'reserved';
    return 0;
  end if;

  update piece_state
     set order_id = p_order,
         reserved_until = now() + make_interval(secs => least(greatest(coalesce(p_ttl_secs, 900), 60), 3600))
   where order_id = p_attempt
     and status = 'reserved'
     and reserved_until > now();
  get diagnostics moved = row_count;
  return moved;
end;
$$;

revoke all on function public.restore_transferred_reservation(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.restore_transferred_reservation(uuid, uuid, integer) to service_role;
