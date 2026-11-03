-- Gate NEW ceramic reservations on the current public catalogue and active
-- drop. Keep the hardened inventory/private-sale algorithms and live holds.
-- Deploy before enabling the new storefront; closing a drop never cancels a PI.
begin;

alter function public.reserve_pieces(text[], uuid, integer)
  rename to reserve_pieces_inventory_v1;
alter function public.reserve_private_sale_pieces(text, text[], uuid, integer)
  rename to reserve_private_sale_pieces_inventory_v1;
revoke all on function public.reserve_pieces_inventory_v1(text[], uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.reserve_private_sale_pieces_inventory_v1(text, text[], uuid, integer) from public, anon, authenticated, service_role;

create function public.ceramic_drop_conflicts(p_ids text[], p_order_id uuid)
returns text[] language plpgsql security definer
set search_path = public, pg_temp as $$
declare conflicts text[];
begin
  -- FOR SHARE also conflicts with status-only UPDATEs. Ordered locks make
  -- end-drop and catalogue edits serialize with new reservations.
  perform p.id from products p where p.id = any(p_ids) order by p.id for share;
  perform d.id from drops d
    where d.id in (select p.drop_id from products p where p.id = any(p_ids))
    order by d.id for share;
  perform s.product_id from piece_state s where s.product_id = any(p_ids)
    order by s.product_id for update;

  select coalesce(array_agg(requested.id), '{}'::text[]) into conflicts
  from (select distinct unnest(p_ids) as id) requested
  left join products p on p.id = requested.id
  left join drops d on d.id = p.drop_id
  left join piece_state s on s.product_id = requested.id
  where not coalesce(
    -- Only the owner's still-live hold survives a closed drop. An expired
    -- hold is a new reservation and must satisfy the new-sale rules.
    (s.status = 'reserved' and s.order_id = p_order_id and s.reserved_until > now())
    or (p.type = 'ceramic' and p.status = 'active' and d.status = 'active' and s.showroom = false),
    false
  );
  return conflicts;
end;
$$;
revoke all on function public.ceramic_drop_conflicts(text[], uuid) from public, anon, authenticated, service_role;

create function public.reserve_pieces(p_ids text[], p_order_id uuid, p_ttl_secs integer)
returns text[] language plpgsql security definer
set search_path = public, pg_temp as $$
declare conflicts text[];
begin
  conflicts := ceramic_drop_conflicts(p_ids, p_order_id);
  if cardinality(conflicts) > 0 then return conflicts; end if;
  return reserve_pieces_inventory_v1(p_ids, p_order_id, p_ttl_secs);
end;
$$;

create function public.reserve_private_sale_pieces(p_token text, p_ids text[], p_order_id uuid, p_ttl_secs integer)
returns text[] language plpgsql security definer
set search_path = public, pg_temp as $$
declare conflicts text[];
begin
  -- Keep the private-sale -> piece lock order used by fulfillment/release.
  perform id from private_sales where token = p_token for update;
  conflicts := ceramic_drop_conflicts(p_ids, p_order_id);
  if cardinality(conflicts) > 0 then return conflicts; end if;
  return reserve_private_sale_pieces_inventory_v1(p_token, p_ids, p_order_id, p_ttl_secs);
end;
$$;
revoke all on function public.reserve_pieces(text[], uuid, integer) from public, anon, authenticated;
revoke all on function public.reserve_private_sale_pieces(text, text[], uuid, integer) from public, anon, authenticated;
grant execute on function public.reserve_pieces(text[], uuid, integer) to service_role;
grant execute on function public.reserve_private_sale_pieces(text, text[], uuid, integer) to service_role;

commit;
