-- Additive balance foundation. Issuance/redemption is switched by application
-- rollout only after legacy-code reconciliation; existing promo rows are kept.
begin;

-- Pause NEW spending independently of settlement/refunds. Rollback must never
-- turn a previously issued balance back into a single-use discount.
create table gift_card_settings (
  singleton boolean primary key default true check (singleton),
  spending_enabled boolean not null default false
);
insert into gift_card_settings default values;
alter table gift_card_settings enable row level security;
revoke all on gift_card_settings from public,anon,authenticated;
grant select,update on gift_card_settings to service_role;

create table gift_cards (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9_-]{3,32}$'),
  source_order_id uuid not null unique references orders(id),
  currency text not null check (currency in ('pln','eur','gbp')),
  initial_amount integer not null check (initial_amount > 0),
  balance integer not null check (balance >= 0 and balance <= initial_amount),
  status text not null default 'active' check (status in ('active','revoked','review')),
  created_at timestamptz not null default now()
);
alter table gift_cards enable row level security;

alter table orders
  alter column payment_intent_id drop not null,
  add column gift_card_id uuid references gift_cards(id),
  add column gift_card_amount integer not null default 0 check (gift_card_amount >= 0 and gift_card_amount <= total),
  add column gift_card_balance_after integer,
  add column cash_amount integer generated always as (total - gift_card_amount) stored,
  add column checkout_fingerprint text,
  add column balance_intent_started_at timestamptz,
  add column balance_refund_completed_at timestamptz,
  add column paid_processing_claim uuid,
  add column paid_processing_started_at timestamptz,
  add column paid_processing_completed_at timestamptz;

