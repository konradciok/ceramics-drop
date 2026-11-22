-- Drop lifecycle: upcoming → active → ended, switched atomically (2026-11-22).
--
-- A new batch of one-of-a-kind ceramics is loaded ahead of its launch as an
-- `upcoming` drop: its pieces exist in products/piece_state but the storefront
-- hides them (src/lib/drop-visibility.ts). On launch day launch_drop() ends the
-- current active drop and activates the upcoming one in one transaction, so
-- the shop never shows both batches or neither. Pieces of an ended drop move
-- to the /showroom archive and stop being purchasable (ceramic_drop_conflicts
-- already requires an active drop).

-- ── 1. Status vocabulary ───────────────────────────────────────────────────
alter table public.drops drop constraint if exists drops_status_check;
alter table public.drops
  add constraint drops_status_check check (status in ('upcoming', 'active', 'ended'));

-- At most one batch waits for launch at a time (mirrors drops_single_active).
create unique index if not exists drops_single_upcoming
  on public.drops (status) where status = 'upcoming';

-- Every live ceramic must belong to an existing drop: the storefront hides a
-- piece whose drop it cannot resolve. CMS publishes always assign one (or
-- raise no_active_drop); this adopts any older active row still without one.
update public.products
   set drop_id = (select d.id from public.drops d where d.status = 'active' limit 1)
 where drop_id is null
   and status = 'active'
   and exists (select 1 from public.drops d where d.status = 'active');

-- ── 2. launch_drop ───────────────────────────────────────────────────────────
create or replace function public.launch_drop(p_drop_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target drops%rowtype;
  v_ended  text;
begin
  -- Lock every drop row so two concurrent launches serialise.
  perform 1 from drops order by id for update;

  select * into v_target from drops where id = p_drop_id;
  if not found then
    raise 'drop_not_found';
  end if;
  if v_target.status <> 'upcoming' then
    raise 'drop_not_upcoming' using detail = format('status=%s', v_target.status);
  end if;

  update drops
     set status = 'ended', ended_at = now()
   where status = 'active'
  returning id into v_ended;

  update drops
     set status = 'active', started_at = now(), ended_at = null
   where id = p_drop_id;

  return jsonb_build_object('ended', v_ended, 'started', p_drop_id);
end;
$$;

revoke all on function public.launch_drop(text) from public, anon, authenticated;
grant execute on function public.launch_drop(text) to service_role;
