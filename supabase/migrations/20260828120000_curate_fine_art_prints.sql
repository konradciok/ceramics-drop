begin;

-- One authoritative readiness projection shared by bulk curation, guarded
-- status publication, and the direct-write trigger installed below. A print is
-- not publishable when the row is absent/not a print, when it has zero active
-- variants, or when any active variant lacks a same-product, ready,
-- non-revoked, dimension-matching assigned asset.
create or replace function print_asset_readiness_missing(p_product_ids text[])
returns text[]
language sql
stable
set search_path = public, pg_temp
as $$
  with requested(product_id) as (
    select distinct requested_id
      from unnest(coalesce(p_product_ids, array[]::text[])) as ids(requested_id)
  ),
  violations(missing_key) as (
    select requested.product_id || ':<product_missing_or_not_print>'
      from requested
      left join products p on p.id = requested.product_id
     where p.id is null or p.type <> 'print'

    union all

    select requested.product_id || ':<no_active_variants>'
      from requested
      join products p on p.id = requested.product_id and p.type = 'print'
     where not exists (
       select 1
         from product_variants pv
        where pv.product_id = requested.product_id
          and pv.active
     )

    union all

    select pv.product_id || ':' || pv.variant_key
      from requested
      join product_variants pv
        on pv.product_id = requested.product_id
       and pv.active
      left join print_variant_asset_assignments paa
        on paa.product_id = pv.product_id
       and paa.variant_key = pv.variant_key
      left join print_fulfilment_assets pfa on pfa.id = paa.asset_id
     where paa.asset_id is null
        or pfa.id is null
        or pfa.product_id is distinct from pv.product_id
        or pfa.status <> 'ready'
        or pv.print_area_width_px is null
        or pv.print_area_height_px is null
        or pfa.width_px is distinct from pv.print_area_width_px
        or pfa.height_px is distinct from pv.print_area_height_px
  )
  select coalesce(array_agg(missing_key order by missing_key), array[]::text[])
    from violations;
$$;

revoke all on function public.print_asset_readiness_missing(text[]) from public;
revoke execute on function public.print_asset_readiness_missing(text[]) from anon, authenticated;
grant execute on function public.print_asset_readiness_missing(text[]) to service_role;

-- The service-role-only assertion adds the lock chain needed for a stable
-- readiness decision, then delegates the actual predicate to the shared helper.
create or replace function assert_print_assets_ready(p_product_ids text[])
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_missing text[];
begin
  if coalesce(cardinality(p_product_ids), 0) = 0 then
    raise exception 'print_product_ids_required';
  end if;

  -- Take the same lock chain as update_product_status_guarded, in stable order.
  -- The product lock also prevents a concurrent variant insert through the FK;
  -- the remaining locks freeze activation, assignment swaps, and asset state.
  perform p.id
    from products p
   where p.id = any(p_product_ids)
   order by p.id
   for update;

  perform pv.id
    from product_variants pv
   where pv.product_id = any(p_product_ids)
   order by pv.product_id, pv.variant_key
   for share;

  perform paa.asset_id
    from print_variant_asset_assignments paa
   where paa.product_id = any(p_product_ids)
   order by paa.product_id, paa.variant_key
   for share;

  perform pfa.id
    from print_fulfilment_assets pfa
    join print_variant_asset_assignments paa on paa.asset_id = pfa.id
   where paa.product_id = any(p_product_ids)
   order by pfa.id
   for share of pfa;

  v_missing := print_asset_readiness_missing(p_product_ids);

  if cardinality(v_missing) > 0 then
    raise exception 'print_assets_incomplete: %', array_to_string(v_missing, ',');
  end if;
end;
$$;

revoke all on function public.assert_print_assets_ready(text[]) from public;
revoke execute on function public.assert_print_assets_ready(text[]) from anon, authenticated;
grant execute on function public.assert_print_assets_ready(text[]) to service_role;

-- Materialise the immutable rollout snapshot once so readiness, projection, and
-- postconditions cannot drift onto different ID lists inside this migration.
create temporary table print_curation_map (
  id text primary key,
  num text not null,
  status text not null check (status in ('active', 'archived'))
) on commit drop;

