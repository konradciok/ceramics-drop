-- Print variant_key scalar + exact-variant dedup on order_items (plan "Migracja A",
-- KTD1 + KTD3). Follows 20260613120000_order_items_variant.sql, which added the
-- `variant` jsonb and the surrogate PK.
--
-- ⚠️ DEPLOY ORDER: apply this migration to Supabase BEFORE the Worker code that
-- writes order_items.variant_key ships. The checkout insert now sends a
-- `variant_key` column; deploying the code first makes every print checkout
-- order_items insert fail (missing column).
--
-- 1) variant_key: the print SKU promoted to a scalar (e.g. FAP-01-A3-SATIN-OAK).
--    Design-specific, so it can key both the exact-variant unique index below and
--    the Stripe invoice-item idempotency key with no cross-design collision.
--    NULL = a one-of-a-kind ceramic (which dedupes on product_id alone).
alter table order_items add column variant_key text;

-- 2) Backfill existing print rows from the variant jsonb so the uniqueness
--    guarantee and idempotency hold for historical orders too. The persisted
--    variant already carries the resolved `sku`.
update order_items
  set variant_key = variant->>'sku'
  where variant is not null and variant_key is null;

-- 3) Prints stay one row per exact variant per order — the print-side mirror of
--    order_items_ceramic_unique (variant IS NULL) from the previous migration.
--    product_id is included so the guarantee is explicit "one design+variant per
--    order"; scoped to print rows via variant_key IS NOT NULL so ceramics are exempt.
create unique index order_items_print_variant_unique
  on order_items (order_id, product_id, variant_key)
  where variant_key is not null;
