-- Print line items carry the chosen variant (size/framed/mount/frameColour/prodigiSku).
-- NULL = a one-of-a-kind ceramic (unchanged).
alter table order_items add column variant jsonb;

-- Replace (order_id, product_id) PK with a surrogate id so multiple variants
-- of one design can coexist in a single order.
alter table order_items add column id uuid not null default gen_random_uuid();
alter table order_items drop constraint order_items_pkey;
alter table order_items add primary key (id);

-- Preserve the ceramic dedup guarantee: one row per unique piece per order.
-- Scoped to ceramics (variant is null) so print variants are exempt.
create unique index order_items_ceramic_unique
  on order_items (order_id, product_id)
  where variant is null;