create table gift_card_holds (
  order_id uuid primary key references orders(id),
  card_id uuid not null references gift_cards(id),
  amount integer not null check (amount > 0),
  status text not null default 'held' check (status in ('held','settled','released')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  released_at timestamptz
);
create index gift_card_active_holds on gift_card_holds(card_id) where status='held';
alter table gift_card_holds enable row level security;

create table gift_card_ledger (
  id bigint generated always as identity primary key,
  card_id uuid not null references gift_cards(id),
  order_id uuid not null references orders(id),
  event_key text not null unique,
  kind text not null check (kind in ('issue','spend','refund','revoke','migration')),
  amount integer not null,
  balance_after integer not null check (balance_after >= 0),
  created_at timestamptz not null default now()
);
create index gift_card_ledger_card on gift_card_ledger(card_id,id);
alter table gift_card_ledger enable row level security;

create table gift_card_refunds (
  id uuid primary key,
  order_id uuid not null references orders(id),
  amount integer not null check (amount > 0),
  gift_card_amount integer not null check (gift_card_amount >= 0 and gift_card_amount <= amount),
  cash_amount integer generated always as (amount-gift_card_amount) stored,
  status text not null default 'pending' check (status in ('pending','settled')),
  stripe_refund_id text unique,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create unique index gift_card_one_pending_refund on gift_card_refunds(order_id) where status='pending';
alter table gift_card_refunds enable row level security;

create function issue_gift_card(p_order_id uuid,p_code text) returns gift_cards
language plpgsql security definer set search_path=public,pg_temp as $$
declare o orders; c gift_cards;
begin
  select * into o from orders where id=p_order_id for update;
  if not found or o.status<>'paid' or o.refund_pending_at is not null or o.fulfilment_type<>'giftcard' or o.discount<>0 or o.gift_card_amount<>0 then
    raise exception 'gift_card_purchase_not_paid';
  end if;
  select * into c from gift_cards where source_order_id=p_order_id;
  if found then return c; end if;
  -- Denominations are taken from the paid order, never a client-supplied value.
  insert into gift_cards(code,source_order_id,currency,initial_amount,balance)
    values(p_code,p_order_id,o.currency,o.subtotal,o.subtotal) returning * into c;
  insert into gift_card_ledger(card_id,order_id,event_key,kind,amount,balance_after)
    values(c.id,o.id,'issue:'||o.id,'issue',c.balance,c.balance);
  return c;
end;
$$;

create function reserve_gift_card(p_order_id uuid,p_code text,p_minimum_cash integer)
returns gift_card_holds language plpgsql security definer set search_path=public,pg_temp as $$
declare o orders; c gift_cards; h gift_card_holds; free integer; use_amount integer;
begin
  -- All lifecycle calls lock order -> card, and serialize all holds on a card.
  select * into o from orders where id=p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  select * into c from gift_cards where code=p_code for update;
  if not found then raise exception 'gift_card_invalid'; end if;
  select * into h from gift_card_holds where order_id=p_order_id;
  if found then
    if h.card_id<>c.id or h.status='released' then raise exception 'gift_card_attempt_conflict'; end if;
    return h;
  end if;
  if o.status<>'pending' or o.payment_intent_id is not null then raise exception 'order_not_prepared'; end if;
  if not (select spending_enabled from gift_card_settings where singleton) then raise exception 'gift_card_paused'; end if;
  if o.fulfilment_type='giftcard' or o.promo_code is not null or o.discount<>0 then raise exception 'gift_card_excluded'; end if;
  if c.status<>'active' then raise exception 'gift_card_invalid'; end if;
  if c.currency<>o.currency then raise exception 'gift_card_currency'; end if;
  if p_minimum_cash is null or p_minimum_cash<1 then raise exception 'invalid_minimum'; end if;
  select c.balance-coalesce(sum(amount),0) into free from gift_card_holds where card_id=c.id and status='held';
  use_amount:=least(o.total,free);
  if o.total-use_amount>0 and o.total-use_amount<p_minimum_cash then use_amount:=greatest(0,o.total-p_minimum_cash); end if;
  if use_amount<=0 then raise exception 'gift_card_empty'; end if;
  insert into gift_card_holds(order_id,card_id,amount) values(o.id,c.id,use_amount) returning * into h;
  update orders set gift_card_id=c.id,gift_card_amount=use_amount where id=o.id;
  return h;
end;
$$;

create function settle_gift_card(p_order_id uuid,p_payment_intent_id text,p_cash_received integer)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare o orders; h gift_card_holds; c gift_cards;
begin
  select * into o from orders where id=p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  select * into h from gift_card_holds where order_id=o.id for update;
  if not found or h.status='released' then raise exception 'gift_card_hold_missing'; end if;
  select * into c from gift_cards where id=h.card_id for update;
  if h.status='settled' then return o.gift_card_balance_after; end if;
  if o.status not in ('pending','paid') or o.refund_pending_at is not null or o.payment_intent_id is distinct from p_payment_intent_id
    or p_cash_received is distinct from o.cash_amount or (o.cash_amount>0 and p_payment_intent_id is null) then
    raise exception 'gift_card_payment_mismatch';
  end if;
  -- The caller verifies the Stripe event; a full balance payment passes NULL/0.
  -- Debiting, paid status and the journal are one transaction.
  if c.balance<h.amount then raise exception 'gift_card_balance_inconsistent'; end if;
  if o.private_sale_id is not null then perform id from private_sales where id=o.private_sale_id for update; end if;
  -- Validate and sell the complete ceramic bundle in this same transaction.
  -- Print orders have no NULL-variant items and skip this inventory path.
  perform s.product_id from piece_state s where s.order_id=o.id order by s.product_id for update;
  if exists (
    select 1 from order_items i left join piece_state s on s.product_id=i.product_id
    where i.order_id=o.id and i.variant is null
      and not coalesce(s.order_id=o.id and s.status in ('reserved','sold'),false)
  ) then raise exception 'ceramic_reservation_lost'; end if;
  update piece_state set status='sold',reserved_until=null where order_id=o.id and status='reserved';
  update gift_cards set balance=balance-h.amount where id=c.id returning * into c;
  update gift_card_holds set status='settled',settled_at=now() where order_id=o.id;
  update orders set status='paid',paid_at=coalesce(paid_at,now()),gift_card_balance_after=c.balance where id=o.id;
  if o.private_sale_id is not null then update private_sales set consumed_at=coalesce(consumed_at,now()) where id=o.private_sale_id; end if;
  insert into gift_card_ledger(card_id,order_id,event_key,kind,amount,balance_after)
    values(c.id,o.id,'spend:'||o.id,'spend',-h.amount,c.balance);
  return c.balance;
end;
$$;

create function release_gift_card(p_order_id uuid,p_canceled_intent_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare o orders; h gift_card_holds;
begin
  select * into o from orders where id=p_order_id for update;
  if not found then return; end if;
  select * into h from gift_card_holds where order_id=o.id for update;
  if not found or h.status='released' then return; end if;
  if h.status='settled' then raise exception 'gift_card_already_spent'; end if;
  -- No TTL release. Caller must confirm cancellation with Stripe FIRST and
  -- transition the order to failed/expired; processing/unknown payments retain holds.
  if o.status not in ('failed','expired') or o.payment_intent_id is distinct from p_canceled_intent_id then
    raise exception 'gift_card_payment_not_canceled';
  end if;
  perform id from gift_cards where id=h.card_id for update;
  update gift_card_holds set status='released',released_at=now() where order_id=o.id;
end;
$$;

create function prepare_gift_card_refund(p_order_id uuid,p_refund_id uuid,p_amount integer)
returns gift_card_refunds language plpgsql security definer set search_path=public,pg_temp as $$
declare o orders; r gift_card_refunds; prior_total bigint; prior_card bigint; target_card integer;
begin
  select * into o from orders where id=p_order_id for update;
  if not found or o.gift_card_id is null or o.status not in ('paid','refunded') then raise exception 'order_not_refundable'; end if;
  select * into r from gift_card_refunds where id=p_refund_id;
  if found then
    if r.order_id<>o.id or r.amount<>p_amount then raise exception 'refund_attempt_conflict'; end if;
    return r;
  end if;
  if exists(select 1 from gift_card_refunds where order_id=o.id and status='pending') then raise exception 'refund_in_progress'; end if;
  select coalesce(sum(amount),0),coalesce(sum(gift_card_amount),0) into prior_total,prior_card
    from gift_card_refunds where order_id=o.id and status='settled';
  if p_amount is null or p_amount<=0 or prior_total+p_amount>o.total then raise exception 'invalid_refund_amount'; end if;
  target_card:=floor(((prior_total+p_amount)*o.gift_card_amount+floor(o.total/2.0))/o.total);
  insert into gift_card_refunds(id,order_id,amount,gift_card_amount)
    values(p_refund_id,o.id,p_amount,target_card-prior_card) returning * into r;
  return r;
end;
$$;

create function settle_gift_card_refund(p_order_id uuid,p_refund_id uuid,p_stripe_refund_id text)
returns gift_card_refunds language plpgsql security definer set search_path=public,pg_temp as $$
declare o orders; r gift_card_refunds; c gift_cards;
begin
  select * into o from orders where id=p_order_id for update;
  select * into r from gift_card_refunds where id=p_refund_id and order_id=p_order_id for update;
  if not found then raise exception 'refund_not_found'; end if;
  if r.status='settled' then return r; end if;
  if r.cash_amount>0 and p_stripe_refund_id is null then raise exception 'cash_refund_not_confirmed'; end if;
  select * into c from gift_cards where id=o.gift_card_id for update;
  update gift_cards set balance=balance+r.gift_card_amount where id=c.id returning * into c;
  update gift_card_refunds set status='settled',stripe_refund_id=p_stripe_refund_id,settled_at=now()
    where id=r.id returning * into r;
  insert into gift_card_ledger(card_id,order_id,event_key,kind,amount,balance_after)
    values(c.id,o.id,'refund:'||r.id,'refund',r.gift_card_amount,c.balance);
  -- Inventory is handled by the order workflow, never a partial-refund ledger entry.
  if (select sum(amount) from gift_card_refunds where order_id=o.id and status='settled')=o.total then
    update orders set status='refunded' where id=o.id;
  end if;
  return r;
end;
$$;

revoke all on gift_cards,gift_card_holds,gift_card_ledger,gift_card_refunds from anon,authenticated;
grant select,insert,update on gift_cards,gift_card_holds,gift_card_refunds to service_role;
grant select on gift_card_ledger to service_role;
revoke all on function issue_gift_card(uuid,text),reserve_gift_card(uuid,text,integer),settle_gift_card(uuid,text,integer),
  release_gift_card(uuid,text),prepare_gift_card_refund(uuid,uuid,integer),settle_gift_card_refund(uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function issue_gift_card(uuid,text),reserve_gift_card(uuid,text,integer),settle_gift_card(uuid,text,integer),
  release_gift_card(uuid,text),prepare_gift_card_refund(uuid,uuid,integer),settle_gift_card_refund(uuid,uuid,text)
  to service_role;
commit;