insert into print_curation_map (id, num, status)
values
    ('fap001', '01', 'active'),
    ('fap002', '02', 'active'),
    ('fap003', '03', 'active'),
    ('fap006', '04', 'active'),
    ('fap007', '05', 'active'),
    ('fap010', '06', 'active'),
    ('fap012', '07', 'active'),
    ('fap014', '08', 'active'),
    ('fap016', '09', 'active'),
    ('fap011', '10', 'active'),
    ('fap018', '11', 'active'),
    ('fap036', '12', 'active'),
    ('fap041', '13', 'active'),
    ('fap005', '14', 'active'),
    ('fap023', '15', 'active'),
    ('fap026', '16', 'active'),
    ('fap038', '17', 'active'),
    ('fap039', '18', 'active'),
    ('fap024', '19', 'active'),
    ('fap027', '20', 'active'),
    ('fap030', '21', 'active'),
    ('fap031', '22', 'active'),
    ('fap032', '23', 'active'),
    ('fap004', '24', 'active'),
    ('fap008', '25', 'active'),
    ('fap025', '26', 'active'),
    ('fap033', '27', 'active'),
    ('fap019', '28', 'active'),
    ('fap020', '29', 'active'),
    ('fap021', '30', 'active'),
    ('fap034', '31', 'active'),
    ('fap015', '32', 'active'),
    ('fap028', '33', 'active'),
    ('fap035', '34', 'active'),
    ('fap040', '35', 'active'),
    ('fap009', '36', 'active'),
    ('fap013', '37', 'active'),
    ('fap017', '38', 'active'),
    ('fap022', '39', 'active'),
    ('fap029', '029', 'archived'),
    ('fap037', '037', 'archived');

-- Fail before the first product mutation. An exception aborts this transaction,
-- leaving every status, number, variant, assignment, asset, and media row as-is.
-- A catalog with no mapped product rows is the fresh-schema/ceramics-only case:
-- there is no print data to curate, and a later catalog backfill projects this
-- same mapping. Once even one mapped ID exists, the full gate fails closed;
-- readiness also rejects a mapped row whose type is not `print`.
do $$
declare
  active_ids text[];
begin
  if exists (
    select 1
    from products p
    join print_curation_map mapped on mapped.id = p.id
  ) then
    select array_agg(id order by id)
      into active_ids
      from print_curation_map
     where status = 'active';
    perform assert_print_assets_ready(active_ids);
  end if;
end
$$;

update products as p
set num = mapped.num,
    status = mapped.status,
    updated_at = now()
from print_curation_map as mapped
where p.id = mapped.id
  and p.type = 'print';

do $$
declare
  active_count integer;
  active_number_count integer;
  missing_count integer;
begin
  -- Schema-only and ceramics-only environments intentionally have no mapped
  -- product rows until `catalog:backfill` and therefore have nothing to verify.
  if not exists (
    select 1
    from products p
    join print_curation_map mapped on mapped.id = p.id
  ) then
    return;
  end if;

  select count(*), count(distinct num)
  into active_count, active_number_count
  from products
  where type = 'print' and status = 'active';

  if active_count <> 39 or active_number_count <> 39 then
    raise exception 'print curation expected 39 active rows and 39 unique numbers, got % and %',
      active_count, active_number_count;
  end if;

  if (select min(num) from products where type = 'print' and status = 'active') <> '01'
     or (select max(num) from products where type = 'print' and status = 'active') <> '39' then
    raise exception 'print curation expected active number range 01..39';
  end if;

  if exists (
    select 1 from products
    where id in ('fap029', 'fap037') and status <> 'archived'
  ) then
    raise exception 'fap029 and fap037 must be archived';
  end if;

  select count(*) into missing_count
  from print_curation_map as expected
  left join products p on p.id = expected.id and p.type = 'print'
  where p.id is null;

  if missing_count <> 0 then
    raise exception 'print curation is missing % mapped product rows', missing_count;
  end if;
end
$$;

