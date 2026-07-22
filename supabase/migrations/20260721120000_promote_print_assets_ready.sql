-- Transactional staged → ready promotion for print-fulfilment assets — Phase 2b
-- hardening of the print-asset pipeline (docs/plans/print-asset-pipeline.md).
-- -----------------------------------------------------------------------------
-- `print-assets:verify` previously flipped staged rows to `ready` with a
-- client-side UPDATE. A revoke racing that UPDATE could partially promote a
-- revision (some rows ready, one revoked). This RPC does the whole promotion in
-- one transaction under a product-level FOR UPDATE lock: it validates that every
-- requested key is still staged-or-ready before touching anything, then promotes
-- only the staged rows and returns every requested key with whether THIS call
-- promoted it. Any concurrent state change (a revoke/retire, a missing row)
-- raises `promotion_state_changed` and leaves the prior rows intact.
--
-- Same posture as publish_print_asset_revision / reserve_pieces: search_path
-- pinned, NOT security definer, service-role-only execute grant.

create or replace function promote_print_assets_ready(
  p_product_id text,
  p_revision text,
  p_r2_keys text[],
  p_verified_at timestamptz default now()
) returns table (r2_key text, promoted boolean)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_requested integer := coalesce(cardinality(p_r2_keys), 0);
  v_distinct integer;
  v_eligible integer;
begin
  if v_requested = 0 then
    return;
  end if;

  if p_verified_at is null then
    raise 'verified_at_required';
  end if;

  select count(distinct requested.r2_key)
    into v_distinct
    from unnest(p_r2_keys) as requested(r2_key);
  if v_distinct <> v_requested then
    raise 'duplicate_r2_key';
  end if;

  perform 1
    from products p
   where p.id = p_product_id
     and p.type = 'print'
   for update;
  if not found then
    raise 'product_not_found';
  end if;

  perform 1
    from print_fulfilment_assets a
   where a.product_id = p_product_id
     and a.revision = p_revision
     and a.r2_key = any(p_r2_keys)
   for update;

  select count(*) into v_eligible
    from print_fulfilment_assets a
   where a.product_id = p_product_id
     and a.revision = p_revision
     and a.status in ('staged', 'ready')
     and a.r2_key = any(p_r2_keys);

  if v_eligible <> v_requested then
    raise 'promotion_state_changed' using
      detail = format('requested=%s staged_or_ready=%s', v_requested, v_eligible);
  end if;

  return query
  with changed as (
    update print_fulfilment_assets a
       set status = 'ready', verified_at = p_verified_at
     where a.product_id = p_product_id
       and a.revision = p_revision
       and a.status = 'staged'
       and a.r2_key = any(p_r2_keys)
    returning a.r2_key
  )
  select requested.r2_key, changed.r2_key is not null
    from unnest(p_r2_keys) as requested(r2_key)
    left join changed using (r2_key)
   order by requested.r2_key;
end;
$$;

revoke all on function promote_print_assets_ready(text, text, text[], timestamptz) from public;
revoke all on function promote_print_assets_ready(text, text, text[], timestamptz) from anon, authenticated;
grant execute on function promote_print_assets_ready(text, text, text[], timestamptz) to service_role;

-- Rollback:
-- drop function if exists promote_print_assets_ready(text, text, text[], timestamptz);
