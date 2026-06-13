-- Fine-art print support on order_items (plan "Migracja A", phase 1).
--
-- ⚠️ DEPLOY ORDER: apply this migration to Supabase BEFORE the Worker code that
-- writes order_items.variant ships. The new code inserts a `variant` column and
-- relies on the surrogate PK; deploying the code first makes every checkout
-- order_items insert fail (missing column / PK conflict for two variants).
--
-- 1) Print line items carry the chosen variant (size/paper/frame/sku).
--    NULL = a one-of-a-kind ceramic (unchanged).
alter table order_items add column variant jsonb;

-- 2) The existing PK (order_id, product_id) forbids two print line items that
--    share a design id but differ by variant (e.g. the same print in A4 and A3).
--    Replace it with a surrogate id so multiple variants of one design coexist
--    in a single order.
alter table order_items add column id uuid not null default gen_random_uuid();
alter table order_items drop constraint order_items_pkey;
alter table order_items add primary key (id);

-- 3) Preserve the ceramic dedup guarantee: at most one row per unique piece per
--    order. Scoped to ceramics (variant is null) so print variants are exempt.
create unique index order_items_ceramic_unique
  on order_items (order_id, product_id)
  where variant is null;
