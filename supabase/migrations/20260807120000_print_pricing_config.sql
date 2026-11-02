-- ============================================================
-- Global fine-art-print price list — one row, admin-editable.
-- ------------------------------------------------------------
-- Replaces the hard-coded SIZE_BASE / FRAMED_DELTA / MOUNT_DELTA tables in
-- src/lib/print-pricing.ts as the runtime source of print variant prices
-- (the code keeps DEFAULT_PRINT_PRICING as seed + outage fallback).
--
-- Model: EUR is canonical. The admin edits 9 EUR values (per-size base +
-- per-size frame surcharge + per-size mount surcharge) and 2 conversion
-- rates; PLN/GBP are derived in code, component-wise (PLN rounded to 5 zł,
-- GBP to 1 GBP). Frame colour never affects price; the mount surcharge only
-- applies on top of a framed variant (both enforced in priceOfVariant, not
-- here). EUR values are MAJOR units (whole euro), integers — same convention
-- as products.price_eur.
--
-- Fully additive. Same RLS posture as the catalog shadow tables: deny all to
-- anon/authenticated; only the service-role key (used server-side) bypasses
-- RLS. Audit rows for edits go to catalog_audit_log under the sentinel
-- product_id 'print-pricing' (that table intentionally has no FK).
-- ============================================================

create table print_pricing_config (
  id               boolean primary key default true check (id),  -- single-row guard: only `true` can exist
  base_30x40_eur   integer not null check (base_30x40_eur  > 0),
  base_50x70_eur   integer not null check (base_50x70_eur  > 0),
  base_70x100_eur  integer not null check (base_70x100_eur > 0),
  frame_30x40_eur  integer not null check (frame_30x40_eur  >= 0),
  frame_50x70_eur  integer not null check (frame_50x70_eur  >= 0),
  frame_70x100_eur integer not null check (frame_70x100_eur >= 0),
  mount_30x40_eur  integer not null check (mount_30x40_eur  >= 0),
  mount_50x70_eur  integer not null check (mount_50x70_eur  >= 0),
  mount_70x100_eur integer not null check (mount_70x100_eur >= 0),
  eur_to_pln       numeric(8,4) not null check (eur_to_pln > 0 and eur_to_pln <= 100),
  eur_to_gbp       numeric(8,4) not null check (eur_to_gbp > 0 and eur_to_gbp <= 100),
  updated_at       timestamptz not null default now(),
  updated_by       text
);

alter table print_pricing_config enable row level security;

-- Seed: canonical owner price list. Originally approved 2026-08-07 as
-- 25/50/75 EUR base, +35 frame, +25 mount; edited in /admin/pricing on
-- 2026-08-10 and made canonical here on 2026-11-02 so a fresh database (and the
-- revision-1 pricing draft that 20260917140000 snapshots from this row) starts
-- from the live prices. Production had already applied this file, so editing
-- the literal below only affects newly created databases. Derived table
-- (component-wise):
--   base 42/79/119 EUR -> 180/335/505 PLN, 36/68/102 GBP
--   frame +49/+79/+99 EUR -> +210/+335/+420 PLN, +42/+68/+85 GBP
--   mount +40 EUR (uniform) -> +170 PLN, +34 GBP
-- Keep in lockstep with DEFAULT_PRINT_PRICING in src/lib/print-pricing.ts.
insert into print_pricing_config (
  base_30x40_eur, base_50x70_eur, base_70x100_eur,
  frame_30x40_eur, frame_50x70_eur, frame_70x100_eur,
  mount_30x40_eur, mount_50x70_eur, mount_70x100_eur,
  eur_to_pln, eur_to_gbp
) values (
  42, 79, 119,
  49, 79, 99,
  40, 40, 40,
  4.25, 0.86
);

-- ============================================================
-- Rollback (manual):
--   drop table if exists print_pricing_config;
-- ============================================================
