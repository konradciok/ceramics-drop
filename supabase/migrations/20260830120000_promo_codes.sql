-- ============================================================================
-- Promo codes (2026-08-30)
-- App-owned promotion definitions + redemption ledger. Stripe PaymentIntents
-- do not support Stripe-native coupons, so the discount is applied to the PI
-- amount server-side; these tables are the source of truth.
-- Lifecycle: checkout claims a 'pending' redemption atomically; the Stripe
-- webhook settles it to 'redeemed' (markPaid) or 'released' (releaseHold /
-- cron expiry). Mirrors reserve_pieces / private_sales patterns.
-- Backward-compatibility: purely additive — two new tables, two new RPCs, and
-- two `orders` columns with defaults. The still-running old worker never reads
-- or writes any of it, so the ~6-minute migrate-before-deploy window is safe.
-- Plan: docs/superpowers/plans/2026-08-30-promo-codes-master.md (Phase 1).
-- ============================================================================

create table promo_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique
    check (code = upper(code) and code ~ '^[A-Z0-9_-]{3,32}$'),
  kind text not null check (kind in ('percent', 'fixed')),
  percent integer check (percent between 1 and 100),
  amount_pln integer check (amount_pln > 0),
  amount_eur integer check (amount_eur > 0),
  amount_gbp integer check (amount_gbp > 0),
  applies_to text not null default 'all'
    check (applies_to in ('all', 'ceramics', 'prints')),
  active boolean not null default false,
  starts_at timestamptz,
  expires_at timestamptz,
  max_redemptions integer check (max_redemptions > 0),
  newsletter_welcome boolean not null default false,
  campaign text,
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz not null default now(),
  updated_by text,
  check (kind <> 'percent' or percent is not null),
  check (kind <> 'fixed'
         or (amount_pln is not null and amount_eur is not null and amount_gbp is not null)),
  -- Schedule-window invariant (mirrored by the Phase 4 zod refinement): a
  -- window with both ends set must be non-empty, or it can never be eligible.
  check (starts_at is null or expires_at is null or starts_at < expires_at)
);

-- At most one ACTIVE newsletter-welcome promo at a time.
create unique index promo_codes_one_newsletter_welcome
  on promo_codes (newsletter_welcome)
  where newsletter_welcome and active;

create table promo_redemptions (
  id uuid primary key default gen_random_uuid(),
  promo_id uuid not null references promo_codes (id),
  order_id uuid not null unique references orders (id),
  status text not null default 'pending'
    check (status in ('pending', 'redeemed', 'released')),
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index promo_redemptions_promo_status on promo_redemptions (promo_id, status);

alter table orders
  add column promo_code text,
  add column discount integer not null default 0 check (discount >= 0);

alter table promo_codes enable row level security;
alter table promo_redemptions enable row level security;
-- service-role only, like every other table: no policies added.

-- Atomic claim: enforces max_redemptions under concurrency; re-entrant per
-- order+promo (checkout replays with the same attemptId/order id must not
-- double-count); rejects a claim when the order already holds a live claim
-- for a DIFFERENT promo (one code per order). Returns true ONLY when, on
-- exit, p_order_id holds a live claim for p_promo_id.
-- Ordering matters: the promo-row FOR UPDATE lock is taken FIRST, so two
-- concurrent claims for the same promo serialize before the re-entrancy /
-- capacity checks — the loser of the lock re-reads state the winner already
-- committed (a pre-lock existence check would let a concurrent max-1 re-entry
-- falsely return false).
create or replace function claim_promo_redemption(p_promo_id uuid, p_order_id uuid)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_max integer;
  v_used integer;
begin
  -- Lock first: serialize all claims for this promo.
  select max_redemptions into v_max
    from promo_codes where id = p_promo_id and active
    for update;
  if not found then
    return false;
  end if;

  -- Re-entry (checked AFTER the lock): this order already holds a live claim
  -- for THIS promo — a checkout replay, success.
  if exists (select 1 from promo_redemptions
             where order_id = p_order_id and promo_id = p_promo_id
               and status in ('pending', 'redeemed')) then
    return true;
  end if;

  -- Conflicting claim: the order holds a live claim for a DIFFERENT promo.
  -- One code per order — reject; the caller must not treat this as claimed.
  if exists (select 1 from promo_redemptions
             where order_id = p_order_id and promo_id <> p_promo_id
               and status in ('pending', 'redeemed')) then
    return false;
  end if;

  if v_max is not null then
    select count(*) into v_used from promo_redemptions
      where promo_id = p_promo_id and status in ('pending', 'redeemed');
    if v_used >= v_max then
      return false;
    end if;
  end if;

  insert into promo_redemptions (promo_id, order_id)
  values (p_promo_id, p_order_id)
  on conflict (order_id) do update
    set promo_id = excluded.promo_id, status = 'pending', settled_at = null
    where promo_redemptions.status = 'released';

  -- Post-condition: success iff the requested promo is actually held now.
  -- Guards the race the pre-checks can't cover (a concurrent claim for a
  -- different promo locks a different promo_codes row, so it is NOT
  -- serialized by our lock; its committed live row makes the conditional
  -- ON CONFLICT update above touch zero rows).
  return exists (select 1 from promo_redemptions
                 where order_id = p_order_id and promo_id = p_promo_id
                   and status = 'pending');
end;
$$;

-- Settle: markPaid -> 'redeemed'; releaseHold / cron expiry / pending-refund
-- -> 'released'. The boolean reflects whether the requested terminal state IS
-- recorded on exit: true when this call transitioned pending -> p_status OR
-- the row already sits at p_status (idempotent retry); false when the row is
-- missing or sits at the OTHER terminal state. A blanket `return true` would
-- let a delayed markPaid webhook report success after the expiry cron already
-- released the row — silently never recording 'redeemed' and freeing
-- max_redemptions capacity that a paid order actually consumed. On false for
-- 'redeemed', the caller reconciles: re-claim via claim_promo_redemption
-- (which re-claims 'released' rows for the same order when capacity allows),
-- settle again, and Sentry-alert if capacity is gone (see Phase 2 Task 2).
create or replace function settle_promo_redemption(p_order_id uuid, p_status text)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_updated integer;
begin
  if p_status not in ('redeemed', 'released') then
    raise exception 'invalid settle status %', p_status;
  end if;
  update promo_redemptions
     set status = p_status, settled_at = now()
   where order_id = p_order_id and status = 'pending';
  get diagnostics v_updated = row_count;
  if v_updated > 0 then
    return true;
  end if;
  -- No pending row: true only if the row already carries the requested state.
  return exists (select 1 from promo_redemptions
                 where order_id = p_order_id and status = p_status);
end;
$$;

-- Close default PUBLIC EXECUTE (house style — see 20260813170000_harden_rpc_and_catalog.sql).
revoke all on function claim_promo_redemption(uuid, uuid) from public;
revoke execute on function claim_promo_redemption(uuid, uuid) from anon, authenticated;
grant execute on function claim_promo_redemption(uuid, uuid) to service_role;

revoke all on function settle_promo_redemption(uuid, text) from public;
revoke execute on function settle_promo_redemption(uuid, text) from anon, authenticated;
grant execute on function settle_promo_redemption(uuid, text) to service_role;
