-- Data-integrity follow-up from the CMS API S1 review (PR #302): a
-- CodeRabbit finding on src/server/cms-api/mapping.ts pointed out that
-- products.category_slug is only `text not null` — nothing in the schema
-- ties it to `type`, so a ceramic row with category_slug='fine-art-prints'
-- (or any other typo) could reach the CMS API's synthesizeDraft() and
-- produce a CeramicDraft whose category violates its own TypeScript type.
-- An in-code guard was added there (reusing the same CATEGORY_SLUGS list
-- src/server/cms-api/validation.ts's ceramicDraftSchema already enforces on
-- writes), but that only protects CMS API reads — this migration closes the
-- gap at the source for every writer (the catalog registry backfill
-- included).
--
-- Safety: NOT VALID first (existing rows can't block the deploy), VALIDATE
-- immediately after — same pattern as products_ceramic_price_present /
-- products_ceramic_price_positive in
-- 20260813170000_harden_rpc_and_catalog.sql. A live read against prod in
-- this session (`select distinct type, category_slug from products`)
-- confirmed every existing ceramic row already uses one of the 9 slugs
-- below, and the only print row's category is 'fine-art-prints' —
-- so VALIDATE cannot fail. The 9-value list is the exact CATEGORY_SLUGS
-- array in src/server/cms-api/validation.ts (itself `Exclude<CategorySlug,
-- 'fine-art-prints'>` from src/lib/types.ts) — kept in sync by hand, same as
-- the status/stage vocabularies in the precedent migration's L-13 block.
--
-- Rollback:
--   alter table products drop constraint if exists products_ceramic_category_valid;

alter table products add constraint products_ceramic_category_valid
  check (type <> 'ceramic' or category_slug in (
    'kubki',
    'wazony',
    'wazony-srednie',
    'wazony-duze',
    'talerzyki',
    'talerze-srednie',
    'talerze-duze',
    'duze-michy',
    'miski-falowane'
  )) not valid;
alter table products validate constraint products_ceramic_category_valid;
