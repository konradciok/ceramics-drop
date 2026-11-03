-- Cut over codes in one transaction. Historical redemptions and codes remain
-- auditable; spent, revoked and ambiguous codes never regain their face value.
begin;
lock table promo_codes,promo_redemptions in share row exclusive mode;

insert into gift_cards(code,source_order_id,currency,initial_amount,balance,status)
select p.code,o.id,o.currency,o.subtotal,
  case when o.status='paid' and o.refund_pending_at is null and p.active
    and (p.expires_at is null or p.expires_at>now())
    and not exists(select 1 from promo_redemptions r where r.promo_id=p.id and r.status in ('pending','redeemed'))
    and (case o.currency when 'pln' then p.amount_pln when 'eur' then p.amount_eur else p.amount_gbp end)=o.subtotal
    then o.subtotal else 0 end,
  case when exists(select 1 from promo_redemptions r where r.promo_id=p.id and r.status='pending') then 'review'
    when o.status<>'paid' or o.refund_pending_at is not null or not p.active or (p.expires_at is not null and p.expires_at<=now()) then 'revoked'
    when (case o.currency when 'pln' then p.amount_pln when 'eur' then p.amount_eur else p.amount_gbp end) is distinct from o.subtotal then 'review'
    else 'active' end
from promo_codes p join orders o on o.id=p.source_order_id
where p.source='gift_card' and o.currency in ('pln','eur','gbp') and o.subtotal>0
on conflict(source_order_id) do nothing;

insert into gift_card_ledger(card_id,order_id,event_key,kind,amount,balance_after)
select c.id,c.source_order_id,'migration:'||c.source_order_id,'migration',c.balance,c.balance
from gift_cards c join promo_codes p on p.source_order_id=c.source_order_id and p.source='gift_card'
where not exists(select 1 from gift_card_ledger l where l.card_id=c.id)
on conflict(event_key) do nothing;

update promo_codes set active=false where source='gift_card';
create function prevent_legacy_gift_card_spending() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if new.source='gift_card' and new.active then raise exception 'gift_card_balance_required'; end if;
  if tg_op='UPDATE' and old.source='gift_card' and (new.source<>old.source or new.code<>old.code or new.source_order_id is distinct from old.source_order_id) then
    raise exception 'legacy_gift_card_history_is_immutable';
  end if;
  return new;
end;
$$;
create trigger gift_card_legacy_guard before insert or update on promo_codes
  for each row execute function prevent_legacy_gift_card_spending();

-- A used card purchase always needs manual review. Locking the source order
-- fences issuance; locking the card fences new spending before cash is refunded.
create function prepare_gift_card_purchase_refund(p_order_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare o orders; c gift_cards;
begin
  select * into o from orders where id=p_order_id for update;
  if not found or o.fulfilment_type<>'giftcard' then return true; end if;
  select * into c from gift_cards where source_order_id=o.id for update;
  if found then
    if c.balance<>c.initial_amount or c.status='revoked'
      or exists(select 1 from gift_card_holds where card_id=c.id and status='held')
      or exists(select 1 from gift_card_ledger where card_id=c.id and kind='spend') then return false; end if;
    update gift_cards set status='review' where id=c.id;
  end if;
  update orders set refund_pending_at=coalesce(refund_pending_at,now()) where id=o.id;
  return true;
end;
$$;

create function revoke_refunded_gift_card(p_order_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare o orders; c gift_cards;
begin
  select * into o from orders where id=p_order_id for update;
  if not found or o.fulfilment_type<>'giftcard' then return true; end if;
  if o.status<>'refunded' then raise exception 'gift_card_purchase_not_refunded'; end if;
  select * into c from gift_cards where source_order_id=o.id for update;
  if not found or c.status='revoked' then return true; end if;
  if c.balance<>c.initial_amount
    or exists(select 1 from gift_card_holds where card_id=c.id and status='held')
    or exists(select 1 from gift_card_ledger where card_id=c.id and kind='spend') then
    update gift_cards set status='review' where id=c.id;
    return false;
  end if;
  update gift_cards set status='revoked',balance=0 where id=c.id;
  insert into gift_card_ledger(card_id,order_id,event_key,kind,amount,balance_after)
    values(c.id,o.id,'revoke:'||o.id,'revoke',-c.balance,0) on conflict(event_key) do nothing;
  return true;
end;
$$;
revoke all on function prepare_gift_card_purchase_refund(uuid),revoke_refunded_gift_card(uuid) from public,anon,authenticated;
grant execute on function prepare_gift_card_purchase_refund(uuid),revoke_refunded_gift_card(uuid) to service_role;
commit;
