begin;

create function begin_balance_intent(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare o orders;
begin
  select * into o from orders where id=p_order_id for update;
  if not found or o.gift_card_id is null or o.status<>'pending' or o.refund_pending_at is not null or o.cash_amount<=0 then raise exception 'order_not_prepared'; end if;
  update orders set balance_intent_started_at=coalesce(balance_intent_started_at,now()) where id=o.id returning * into o;
  return to_jsonb(o);
end;
$$;

create function prepare_remaining_balance_refund(p_order_id uuid,p_refund_id uuid)
returns gift_card_refunds language plpgsql security definer set search_path=public,pg_temp as $$
declare o orders; r gift_card_refunds; remaining integer;
begin
  select * into o from orders where id=p_order_id for update;
  if not found or o.gift_card_id is null then raise exception 'order_not_refundable'; end if;
  select * into r from gift_card_refunds where id=p_refund_id and order_id=o.id;
  if found then return r; end if;
  select o.total-coalesce(sum(amount),0) into remaining from gift_card_refunds where order_id=o.id and status='settled';
  return prepare_gift_card_refund(o.id,p_refund_id,remaining);
end;
$$;

-- Only the verified Stripe adapter calls this after cancellation/full cash
-- compensation. Order state, ceramic holds and card hold change together.
create function abort_balance_order(p_order_id uuid,p_intent_id text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare o orders;
begin
  select * into o from orders where id=p_order_id for update;
  if not found or o.gift_card_id is null then raise exception 'balance_order_missing'; end if;
  if o.status in ('paid','refunded') then return false; end if;
  if o.payment_intent_id is distinct from p_intent_id then raise exception 'gift_card_payment_mismatch'; end if;
  -- A missing partial-payment PI is ambiguous: creation may have succeeded.
  if p_intent_id is null and o.cash_amount>0 and o.balance_intent_started_at is not null then raise exception 'payment_outcome_unknown'; end if;
  update orders set status='failed',refund_pending_at=null,expiry_claim_at=null where id=o.id;
  perform release_gift_card(o.id,p_intent_id);
  update piece_state set status=case when o.private_sale_id is null then 'available' else 'sold' end,
    order_id=null,reserved_until=null where order_id=o.id and status='reserved';
  return true;
end;
$$;

-- Dashboard refunds have no internal refund UUID. Reconcile the cumulative
-- CONFIRMED cash amount, never a delivery delta (events can arrive out of order).
-- Internal refunds must be settled first, using their Stripe metadata UUID.
create function reconcile_balance_cash_refund(p_order_id uuid,p_cash_refunded integer)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare o orders; c gift_cards; cash_before bigint; card_before bigint;
  card_target integer; cash_delta integer; card_delta integer; refund_id uuid;
begin
  select * into o from orders where id=p_order_id for update;
  if not found or o.gift_card_id is null or o.status not in ('paid','refunded') then raise exception 'order_not_refundable'; end if;
  if o.cash_amount<=0 or p_cash_refunded is null or p_cash_refunded<0 or p_cash_refunded>o.cash_amount then raise exception 'invalid_refund_amount'; end if;
  if exists(select 1 from gift_card_refunds where order_id=o.id and status='pending') then raise exception 'refund_in_progress'; end if;
  select coalesce(sum(cash_amount),0),coalesce(sum(gift_card_amount),0) into cash_before,card_before
    from gift_card_refunds where order_id=o.id and status='settled';
  if p_cash_refunded<=cash_before then return 0; end if;
  card_target:=floor((p_cash_refunded::bigint*o.gift_card_amount+floor(o.cash_amount/2.0))/o.cash_amount);
  card_delta:=greatest(0,card_target-card_before);
  cash_delta:=p_cash_refunded-cash_before;
  select * into c from gift_cards where id=o.gift_card_id for update;
  update gift_cards set balance=balance+card_delta where id=c.id returning * into c;
  refund_id:=gen_random_uuid();
  insert into gift_card_refunds(id,order_id,amount,gift_card_amount,status,settled_at)
    values(refund_id,o.id,cash_delta+card_delta,card_delta,'settled',now());
  insert into gift_card_ledger(card_id,order_id,event_key,kind,amount,balance_after)
    values(c.id,o.id,'cash-refund:'||o.id||':'||p_cash_refunded,'refund',card_delta,c.balance);
  if p_cash_refunded=o.cash_amount then update orders set status='refunded' where id=o.id; end if;
  return cash_delta+card_delta;
end;
$$;

-- A full refund's inventory convergence is repeatable, including after a
-- worker died between journal settlement and fulfilment cancellation.
create function release_refunded_balance_inventory(p_order_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare o orders;
begin
  select * into o from orders where id=p_order_id for update;
  if not found or o.gift_card_id is null or o.status<>'refunded' then return; end if;
  update piece_state set status=case when o.private_sale_id is null then 'available' else 'sold' end,
    order_id=null,reserved_until=null where order_id=o.id and status in ('sold','reserved');
end;
$$;

revoke all on function prepare_remaining_balance_refund(uuid,uuid),begin_balance_intent(uuid),abort_balance_order(uuid,text),reconcile_balance_cash_refund(uuid,integer),release_refunded_balance_inventory(uuid) from public,anon,authenticated;
grant execute on function prepare_remaining_balance_refund(uuid,uuid),begin_balance_intent(uuid),abort_balance_order(uuid,text),reconcile_balance_cash_refund(uuid,integer),release_refunded_balance_inventory(uuid) to service_role;
commit;
