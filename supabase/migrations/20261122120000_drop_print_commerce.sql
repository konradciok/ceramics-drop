-- Drop the retired fine-art print commerce schema (2026-11-22).
--
-- Fine-art prints moved to their own shop (https://anna-ciok.com); this store
-- is ceramics, gift cards and workshops only. PR #379–#382 removed every code
-- path that read or wrote the objects below, and the Prodigi queues and the
-- print-asset container were deleted from Cloudflare. A data backup of every
-- dropped table was taken before this migration was applied to production.
--
-- Kept on purpose (accounting history, never rewritten):
--   * orders / order_items rows, including order_items.variant print snapshots
--     (rendered by src/lib/legacy-print-lines.ts) and the 'prodigi' value of
--     orders.fulfilment_type;
--   * the 'prints' value of promo_codes.applies_to (existing rows);
--   * catalog_audit_log rows for print products (no FK to products);
--   * cms_documents page:print-pdp (now only the gift-card artist bio).
--
-- Kept for the CMS contract until the cms-ceramics client drops it: the
-- `international` shipping_rates resource.

-- ── 1. Guards that would fire while deleting print rows ─────────────────────
drop trigger if exists products_guard_print_activation on public.products;

-- ── 2. Print fulfilment, asset, pricing and collection tables ───────────────
-- CASCADE only removes the FK constraints between these tables (and from them
-- to products/orders); no view, policy or publication depends on them.
drop table if exists
  public.print_asset_jobs,
  public.print_asset_uploads,
  public.print_variant_asset_assignments,
  public.print_fulfilment_assets,
  public.print_pricing_config,
  public.pricing_config_drafts,
  public.collection_drafts,
  public.collections,
  public.prodigi_orders,
  public.fulfilment_jobs,
  public.pod_variants
  cascade;

-- ── 3. Print-only RPCs and trigger functions ────────────────────────────────
drop function if exists public.assert_print_assets_ready(text[]);
drop function if exists public.print_asset_readiness_missing(text[]);
drop function if exists public.promote_print_assets_ready(text, text, text[], timestamptz);
drop function if exists public.publish_print_asset_revision(text, text, jsonb, text);
drop function if exists public.decide_print_proof(uuid, text, text, integer, text);
drop function if exists public.guard_print_asset_immutable();
drop function if exists public.guard_print_product_activation();
drop function if exists public.publish_pricing_revision(integer, text);
drop function if exists public.save_pricing_draft(integer, jsonb, text);
drop function if exists public.restore_pricing_draft(integer, integer, text);
drop function if exists public.pricing_config_draft_values(jsonb);
drop function if exists public.create_collection_with_draft(text, jsonb, text);
drop function if exists public.save_collection_draft(text, integer, jsonb, text);
drop function if exists public.publish_collection_revision(text, integer, text);
drop function if exists public.restore_collection_draft(text, integer, integer, text);

-- ── 4. Print catalogue rows ─────────────────────────────────────────────────
-- Cascades to product_drafts, product_variants and product_media.
-- order_items.product_id has no FK to products, so order history is untouched.
delete from public.products where type <> 'ceramic';

alter table public.products drop constraint if exists products_type_check;
alter table public.products
  add constraint products_type_check check (type = 'ceramic');

alter table public.product_variants drop constraint if exists product_variants_print_area_paired;
alter table public.product_variants
  drop column if exists print_area_width_px,
  drop column if exists print_area_height_px;

-- ── 5. Kept RPCs, redefined without their print branches ────────────────────
-- CREATE OR REPLACE keeps each function's existing grants (service_role only).

create or replace function public.update_product_status_guarded(
  p_product_id text,
  p_status text,
  p_actor_email text default null
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_before products%rowtype;
  v_after  products%rowtype;
begin
  if p_status is null or p_status not in ('draft', 'active', 'hidden', 'archived') then
    raise 'invalid_product_status';
  end if;

  select p.*
    into v_before
    from products p
   where p.id = p_product_id
   for update;
  if not found then
    raise 'product_not_found';
  end if;

  update products p
     set status = p_status,
         updated_at = now(),
         published_at = case
           when p_status = 'active' and p.published_at is null then now()
           else p.published_at
         end
   where p.id = p_product_id
   returning p.* into v_after;

  insert into catalog_audit_log (product_id, actor_email, action, before, after)
  values (
    p_product_id,
    nullif(p_actor_email, ''),
    'status:' || p_status,
    to_jsonb(v_before),
    to_jsonb(v_after)
  );

  return jsonb_build_object('ok', true, 'product', to_jsonb(v_after));
end;
$$;

create or replace function public.create_product_with_draft(
  p_id text,
  p_type text,
  p_category_slug text,
  p_num text,
  p_payload jsonb,
  p_actor_email text
)
returns product_drafts
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_row product_drafts%rowtype;
begin
  if p_type is distinct from 'ceramic' then
    raise 'invalid_type';
  end if;

  -- Write the already-validated (zod .positive()) prices immediately, in
  -- whole units matching products.price_pln's convention (the draft payload
  -- carries minor units — grosze/cents/pence), so a ceramic row is never
  -- inserted with a null price, draft or not.
  insert into products (id, type, category_slug, num, status, price_pln, price_eur, price_gbp)
  values (
    p_id, p_type, p_category_slug, p_num, 'draft',
    round((p_payload->>'pricePln')::numeric / 100)::integer,
    round((p_payload->>'priceEur')::numeric / 100)::integer,
    round((p_payload->>'priceGbp')::numeric / 100)::integer
  );

  insert into product_drafts (product_id, revision, payload, created_by)
  values (p_id, 1, p_payload, p_actor_email)
  returning * into v_row;

  insert into catalog_audit_log (product_id, actor_email, action, before, after, revision)
  values (p_id, p_actor_email, 'draft_saved', null, p_payload, 1);

  return v_row;
end;
$$;

-- p_variants stays in the signature (callers pass null) so the CmsApi
-- publication handler and PostgREST's named-argument lookup keep resolving.
create or replace function public.publish_product_revision(
  p_product_id text,
  p_expected_revision integer,
  p_action text,
  p_actor_email text,
  p_variants jsonb default null,
  p_media jsonb default null,
  p_structural jsonb default null
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_current_revision integer;
  v_product          products%rowtype;
  v_before           jsonb;
  v_after            jsonb;
  v_resolved_drop_id text;
begin
  if p_action not in ('publish', 'hide', 'archive') then
    raise 'invalid_action';
  end if;

  select * into v_product from products p where p.id = p_product_id for update;
  if not found then
    raise 'product_not_found';
  end if;

  select coalesce(max(pd.revision), 0)
    into v_current_revision
    from product_drafts pd
   where pd.product_id = p_product_id;

  if v_current_revision <> p_expected_revision then
    raise 'revision_conflict' using detail = format('currentRevision=%s', v_current_revision);
  end if;

  if p_action = 'publish' and p_expected_revision = 0 then
    raise 'draft_required';
  end if;

  v_before := to_jsonb(v_product);

  if p_action = 'publish' then
    if p_structural is null then
      raise 'structural_required';
    end if;

    -- nullif(..., ''): a blank cms-ceramics dropId field submits '' (not
    -- omitted/null) — treat it exactly like an absent field so it falls
    -- through to the existing/active-drop default instead of violating
    -- products_drop_id_fkey with drop_id = ''.
    v_resolved_drop_id := coalesce(
      nullif(p_structural->>'drop_id', ''),
      v_product.drop_id,
      (select d.id from drops d where d.status = 'active'
       order by d.started_at desc nulls last, d.created_at desc limit 1)
    );
    if v_resolved_drop_id is null then
      raise 'no_active_drop';
    end if;

    update products p set
      category_slug   = coalesce(p_structural->>'category_slug', p.category_slug),
      num             = coalesce(p_structural->>'num', p.num),
      measure         = coalesce(p_structural->>'measure', p.measure),
      price_pln       = (p_structural->>'price_pln')::integer,
      price_eur       = (p_structural->>'price_eur')::integer,
      price_gbp       = (p_structural->>'price_gbp')::integer,
      drop_id         = v_resolved_drop_id,
      title           = coalesce(p_structural->>'title', p.title),
      description     = coalesce(p_structural->>'description', p.description),
      seo_title       = coalesce(p_structural->>'seo_title', p.seo_title),
      seo_description = coalesce(p_structural->>'seo_description', p.seo_description)
    where p.id = p_product_id;

    insert into product_variants (product_id, variant_key, is_default, active)
    values (p_product_id, 'default', true, true)
    on conflict (product_id, variant_key) do nothing;

    insert into piece_state (product_id, status)
    values (p_product_id, 'available')
    on conflict (product_id) do nothing;

    if p_media is not null then
      delete from product_media pm where pm.product_id = p_product_id;

      insert into product_media (product_id, url, alt, position, is_primary)
      select p_product_id, j.obj->>'url', j.obj->>'alt', (j.obj->>'position')::integer, (j.obj->>'is_primary')::boolean
        from jsonb_array_elements(p_media) with ordinality as j(obj, idx);
    end if;

    update products p set
      status              = 'active',
      published_revision  = p_expected_revision,
      published_at        = coalesce(p.published_at, now()),
      updated_at          = now()
    where p.id = p_product_id;
  else
    update products p set
      status     = case p_action when 'hide' then 'hidden' else 'archived' end,
      updated_at = now()
    where p.id = p_product_id;
  end if;

  select * into v_product from products p where p.id = p_product_id;
  v_after := to_jsonb(v_product);

  insert into catalog_audit_log (product_id, actor_email, action, before, after, revision)
  values (
    p_product_id,
    p_actor_email,
    case p_action when 'publish' then 'status:active' when 'hide' then 'status:hidden' else 'status:archived' end,
    v_before,
    v_after,
    p_expected_revision
  );

  return jsonb_build_object('ok', true, 'product', v_after);
end;
$$;

create or replace function public.backfill_catalog(p_products jsonb, p_variants jsonb, p_media jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_products products[];
  v_variants product_variants[];
  v_media product_media[];
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

  -- Serialise status changes for every existing seeded product before any
  -- structural mutation.
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
    status,
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
         status = input.status,
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
    low_stock_threshold
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
    low_stock_threshold
  from unnest(v_variants)
  where not (product_id = any (v_cms_owned_ids));

  insert into product_media (product_id, url, alt, position, is_primary)
  select product_id, url, alt, position, is_primary
  from unnest(v_media)
  where not (product_id = any (v_cms_owned_ids));

  return jsonb_build_object('skipped_cms_owned_ids', to_jsonb(coalesce(v_cms_owned_ids, '{}'::text[])));
end;
$$;