-- Re-point the admin publication RPC at the same authoritative predicate. The
-- response keeps its existing one-product `missing` shape (variant keys only),
-- while the shared helper retains product prefixes for bulk diagnostics.
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
    perform pv.id
      from product_variants pv
     where pv.product_id = p_product_id
     order by pv.variant_key
     for share;

    perform paa.asset_id
      from print_variant_asset_assignments paa
     where paa.product_id = p_product_id
     order by paa.variant_key
     for share;

    perform pfa.id
      from print_fulfilment_assets pfa
      join print_variant_asset_assignments paa on paa.asset_id = pfa.id
     where paa.product_id = p_product_id
     order by pfa.id
     for share of pfa;

    v_missing := print_asset_readiness_missing(array[p_product_id]);
    if cardinality(v_missing) > 0 then
      select array_agg(
               substring(missing_key from char_length(p_product_id) + 2)
               order by missing_key
             )
        into v_missing
        from unnest(v_missing) as missing(missing_key);
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

revoke all on function public.update_product_status_guarded(text, text, text) from public;
revoke execute on function public.update_product_status_guarded(text, text, text) from anon, authenticated;
grant execute on function public.update_product_status_guarded(text, text, text) to service_role;

-- Fail closed for every future product insert/upsert, not only the repository
-- backfill. New rows default to draft. Any direct transition to active must pass
-- the same locked assertion as the admin RPC; this closes alternate SQL/client
-- upsert paths without changing already-active production rows.
alter table products alter column status set default 'draft';

create or replace function guard_print_product_activation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.type = 'print' and new.status = 'active' then
    if tg_op = 'INSERT' then
      raise exception 'print_assets_incomplete: %', new.id || ':<no_active_variants>';
    elsif old.type is distinct from 'print' or old.status is distinct from 'active' then
      perform assert_print_assets_ready(array[new.id]);
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.guard_print_product_activation() from public;

create trigger products_guard_print_activation
before insert or update on products
for each row execute function guard_print_product_activation();

-- The registry backfill replaces variants/media, so it must be one database
-- transaction now that the catalog is a live read path. Products are proposed
-- with insert-safe statuses (new registry-active prints become draft), then
-- existing registry-active prints retain their current DB status during the
-- structural update. Any insertion failure or post-replacement readiness
-- failure rolls the products, variants, and media back together.
create or replace function backfill_catalog(
  p_products jsonb,
  p_variants jsonb,
  p_media jsonb
) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_products products[];
  v_variants product_variants[];
  v_media product_media[];
  v_active_print_ids text[];
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

  -- BEFORE INSERT fires before ON CONFLICT resolution. Always propose draft
  -- for registry-active prints so an existing active print does not trip the
  -- insert guard merely because its row already exists.
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
   where p.id = input.id;

  -- Media references replaceable variant ids, so clear it before variants.
  delete from product_media media
   using unnest(v_products) input
   where media.product_id = input.id;

  delete from product_variants variant
   using unnest(v_products) input
   where variant.product_id = input.id;

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
  from unnest(v_variants);

  insert into product_media (product_id, url, alt, position, is_primary)
  select product_id, url, alt, position, is_primary
  from unnest(v_media);

  select array_agg(p.id order by p.id)
    into v_active_print_ids
    from products p
    join unnest(v_products) input on input.id = p.id
   where p.type = 'print' and p.status = 'active';

  if coalesce(cardinality(v_active_print_ids), 0) > 0 then
    perform assert_print_assets_ready(v_active_print_ids);
  end if;

end;
$$;

revoke all on function public.backfill_catalog(jsonb, jsonb, jsonb) from public;
revoke execute on function public.backfill_catalog(jsonb, jsonb, jsonb) from anon, authenticated;
grant execute on function public.backfill_catalog(jsonb, jsonb, jsonb) to service_role;

commit;

-- Rollback (manual): restore the prior products.num/status snapshot and prior
-- update_product_status_guarded body; drop products_guard_print_activation,
-- guard_print_product_activation(), backfill_catalog(jsonb,jsonb,jsonb),
-- assert_print_assets_ready(text[]), and print_asset_readiness_missing(text[]);
-- restore products.status default
-- 'active'. Never delete retained assets, assignments, variants, media, or
-- historical fulfilment rows.
