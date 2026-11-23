-- New ceramic families in drop-2: `talerze-owalne` (oval plates) and
-- `talerze-male` (small plates, ⌀ 14 cm).
--
-- products.category_slug is guarded by products_ceramic_category_valid
-- (20260913230000_ceramic_category_check.sql); the list must match
-- CATEGORY_SLUGS in src/server/cms-api/validation.ts and the CategorySlug
-- union in src/lib/types.ts. Without the new slug, `npm run catalog:backfill`
-- would fail on the e01–e12 and m01–m09 rows.
--
-- Widening a check cannot invalidate existing rows, but keep the NOT VALID →
-- VALIDATE pattern of the original so the swap never holds a long lock.
--
-- Rollback (only while no product row uses either slug):
--   re-run the 20260913230000 constraint without the two new slugs.

alter table products drop constraint if exists products_ceramic_category_valid;
alter table products add constraint products_ceramic_category_valid
  check (type <> 'ceramic' or category_slug in (
    'kubki',
    'wazony',
    'wazony-srednie',
    'wazony-duze',
    'talerzyki',
    'talerze-male',
    'talerze-srednie',
    'talerze-duze',
    'talerze-owalne',
    'duze-michy',
    'miski-falowane'
  )) not valid;
alter table products validate constraint products_ceramic_category_valid;
