-- S2a: default a CMS-published ceramic onto the active drop, and materialize
-- its CMS-authored title/description onto the storefront-read `products` row.
-- -----------------------------------------------------------------------------
-- Two independent gaps closed together because both live inside the same
-- `publish_product_revision` ceramic branch, and editing it twice in separate
-- migrations risks one silently overwriting the other:
--
-- 1. drop_id defaulting — a CMS-published ceramic left `drop_id` untouched
--    (structuralParam only ever set it from an explicit cms-ceramics field the
--    editor doesn't meaningfully expose), so `drops_single_active`-guarded
--    `ceramic_drop_conflicts()` (20260909120000_active_drop_purchase_guard.sql)
--    always 409s it at checkout: `p.status='active' and d.status='active'` can
--    never hold when `p.drop_id` is null. Default it server-side, inside this
--    RPC (the one place every writer already goes through, already
--    transactional), to the current active drop. A republish of an
--    already-active product never re-queries `drops` (`p.drop_id` wins first,
--    same coalesce position as every other structural field here). Zero
--    active drops on a genuinely first-ever publish (no explicit drop_id, no
--    prior p.drop_id) raises a new `no_active_drop` error — production always
--    has `drop-1` active today, so this is a guardrail, not an expected
--    trigger; it can never fire on an already-published product.
--
-- 2. title/description materialization — `products` had no title/description
--    column, only single-locale `seo_title`/`seo_description` (search-engine
--    facing, not the visible product name); the storefront synthesized a
--    display name from category+num instead, ignoring real CMS copy. Add
--    `products.title`/`products.description` (PL-only, mirroring the
--    seo_title/seo_description precedent exactly — not a new multi-locale
--    pattern) and materialize from the draft, same coalesce-if-set convention
--    seo_description already uses.
--
-- `drops_single_active` (partial unique index) guards the "current active
-- drop" query above against ever resolving ambiguously. PRE-FLIGHT: before
-- applying this migration to a project, run
--   select count(*) from drops where status = 'active';
-- on that project. Every project seeded from 20260709130000_showroom_drops.sql
-- has exactly one ('drop-1'), so this passes today on both production and the
-- ceramics-cms-integration project. If a project ever fails this check, skip
-- the `create unique index` statement below (comment it out) and keep the
-- rest of this migration — the RPC change stays correct either way, it would
-- just resolve to *a* active drop by recency instead of *the* active drop.
--
-- Safety: both new columns are nullable, no backfill — zero behavior change
-- for every existing (non-CMS) row until a CMS publish sets them.
--
-- Rollback:
--   drop function if exists publish_product_revision(text, integer, text, text, jsonb, jsonb, jsonb);
--   -- (recreate the prior 20260912120000_cms_api_products.sql definition manually)
--   drop index if exists drops_single_active;
--   alter table products drop column if exists description;
--   alter table products drop column if exists title;

-- 1. products.title / products.description ─────────────────────────────────
alter table products add column title       text;
alter table products add column description text;

-- 2. drops_single_active ─────────────────────────────────────────────────────
-- See PRE-FLIGHT note above.
create unique index drops_single_active on drops (status) where status = 'active';

-- 3. publish_product_revision — drop_id default + title/description ────────
create or replace function publish_product_revision(
  p_product_id        text,
  p_expected_revision integer,
  p_action            text,
  p_actor_email       text,
  p_variants          jsonb default null,
  p_media             jsonb default null,
  p_structural        jsonb default null
) returns jsonb
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

  -- revision 0 means "no draft has ever been saved" (product_drafts.revision
  -- starts at 1). products.published_revision has a composite FK to
  -- product_drafts(product_id, revision), so publishing at revision 0 would
  -- otherwise hit an unmapped FK-violation 500 instead of a clear 4xx.
  if p_action = 'publish' and p_expected_revision = 0 then
    raise 'draft_required';
  end if;

  v_before := to_jsonb(v_product);

  if p_action = 'publish' then
    if v_product.type = 'print' then
      if p_variants is null then
        raise 'variants_required';
      end if;

      delete from product_variants pv where pv.product_id = p_product_id;

      insert into product_variants (
        product_id, variant_key, sku, is_default, active, position,
        track_inventory, stock_quantity, allow_backorder,
        print_area_width_px, print_area_height_px, axes
      )
      select
        p_product_id,
        j.obj->>'variant_key',
        j.obj->>'sku',
        false,
        true,
        (j.idx - 1)::integer,
        false, 0, true,
        (j.obj->>'print_area_width_px')::integer,
        (j.obj->>'print_area_height_px')::integer,
        j.obj->'axes'
      from jsonb_array_elements(p_variants) with ordinality as j(obj, idx);

      -- Locked check, not the bare (unlocked) print_asset_readiness_missing():
      -- assert_print_assets_ready (20260828120000_curate_fine_art_prints.sql)
      -- takes FOR SHARE on the variant/assignment/asset rows and holds them
      -- through commit, closing a TOCTOU race where a concurrent asset-revoke
      -- could slip in between this check and the status update below. The
      -- pre-existing products_guard_print_activation trigger does NOT catch
      -- this on a republish of an ALREADY-active print — it only re-verifies
      -- on the transition INTO 'active' (old.status IS DISTINCT FROM
      -- 'active'), so a republish that keeps status='active' throughout
      -- would otherwise skip verification entirely. Raises
      -- 'print_assets_incomplete: <missing keys>' directly if not ready.
      perform assert_print_assets_ready(array[p_product_id]);
    else
      if p_structural is null then
        raise 'structural_required';
      end if;

      -- Explicit drop_id wins; else keep whatever this product already has
      -- (a republish never re-picks the active drop out from under it); else
      -- default to the current active drop. Only a genuinely first-ever
      -- publish (v_product.drop_id still null) with zero active drops and no
      -- explicit drop_id ever reaches the no_active_drop guard below.
      v_resolved_drop_id := coalesce(
        p_structural->>'drop_id',
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
    end if;

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

revoke all on function publish_product_revision(text, integer, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function publish_product_revision(text, integer, text, text, jsonb, jsonb, jsonb) to service_role;
