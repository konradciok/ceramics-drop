-- S2b: backfill_catalog() must not clobber a product the CMS has taken
-- ownership of.
-- -----------------------------------------------------------------------------
-- A brand-new CMS-created product (prd_<hex> id, from create_product_with_draft)
-- can never collide with catalog:backfill's input — buildCatalogSeed() only
-- ever iterates the code registry, whose ids are shaped k01/fap001/etc. So
-- this guard is not about protecting new CMS products (already safe by
-- id-namespace separation) — it's about the case nothing currently prevents:
-- an operator CMS-editing an EXISTING registry-seeded product (e.g. k01).
-- Nothing in products-save.ts/publish_product_revision restricts CMS writes
-- to prd_-prefixed ids, and per this milestone's scoping decision, nothing
-- should — nothing stops an operator giving an existing kubek a real CMS
-- title/description/price today, and that's intentional. But the next
-- `npm run catalog:backfill` run would silently revert that edit: the
-- unconditional UPDATE products (category/price/status/slug/seo/etc.) and
-- the unconditional DELETE+re-insert of product_media/product_variants have
-- no awareness of product_drafts history.
--
-- Fix: compute which input ids have EVER had a product_drafts row (i.e. have
-- been touched via the CMS write path at all, draft or published) and skip
-- the UPDATE/DELETE/re-INSERT for exactly those ids. The INSERT ... ON
-- CONFLICT DO NOTHING path for genuinely new ids is untouched — a new id can
-- never be in this skip set (product_drafts FKs to products, so a row can't
-- exist there for an id that doesn't exist in products yet).
--
-- Return type changes from void to jsonb (CREATE OR REPLACE cannot change a
-- function's return type — hence the explicit DROP below) so the RPC caller
-- can log which ids were skipped, matching every sibling RPC's jsonb-response
-- convention (publish_product_revision, update_product_status_guarded).
--
-- Safety: every non-CMS-owned id's backfill behavior is byte-for-byte
-- unchanged. No schema/column changes.
--
-- Rollback:
--   drop function if exists backfill_catalog(jsonb, jsonb, jsonb);
--   -- (recreate the 20260828120000_curate_fine_art_prints.sql definition,
--   --  returns void, manually)

drop function if exists backfill_catalog(jsonb, jsonb, jsonb);

create function backfill_catalog(
  p_products jsonb,
  p_variants jsonb,
  p_media jsonb
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_products products[];
  v_variants product_variants[];
  v_media product_media[];
  v_active_print_ids text[];
  v_cms_owned_ids text[];
begin
  if coalesce(jsonb_typeof(p_products), 'null') <> 'array'
      or coalesce(jsonb_typeof(p_variants), 'null') <> 'array'
      or coalesce(jsonb_typeof(p_media), 'null') <> 'array' then
    raise exception 'catalog_backfill_arrays_required';
  end if;

  -- Typed row arrays keep the complete input in this transaction without
  -- runtime-created relations, so PostgreSQL can statically validate every
  -- statement in the function.
  select coalesce(array_agg(input), '{}'::products[])
    into v_products
    from jsonb_populate_recordset(null::products, p_products) input;

  select coalesce(array_agg(input), '{}'::product_variants[])
    into v_variants
    from jsonb_populate_recordset(null::product_variants, p_variants) input;

  select coalesce(array_agg(input), '{}'::product_media[])
    into v_media
    from jsonb_populate_recordset(null::product_media, p_media) input;

  if coalesce(cardinality(v_products), 0) = 0
      or exists (
        select 1 from unnest(v_products) input
        where id is null or type is null or status is null
      ) then
    raise exception 'catalog_backfill_products_required';
  end if;

  -- Serialise status changes and asset revision publication for every existing
  -- seeded product before any structural mutation.
  perform p.id
    from products p
    join unnest(v_products) input on input.id = p.id
   order by p.id
   for update of p;

  -- Any input id ever touched via the CMS write path (a draft was saved,
  -- published, or both) — this backfill must not overwrite it. Computed once,
  -- before any mutation, from the locked row set above.
  select coalesce(array_agg(distinct pd.product_id), '{}')
    into v_cms_owned_ids
    from product_drafts pd
    join unnest(v_products) input on input.id = pd.product_id;

  -- BEFORE INSERT fires before ON CONFLICT resolution. Always propose draft
  -- for registry-active prints so an existing active print does not trip the
  -- insert guard merely because its row already exists. A CMS-owned id can
  -- never reach this INSERT's conflict target with new data anyway (its
  -- products row already exists, by definition of "has a product_drafts
  -- row"), so no guard is needed here.
  insert into products (
    id,
    type,
    category_slug,
    num,
    slug,
    price_pln,
    price_eur,
    price_gbp,
    sale_price_pln,
    sale_price_eur,
    sale_price_gbp,
    measure,
    status,
    seo_title,
    seo_description,
    drop_id,
    note_index
  )
  select
    id,
    type,
    category_slug,
    num,
    slug,
    price_pln,
    price_eur,
    price_gbp,
    sale_price_pln,
    sale_price_eur,
    sale_price_gbp,
    measure,
    case when type = 'print' and status = 'active' then 'draft' else status end,
    seo_title,
    seo_description,
    drop_id,
    note_index
  from unnest(v_products)
  on conflict (id) do nothing;

  update products p
     set type = input.type,
         category_slug = input.category_slug,
         num = input.num,
         slug = input.slug,
         price_pln = input.price_pln,
         price_eur = input.price_eur,
         price_gbp = input.price_gbp,
         sale_price_pln = input.sale_price_pln,
         sale_price_eur = input.sale_price_eur,
         sale_price_gbp = input.sale_price_gbp,
         measure = input.measure,
         status = case
           when input.type = 'print' and input.status = 'active' then p.status
           else input.status
         end,
         seo_title = input.seo_title,
         seo_description = input.seo_description,
         drop_id = input.drop_id,
         note_index = input.note_index,
         updated_at = now()
    from unnest(v_products) input
   where p.id = input.id
     and not (p.id = any (v_cms_owned_ids));

  -- Media references replaceable variant ids, so clear it before variants.
  -- Both the delete AND the re-insert below must skip CMS-owned ids — the
  -- insert is a separate unconditional statement, not scoped by the delete.
  delete from product_media media
   using unnest(v_products) input
   where media.product_id = input.id
     and not (media.product_id = any (v_cms_owned_ids));

  delete from product_variants variant
   using unnest(v_products) input
   where variant.product_id = input.id
     and not (variant.product_id = any (v_cms_owned_ids));

  insert into product_variants (
    product_id,
    variant_key,
    sku,
    axes,
    price_pln,
    price_eur,
    price_gbp,
    is_default,
    active,
    position,
    track_inventory,
    stock_quantity,
    allow_backorder,
    low_stock_threshold,
    print_area_width_px,
    print_area_height_px
  )
  select
    product_id,
    variant_key,
    sku,
    axes,
    price_pln,
    price_eur,
    price_gbp,
    is_default,
    active,
    position,
    track_inventory,
    stock_quantity,
    allow_backorder,
    low_stock_threshold,
    print_area_width_px,
    print_area_height_px
  from unnest(v_variants)
  where not (product_id = any (v_cms_owned_ids));

  insert into product_media (product_id, url, alt, position, is_primary)
  select product_id, url, alt, position, is_primary
  from unnest(v_media)
  where not (product_id = any (v_cms_owned_ids));

  select array_agg(p.id order by p.id)
    into v_active_print_ids
    from products p
    join unnest(v_products) input on input.id = p.id
   where p.type = 'print' and p.status = 'active';

  if coalesce(cardinality(v_active_print_ids), 0) > 0 then
    perform assert_print_assets_ready(v_active_print_ids);
  end if;

  return jsonb_build_object('skipped_cms_owned_ids', to_jsonb(coalesce(v_cms_owned_ids, '{}'::text[])));
end;
$$;

revoke all on function public.backfill_catalog(jsonb, jsonb, jsonb) from public;
revoke execute on function public.backfill_catalog(jsonb, jsonb, jsonb) from anon, authenticated;
grant execute on function public.backfill_catalog(jsonb, jsonb, jsonb) to service_role;
