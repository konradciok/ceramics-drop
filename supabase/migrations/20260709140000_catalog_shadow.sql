-- Catalog shadow tables — Stage 0 of the admin "Products" module refactor
-- -----------------------------------------------------------------------------
-- Introduces a database-backed product catalogue (products + variants + media)
-- that MIRRORS the static code registry (src/lib/products.ts, src/lib/prints.ts).
--
-- This migration is fully ADDITIVE and INERT: nothing in the storefront or the
-- checkout path reads these tables yet. The code registry stays the sole source
-- of truth. A later stage flips the storefront accessors onto these tables
-- behind the CATALOG_SOURCE flag, only after a parity check (DB == registry)
-- passes. See the approved plan (Stage 0 → Stage 3).
--
-- Same RLS posture as piece_state/orders/drops: deny all to anon/authenticated;
-- only the service-role key (used server-side) bypasses RLS.
--
--   1. products         — one row per catalogue item (stable id is the PK).
--   2. product_variants — sellable variants (ceramic: 1 default @ qty 1;
--                         print: one per size/frame/mount/colour → Prodigi SKU).
--   3. product_media    — images (primary + gallery), optionally per variant.
--
-- The stable string id (k01, fap01, …) is preserved as the PK so it keeps
-- joining to order_items.product_id / piece_state.product_id / print tokens.

-- 1. products ─────────────────────────────────────────────────────────────────
create table products (
  id             text primary key,                       -- stable token, e.g. 'k01', 'fap01'
  type           text not null check (type in ('ceramic', 'print')),
  category_slug  text not null,
  num            text not null,                           -- display number within family
  slug           text unique,                             -- null => canonical URL derived from id
  price_pln      integer,                                 -- minor-unit? no: whole major units, matches pricing.ts
  price_eur      integer,
  price_gbp      integer,
  sale_price_pln integer,
  sale_price_eur integer,
  sale_price_gbp integer,
  measure        text not null default '',
  status         text not null default 'active' check (status in ('draft', 'active', 'hidden', 'archived')),
  seo_title       text,
  seo_description text,
  drop_id        text references drops(id),
  note_index     integer,                                 -- legacy bridge to i18n/CMS notes
  published_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table products enable row level security;

create index products_category_idx on products (category_slug);
create index products_status_idx   on products (status);
create index products_type_idx     on products (type);

-- 2. product_variants ─────────────────────────────────────────────────────────
-- variant_key is the natural per-product uniqueness key: 'default' for ceramics,
-- '<size>:<framed>:<mount>:<frameColour>' (variantKey() in print-cart.ts) for
-- prints. sku is NOT unique — several print colours share one Prodigi SKU.
create table product_variants (
  id                  uuid primary key default gen_random_uuid(),
  product_id          text not null references products(id) on delete cascade,
  variant_key         text not null default 'default',
  sku                 text,
  axes                jsonb,                              -- {size,framed,mount,frameColour} for prints; null for ceramics
  price_pln           integer,                            -- null => inherit product price
  price_eur           integer,
  price_gbp           integer,
  is_default          boolean not null default false,
  active              boolean not null default true,
  position            integer not null default 0,
  -- Quantity-based stock (Stage 6 wires this into the reservation path):
  track_inventory     boolean not null default true,     -- prints (POD) => false
  stock_quantity      integer not null default 0,        -- ceramics (1/1) => 1
  allow_backorder     boolean not null default false,    -- prints (made-to-order) => true
  low_stock_threshold integer,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (product_id, variant_key)
);

alter table product_variants enable row level security;

create index product_variants_product_idx on product_variants (product_id);
-- At most one default variant per product.
create unique index product_variants_one_default
  on product_variants (product_id) where is_default;

-- 3. product_media ────────────────────────────────────────────────────────────
create table product_media (
  id          uuid primary key default gen_random_uuid(),
  product_id  text not null references products(id) on delete cascade,
  variant_id  uuid references product_variants(id) on delete set null,
  url         text not null,
  alt         text,
  position    integer not null default 0,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  -- (product_id, url) is the natural key for idempotent backfill upserts.
  unique (product_id, url)
);

alter table product_media enable row level security;

create index product_media_product_idx on product_media (product_id);
-- At most one primary image per product.
create unique index product_media_one_primary
  on product_media (product_id) where is_primary;

-- Rollback (manual) ───────────────────────────────────────────────────────────
-- These tables are additive and nothing reads them, so dropping them is safe and
-- loses no order/inventory data:
--
--   drop table if exists product_media;
--   drop table if exists product_variants;
--   drop table if exists products;
