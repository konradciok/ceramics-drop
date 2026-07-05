-- Source of truth for verified Prodigi SKUs and print-area dimensions.
-- Seeded via `npm run sync-prodigi-skus` (Task 11).
create table pod_variants (
  id                   uuid primary key default gen_random_uuid(),
  prodigi_sku          text not null unique,
  display_size_label   text not null,
  frame_colour         text not null,        -- 'none' for FAP (unframed)
  mount_enabled        boolean not null,
  paper                text not null default 'EMA',
  print_area_width_px  integer,
  print_area_height_px integer,
  active               boolean not null default true,
  last_synced_at       timestamptz
);
alter table pod_variants enable row level security;

-- Nullable FK: set by sync script after seeding, not at checkout time.
alter table order_items add column pod_variant_id uuid references pod_variants(id);
