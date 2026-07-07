-- Finding 9 (settled decision #6): order_items.pod_variant_id was added in
-- 20260626120001 but never written or read anywhere in src/ or scripts/
-- (grep-confirmed 2026-07-07). PRODIGI_SKU_MAP in src/lib/print-cart.ts is the
-- SKU source of truth; pod_variants stays as the sync-prodigi-skus
-- verification target only.
alter table order_items drop column if exists pod_variant_id;
