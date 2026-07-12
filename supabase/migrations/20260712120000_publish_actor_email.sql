-- Publish RPC: accept the publishing actor's email as an explicit parameter so
-- the publish CLI (which cannot set a per-session GUC through PostgREST / the
-- supabase-js RPC path) can record who published a revision. Today every
-- publish audit row has actor_email = null for that reason.
--
-- Backward-compatible: p_actor_email defaults to null, and the audit expression
-- falls back to the app.actor_email GUC when the param is null — so every
-- existing 3-arg caller (including every pgTAP call) keeps working unchanged.
-- Adding a parameter cannot be done with CREATE OR REPLACE, so the function is
-- dropped first. No grant/policy pins the old 3-arg OID (verified: the only
-- references are the definition, the rollback comment, and positional calls).

drop function if exists publish_print_asset_revision(text, text, jsonb);

create function publish_print_asset_revision(
  p_product_id   text,
  p_revision     text,
  p_assignments  jsonb,
  p_actor_email  text default null
) returns table (
  product_id     text,
  revision       text,
  assigned_count integer
)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_active_keys   text[];
  v_assign_keys   text[];
  v_missing       text[];
  v_extra         text[];
  v_total         integer;
  v_distinct      integer;
  v_fail_key      text;
  v_fail_reason   text;
  v_before        jsonb;
  v_count         integer;
begin
  -- Qualify EVERY column reference with a table alias: RETURNS TABLE columns
  -- (product_id, revision, assigned_count) are OUT-parameter names in scope, so
  -- a bare `product_id` / `revision` is ambiguous (SQLSTATE 42702). Same hazard
  -- publish_cms_version calls out.

  -- (1) Lock the print product. FOR UPDATE serialises concurrent publishes.
  perform 1 from products p
    where p.id = p_product_id
      and p.type = 'print'
    for update;
  if not found then
    raise 'product_not_found';
  end if;

  -- (2) Exact coverage: the active-variant key set must equal the assignment key
  -- set — no missing, no extra, no duplicate.
  select array_agg(pv.variant_key order by pv.variant_key)
    into v_active_keys
    from product_variants pv
   where pv.product_id = p_product_id
     and pv.active;

  select array_agg(a.k), count(*), count(distinct a.k)
    into v_assign_keys, v_total, v_distinct
    from (select j->>'variant_key' as k from jsonb_array_elements(p_assignments) j) a;

  select array_agg(k)
    into v_missing
    from unnest(coalesce(v_active_keys, array[]::text[])) as k
   where k <> all (coalesce(v_assign_keys, array[]::text[]));

  select array_agg(k)
    into v_extra
    from unnest(coalesce(v_assign_keys, array[]::text[])) as k
   where k <> all (coalesce(v_active_keys, array[]::text[]));

  if coalesce(array_length(v_missing, 1), 0) > 0
      or coalesce(array_length(v_extra, 1), 0) > 0
      or coalesce(v_total, 0) <> coalesce(v_distinct, 0) then
    raise 'assignment_mismatch' using
      detail = format(
        'missing=%L extra=%L duplicate=%L',
        v_missing,
        v_extra,
        case when coalesce(v_total, 0) <> coalesce(v_distinct, 0) then true else false end
      );
  end if;

  -- (2b) Reject malformed asset_id values before casting to uuid.
  if exists (
    select 1
      from jsonb_array_elements(p_assignments) j(elem)
     where not ((j.elem->>'asset_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) then
    raise 'invalid_asset_id';
  end if;

  -- (3) Per-assignment readiness: asset exists, belongs to this product, is
  -- `ready`, matches p_revision, and its dimensions equal the variant's print
  -- area. A null print_area_*_px (variant not yet seeded) compares unequal →
  -- dimension mismatch, i.e. fail-closed. Raise the first classified failure.
  select a.var_key, a.reason
    into v_fail_key, v_fail_reason
    from (
      select pv.variant_key as var_key,
             case
               when pfa.id is null or pfa.product_id is distinct from p_product_id
                 then 'wrong_product'
               when pfa.status <> 'ready'
                 then 'asset_not_ready'
               when pfa.revision is distinct from p_revision
                 then 'revision_mismatch'
               when pfa.width_px  is distinct from pv.print_area_width_px
                 or pfa.height_px is distinct from pv.print_area_height_px
                 then 'dimension_mismatch'
             end as reason,
             j.idx as idx
        from jsonb_array_elements(p_assignments) with ordinality as j(obj, idx)
        join product_variants pv
          on pv.product_id = p_product_id
         and pv.variant_key = j.obj->>'variant_key'
        left join print_fulfilment_assets pfa
          on pfa.id = (j.obj->>'asset_id')::uuid
       where pfa.id is null
          or pfa.product_id is distinct from p_product_id
          or pfa.status <> 'ready'
          or pfa.revision is distinct from p_revision
          or pfa.width_px  is distinct from pv.print_area_width_px
          or pfa.height_px is distinct from pv.print_area_height_px
    ) a
    order by a.idx
    limit 1;

  if v_fail_reason is not null then
    raise '%', v_fail_reason using detail = format('variant_key=%L', v_fail_key);
  end if;

  -- Snapshot the pre-publish assignment set for the audit record (before the
  -- swap empties it).
  select coalesce(
           jsonb_agg(jsonb_build_object('variant_key', aa.variant_key, 'asset_id', aa.asset_id)
                     order by aa.variant_key),
           '[]'::jsonb)
    into v_before
    from print_variant_asset_assignments aa
   where aa.product_id = p_product_id;

  -- (4) Atomic swap: delete every existing assignment for the product, then
  -- insert the new set. Both statements share this transaction, so any failure
  -- (or a raised check above) rolls the prior assignments back intact.
  delete from print_variant_asset_assignments pa
   where pa.product_id = p_product_id;

  insert into print_variant_asset_assignments (product_id, variant_key, asset_id)
  select p_product_id, j.obj->>'variant_key', (j.obj->>'asset_id')::uuid
    from jsonb_array_elements(p_assignments) with ordinality as j(obj, idx);

  select count(*) into v_count
    from print_variant_asset_assignments pa
   where pa.product_id = p_product_id;

  -- (5) Audit record. catalog_audit_log already encodes (product_id, action,
  -- before, after) — exactly this event's shape — so we reuse it rather than
  -- add a parallel mechanism. actor_email prefers the explicit p_actor_email
  -- (the publish CLI can't set a GUC via PostgREST) and falls back to the
  -- app.actor_email GUC; null when neither is set.
  insert into catalog_audit_log (product_id, actor_email, action, before, after)
  values (
    p_product_id,
    coalesce(nullif(p_actor_email, ''), nullif(current_setting('app.actor_email', true), '')),
    'print_asset_publish',
    v_before,
    jsonb_build_object('revision', p_revision, 'assignments', p_assignments)
  );

  return query
  select p_product_id, p_revision, v_count;
end;
$$;
