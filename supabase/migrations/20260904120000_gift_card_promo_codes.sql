-- ============================================================================
-- Gift cards (2026-09-04) — Option A schema
-- A paid gift-card order mints a single-use, fixed-amount `promo_codes` row
-- instead of a new balance-ledger subsystem, reusing the existing
-- claim_promo_redemption / settle_promo_redemption RPCs (20260830120000).
-- Purely additive: two nullable/defaulted columns on promo_codes, a partial
-- unique index, and a widened orders.fulfilment_type CHECK.
-- Backward-compatibility: every existing promo_codes row defaults to
-- source='admin' with source_order_id NULL, so nothing about the existing
-- promo-code feature changes shape or behaviour. Plan owner: gift-card
-- backend build — see docs/gift-cards.md.
-- ============================================================================

-- Distinguishes a purchase-minted code (source='gift_card') from an
-- operator-created one (source='admin', the pre-existing default shape).
alter table promo_codes
  add column source text not null default 'admin'
    check (source in ('admin', 'gift_card')),
  -- Traces a minted code back to the gift-card order that produced it. No
  -- ON DELETE behaviour is specified (orders are never hard-deleted in this
  -- schema — see every other orders FK in this codebase).
  add column source_order_id uuid references orders (id);

-- Idempotent minting: the webhook route inserts at most one gift-card promo
-- row per originating order. A second insert attempt (Stripe redelivery)
-- hits this unique index and is treated as "already minted" by the caller.
create unique index promo_codes_source_order_id_idx
  on promo_codes (source_order_id)
  where source_order_id is not null;

-- Admin-table filtering ("purchase-minted vs operator-created" — see
-- src/lib/admin/promotions.ts).
create index promo_codes_source_idx on promo_codes (source);

-- Revocation reuses the existing active/inactive mechanism (no new RPC): the
-- webhook's releaseSale path sets active=false on any gift-card promo whose
-- source_order_id is the refunded order, so a refunded gift-card purchase's
-- code stops being redeemable (checkPromoEligibility already gates on
-- `active`). This does not undo a redemption that already happened on
-- another order — accepted edge case (see docs/gift-cards.md).

-- Explicit discriminator for gift-card orders alongside the existing
-- ceramics/prints kinds (mirrors Finding 8's fulfilment_type column).
-- Low-lock replacement (precedent: block 4 of 20260813170000_harden_rpc_and_catalog.sql):
-- add the new check under a temporary name as NOT VALID (metadata-only,
-- no table scan), VALIDATE it separately, then swap names. Honest caveat:
-- the Supabase CLI applies one migration file inside a single wrapping
-- transaction, so this does NOT give checkout inserts a window to commit
-- *between* these statements the way genuinely separate transactions
-- would — the whole block still commits or rolls back atomically. What it
-- still buys: `VALIDATE CONSTRAINT` takes a SHARE UPDATE EXCLUSIVE lock,
-- which — unlike the ACCESS EXCLUSIVE lock a plain `ADD CONSTRAINT ...
-- CHECK` scan would hold for its whole duration — permits concurrent
-- INSERT/UPDATE/DELETE (i.e. concurrent checkout writes to `orders`) while
-- the scan runs; only the brief NOT VALID add / DROP / RENAME steps take
-- ACCESS EXCLUSIVE, and each is a fast catalog-only update, not a scan.
-- `orders` also has few enough rows that the scan itself is cheap either
-- way, but the lock-mode difference is the actual, real benefit here.
alter table orders add constraint orders_fulfilment_type_check_new
  check (fulfilment_type in ('inpost', 'prodigi', 'pickup', 'giftcard')) not valid;
alter table orders validate constraint orders_fulfilment_type_check_new;
alter table orders drop constraint orders_fulfilment_type_check;
alter table orders rename constraint orders_fulfilment_type_check_new to orders_fulfilment_type_check;
