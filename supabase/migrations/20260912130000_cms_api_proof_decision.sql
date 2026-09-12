-- CMS API (S1) — proof decision RPC: approve/reject a staged print
-- fulfilment asset. Reuses guard_print_asset_immutable's existing allowed
-- transitions (staged -> ready|revoked) unchanged — this RPC only ever
-- issues that one UPDATE, guarded by `where status = 'staged'` so a
-- concurrent or repeat decision on an already-decided proof fails closed
-- (0 rows updated) rather than silently re-deciding it.

create or replace function decide_print_proof(
  p_asset_id          uuid,
  p_action            text,
  p_expected_revision integer,
  p_actor_email       text
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_product_id        text;
  v_current_revision  integer;
  v_before            jsonb;
  v_after             jsonb;
  v_new_status        text;
  v_updated           integer;
begin
  if p_action not in ('approve', 'reject') then
    raise 'invalid_action';
  end if;
  v_new_status := case p_action when 'approve' then 'ready' else 'revoked' end;

  select pfa.product_id into v_product_id
    from print_fulfilment_assets pfa
   where pfa.id = p_asset_id
   for update;
  if not found then
    raise 'proof_not_found';
  end if;

  perform 1 from products p where p.id = v_product_id for update;

  select coalesce(max(pd.revision), 0)
    into v_current_revision
    from product_drafts pd
   where pd.product_id = v_product_id;

  if v_current_revision <> p_expected_revision then
    raise 'revision_conflict' using detail = format('currentRevision=%s', v_current_revision);
  end if;

  select to_jsonb(pfa) into v_before from print_fulfilment_assets pfa where pfa.id = p_asset_id;

  update print_fulfilment_assets pfa set
    status      = v_new_status,
    verified_at = now()
  where pfa.id = p_asset_id
    and pfa.status = 'staged';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise 'invalid_proof_transition';
  end if;

  select to_jsonb(pfa) into v_after from print_fulfilment_assets pfa where pfa.id = p_asset_id;

  insert into catalog_audit_log (product_id, actor_email, action, before, after, revision)
  values (
    v_product_id,
    p_actor_email,
    case p_action when 'approve' then 'proof_approved' else 'proof_rejected' end,
    v_before,
    v_after,
    p_expected_revision
  );

  return jsonb_build_object('ok', true, 'productId', v_product_id);
end;
$$;

revoke all on function decide_print_proof(uuid, text, integer, text) from public, anon, authenticated;
grant execute on function decide_print_proof(uuid, text, integer, text) to service_role;

-- ============================================================
-- Rollback (manual):
--   drop function if exists decide_print_proof(uuid, text, integer, text);
-- ============================================================
