-- ============================================================
-- Canonical print prices for databases still on the ORIGINAL seed
-- ============================================================
-- 20260807120000 now seeds the canonical prices, so a database created from
-- scratch starts correct. A database that applied the original 25/50/75 EUR
-- seed *before* that edit (a staging/integration project, a local dev DB) and
-- whose price list nobody has touched since still has the old numbers in the
-- live row AND in pricing_config_drafts revision 1 (20260917140000 snapshots
-- the live row). The CMS would show, and a publish of revision 1 would
-- re-apply, the old prices.
--
-- This migration repairs exactly that case, the same way publish_pricing_revision
-- would: a NEW draft revision 2 carrying the canonical values (revision 1 stays
-- as history), the live row set from it, published_revision = 2, and an audit
-- row — one transaction. It is a deliberate no-op when ANY of these hold:
--   * the live row is not exactly the original seed (an admin edited prices —
--     production did on 2026-08-10, and was already canonical),
--   * published_revision is not 1, or a draft revision above 1 exists (the CMS
--     has been used; its history is not ours to rewrite),
--   * the database is fresh (it was seeded canonical, so the first rule holds).
-- Keep the values in lockstep with DEFAULT_PRINT_PRICING (print-pricing.ts).
do $$
declare
  v_before  print_pricing_config%rowtype;
  v_rev1    jsonb;
  v_payload jsonb;
  v_fields  integer;
begin
  select * into v_before from print_pricing_config c where c.id for update;
  if not found then return; end if;

  if not (
        v_before.base_30x40_eur = 25 and v_before.base_50x70_eur = 50 and v_before.base_70x100_eur = 75
    and v_before.frame_30x40_eur = 35 and v_before.frame_50x70_eur = 35 and v_before.frame_70x100_eur = 35
    and v_before.mount_30x40_eur = 25 and v_before.mount_50x70_eur = 25 and v_before.mount_70x100_eur = 25
    and v_before.eur_to_pln = 4.25 and v_before.eur_to_gbp = 0.86
    and v_before.published_revision = 1
  ) then return; end if;

  if exists (select 1 from pricing_config_drafts d where d.revision > 1) then return; end if;

  select d.payload into v_rev1 from pricing_config_drafts d where d.revision = 1;
  if v_rev1 is null then return; end if;

  -- Same field list/labels/order as revision 1, only the values replaced.
  select jsonb_build_object('fields', jsonb_agg(jsonb_set(t.f, '{value}', to_jsonb(v.val)) order by t.ord)),
         count(*)
    into v_payload, v_fields
  from jsonb_array_elements(v_rev1->'fields') with ordinality as t(f, ord)
  join (values
    ('base_30x40_eur', '42'), ('base_50x70_eur', '79'), ('base_70x100_eur', '119'),
    ('frame_30x40_eur', '49'), ('frame_50x70_eur', '79'), ('frame_70x100_eur', '99'),
    ('mount_30x40_eur', '40'), ('mount_50x70_eur', '40'), ('mount_70x100_eur', '40'),
    ('eur_to_pln', '4.25'), ('eur_to_gbp', '0.86')
  ) as v(key, val) on v.key = t.f->>'key';
  if v_fields <> 11 then return; end if;

  insert into pricing_config_drafts (revision, payload, created_by)
  values (2, v_payload, 'migration:20261102120100_print_prices_canonical_config');

  update print_pricing_config c set
    base_30x40_eur = 42, base_50x70_eur = 79, base_70x100_eur = 119,
    frame_30x40_eur = 49, frame_50x70_eur = 79, frame_70x100_eur = 99,
    mount_30x40_eur = 40, mount_50x70_eur = 40, mount_70x100_eur = 40,
    eur_to_pln = 4.25, eur_to_gbp = 0.86,
    published_revision = 2,
    updated_at = now(),
    updated_by = 'migration:20261102120100_print_prices_canonical_config'
  where c.id;

  insert into catalog_audit_log (product_id, actor_email, action, before, after, revision)
  select 'print-pricing', null, 'published', to_jsonb(v_before), to_jsonb(c), 2
  from print_pricing_config c where c.id;
end
$$;
