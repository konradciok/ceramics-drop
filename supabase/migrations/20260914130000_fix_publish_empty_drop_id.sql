-- Fix: publish_product_revision 500s when a ceramic publishes with an
-- EMPTY-STRING drop_id, instead of falling through to the active-drop
-- default from 20260914120000_ceramic_drop_default_and_copy.sql.
-- -----------------------------------------------------------------------------
-- Found live-testing S2a's acceptance flow through the real cms-ceramics UI:
-- its "ID dropu (opcjonalnie)" field is a controlled text input that submits
-- '' (not omitted, not null) when left blank. publication.ts's
-- `product.draft.dropId ?? null` only catches null/undefined — an empty
-- string sails through into structuralParam.drop_id as ''. The RPC's coalesce
-- chain then treats '' as a valid override (it IS non-null), so
-- v_resolved_drop_id becomes '' instead of falling through to
-- v_product.drop_id / the active-drop lookup — and `drop_id = ''` violates
-- products_drop_id_fkey (no drop has id ''), surfacing as an uncaught
-- 23503 → generic 500 (none of publication.ts's known-message branches match
-- a raw FK-violation text). This bug predates this migration: the ORIGINAL
-- 20260912120000_cms_api_products.sql coalesce (`coalesce(p_structural->>'drop_id',
-- p.drop_id)`) has the exact same flaw — it was never exercised end-to-end
-- through the real browser form until now.
--
-- Fix: wrap the structural drop_id read in `nullif(..., '')` so an empty
-- string is treated exactly like an absent/null one, at the single
-- authoritative gate every publish goes through — robust to any future
-- caller with the same behavior, not just this one CMS editor field.
--
-- Safety: pure behavior fix, no schema change. A blank dropId now correctly
-- defaults instead of 500ing; every other coalesce input (a real drop id,
-- or a genuinely absent field) is unaffected since nullif is a no-op on them.
--
-- Rollback:
--   drop function if exists publish_product_revision(text, integer, text, text, jsonb, jsonb, jsonb);
--   -- (recreate the 20260914120000_ceramic_drop_default_and_copy.sql definition manually)

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

      perform assert_print_assets_ready(array[p_product_id]);
    else
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
