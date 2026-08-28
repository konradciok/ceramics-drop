begin;

-- Bulk equivalent of the readiness predicate in
-- 20260717192143_harden_guarded_product_status.sql. Keeping this as a callable,
-- service-role-only assertion gives pgTAP and rollout verification the same
-- behavior the migration itself relies on.
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

  select coalesce(
           array_agg(pv.product_id || ':' || pv.variant_key order by pv.product_id, pv.variant_key),
           array[]::text[]
         )
    into v_missing
    from product_variants pv
    left join print_variant_asset_assignments paa
      on paa.product_id = pv.product_id
     and paa.variant_key = pv.variant_key
    left join print_fulfilment_assets pfa on pfa.id = paa.asset_id
   where pv.product_id = any(p_product_ids)
     and pv.active
     and (
       paa.asset_id is null
       or pfa.id is null
       or pfa.product_id is distinct from pv.product_id
       or pfa.status <> 'ready'
       or pv.print_area_width_px is null
       or pv.print_area_height_px is null
       or pfa.width_px is distinct from pv.print_area_width_px
       or pfa.height_px is distinct from pv.print_area_height_px
     );

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
-- A completely empty catalog is the fresh-schema CI/dev case: there is no data
-- to curate, and the later catalog backfill already projects this same mapping.
-- Any nonempty catalog (including production) must pass the full gate below.
do $$
declare
  active_ids text[];
begin
  if exists (select 1 from products) then
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
  -- Schema-only environments intentionally have no catalog rows until
  -- `catalog:backfill`; production is nonempty and cannot take this branch.
  if not exists (select 1 from products) then
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

commit;

-- Rollback (manual): restore the prior products.num/status snapshot, then drop
-- public.assert_print_assets_ready(text[]). Never delete retained print assets,
-- assignments, variants, media, or historical fulfilment rows.
