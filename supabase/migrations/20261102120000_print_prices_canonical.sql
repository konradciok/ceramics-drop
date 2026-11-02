-- ============================================================
-- Canonical fine-art-print prices (owner decision 2026-11-02)
-- ============================================================
-- Production's print_pricing_config row was edited in /admin/pricing on
-- 2026-08-10 to the prices below, but the 20260807120000 seed row, the
-- DEFAULT_PRINT_PRICING code twin and the product_variants shadow rows still
-- carried the original 25/50/75 EUR seed. This migration brings the remaining
-- places in line. Idempotent: a no-op wherever the data already matches.
--
--   EUR (canonical)  base 42 / 79 / 119   frame +49 / +79 / +99   mount +40
--   PLN (x4.25, 5)   base 180 / 335 / 505 frame +210 / +335 / +420 mount +170
--   GBP (x0.86, 1)   base 36 / 68 / 102   frame +42 / +68 / +85    mount +34
--   => unframed 42/79/119 EUR, framed 91/158/218 EUR (no mount)
-- Keep in lockstep with DEFAULT_PRINT_PRICING in src/lib/print-pricing.ts
-- (src/lib/print-pricing-config/migration-lockstep.test.ts enforces it).

-- 1. Singleton config row: only touch a row still holding the ORIGINAL seed,
--    so a price the admin has since changed in /admin/pricing is never reverted.
update print_pricing_config set
  base_30x40_eur = 42, base_50x70_eur = 79, base_70x100_eur = 119,
  frame_30x40_eur = 49, frame_50x70_eur = 79, frame_70x100_eur = 99,
  mount_30x40_eur = 40, mount_50x70_eur = 40, mount_70x100_eur = 40,
  eur_to_pln = 4.25, eur_to_gbp = 0.86
where base_30x40_eur = 25 and base_50x70_eur = 50 and base_70x100_eur = 75
  and frame_30x40_eur = 35 and frame_50x70_eur = 35 and frame_70x100_eur = 35
  and mount_30x40_eur = 25 and mount_50x70_eur = 25 and mount_70x100_eur = 25
  and eur_to_pln = 4.25 and eur_to_gbp = 0.86;

-- 2. product_variants shadow prices for fine-art prints. These mirror
--    priceOfVariant() (base + frame if framed + mount if framed and mounted),
--    exactly what `npm run catalog:backfill` writes from DEFAULT_PRINT_PRICING.
update product_variants v set
  price_eur = p.base_eur + (case when f then p.frame_eur else 0 end) + (case when f and m then p.mount_eur else 0 end),
  price_pln = p.base_pln + (case when f then p.frame_pln else 0 end) + (case when f and m then p.mount_pln else 0 end),
  price_gbp = p.base_gbp + (case when f then p.frame_gbp else 0 end) + (case when f and m then p.mount_gbp else 0 end)
from (
  select v2.id,
         coalesce((v2.axes->>'framed')::boolean, false) as f,
         coalesce((v2.axes->>'mount')::boolean, false) as m,
         t.*
  from product_variants v2
  join (values
    ('30x40',  42, 49, 40, 180, 210, 170,  36, 42, 34),
    ('50x70',  79, 79, 40, 335, 335, 170,  68, 68, 34),
    ('70x100', 119, 99, 40, 505, 420, 170, 102, 85, 34)
  ) as t(size, base_eur, frame_eur, mount_eur, base_pln, frame_pln, mount_pln, base_gbp, frame_gbp, mount_gbp)
    on t.size = v2.axes->>'size'
  where v2.product_id like 'fap%'
) p
where v.id = p.id
  and (v.price_eur, v.price_pln, v.price_gbp) is distinct from (
    p.base_eur + (case when p.f then p.frame_eur else 0 end) + (case when p.f and p.m then p.mount_eur else 0 end),
    p.base_pln + (case when p.f then p.frame_pln else 0 end) + (case when p.f and p.m then p.mount_pln else 0 end),
    p.base_gbp + (case when p.f then p.frame_gbp else 0 end) + (case when p.f and p.m then p.mount_gbp else 0 end)
  );

-- ============================================================
-- Rollback (manual): none — restoring the old numbers is a price change,
-- not a schema change; use /admin/pricing and `npm run catalog:backfill`.
-- ============================================================
