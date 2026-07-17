-- Atomically transition product status, including the print-asset activation
-- gate. The prior application-side readiness read and later UPDATE admitted a
-- TOCTOU race with revision publication or emergency asset revocation.

create or replace function update_product_status_guarded(
  p_product_id  text,
  p_status      text,
  p_actor_email text default null
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_before  products%rowtype;
  v_after   products%rowtype;
  v_missing text[];
begin
  if p_status is null or p_status not in ('draft', 'active', 'hidden', 'archived') then
    raise 'invalid_product_status';
  end if;

  -- Serialises status changes with publish_print_asset_revision, which takes
  -- the same product-level lock before swapping assignments.
  select p.*
    into v_before
    from products p
   where p.id = p_product_id
   for update;
  if not found then
    raise 'product_not_found';
  end if;

  if p_status = 'active'
      and v_before.type = 'print'
      and v_before.status <> 'active' then
    -- Lock every input to the coverage calculation. A concurrent direct asset
    -- revoke either commits before this check (and is rejected here) or waits
    -- until activation commits, becoming a distinct emergency action after it.
    perform pv.id
      from product_variants pv
     where pv.product_id = p_product_id
       and pv.active
     for share;

    perform paa.asset_id
      from print_variant_asset_assignments paa
     where paa.product_id = p_product_id
     for share;

    perform pfa.id
      from print_fulfilment_assets pfa
      join print_variant_asset_assignments paa on paa.asset_id = pfa.id
     where paa.product_id = p_product_id
     for share of pfa;

    select coalesce(array_agg(pv.variant_key order by pv.variant_key), array[]::text[])
      into v_missing
      from product_variants pv
      left join print_variant_asset_assignments paa
        on paa.product_id = pv.product_id
       and paa.variant_key = pv.variant_key
      left join print_fulfilment_assets pfa on pfa.id = paa.asset_id
     where pv.product_id = p_product_id
       and pv.active
       and (
         paa.asset_id is null
         or pfa.id is null
         or pfa.product_id is distinct from p_product_id
         or pfa.status <> 'ready'
         or pv.print_area_width_px is null
         or pv.print_area_height_px is null
         or pfa.width_px is distinct from pv.print_area_width_px
         or pfa.height_px is distinct from pv.print_area_height_px
       );

    if coalesce(array_length(v_missing, 1), 0) > 0 then
      return jsonb_build_object(
        'ok', false,
        'error', 'print_assets_incomplete',
        'missing', to_jsonb(v_missing)
      );
    end if;
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

-- Rollback (manual):
--   drop function if exists update_product_status_guarded(text, text, text);
