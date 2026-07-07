-- Finding 8: explicit ceramics⇄prints discriminator on orders. Until now the
-- kind was inferred by joining order_items.variant (NULL = ceramic); this
-- column makes it legible at the order level. /api/checkout writes it on
-- insert; existing rows are backfilled from delivery_method + order_items.
alter table orders add column if not exists fulfilment_type text;

update orders o
set fulfilment_type = case
  when o.delivery_method = 'odbior' then 'pickup'
  when exists (
    select 1 from order_items oi
    where oi.order_id = o.id and oi.variant is not null
  ) then 'prodigi'
  else 'inpost'
end
where o.fulfilment_type is null;

-- Default covers only the window between applying this migration and deploying
-- the checkout code that writes the column ('inpost' = the dominant order kind
-- at this store); after deploy every insert sets it explicitly. Re-run the
-- UPDATE above (without the null guard) to fix any window rows if needed.
alter table orders alter column fulfilment_type set default 'inpost';
alter table orders alter column fulfilment_type set not null;
alter table orders add constraint orders_fulfilment_type_check
  check (fulfilment_type in ('inpost', 'prodigi', 'pickup'));
