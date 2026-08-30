# Promo Codes — Phase 1: Data model & domain logic

> **For agentic workers:** Part of `2026-08-30-promo-codes-master.md` — read the master's "Locked architecture decisions" and "Global constraints" first; they are binding here. Execute in the `feat/promo-codes` worktree. TDD; commit after each green step; run the master's self-review loop before declaring the phase done.

**Goal:** The Supabase schema (`promo_codes`, `promo_redemptions`, claim/settle RPCs, `orders` columns) and a pure domain module `src/lib/promo.ts` with full unit coverage. No route, UI, or webhook changes yet.

**Files:**
- Create: `supabase/migrations/20260830120000_promo_codes.sql`
- Create: `src/lib/promo.ts`
- Create: `src/lib/promo.test.ts`

**Interfaces produced (later phases depend on these exact names):**
```ts
// src/lib/promo.ts
export type PromoKind = 'percent' | 'fixed'
export type PromoAppliesTo = 'all' | 'ceramics' | 'prints'
export type PromoTrack = 'ceramics' | 'prints'   // cart fulfilment type; carts are never mixed

export interface PromoCode {
  id: string                    // uuid
  code: string                  // normalized (see normalizePromoCode)
  kind: PromoKind
  percent: number | null        // 1..100 when kind='percent'
  amount_pln: number | null     // minor units when kind='fixed'
  amount_eur: number | null
  amount_gbp: number | null
  applies_to: PromoAppliesTo
  active: boolean
  starts_at: string | null      // ISO timestamps
  expires_at: string | null
  max_redemptions: number | null
  newsletter_welcome: boolean
  campaign: string | null       // operator-facing label
}

export function normalizePromoCode(raw: unknown): string | null
// trim, uppercase, NFKC; must match /^[A-Z0-9_-]{3,32}$/ after normalization; else null

export type PromoIneligibleReason =
  | 'not_found' | 'inactive' | 'not_started' | 'expired' | 'wrong_track' | 'exhausted'

export type PromoEligibility =
  | { ok: true; promo: PromoCode }
  | { ok: false; reason: PromoIneligibleReason }

export function checkPromoEligibility(
  promo: PromoCode | null,
  track: PromoTrack,
  redemptionCount: number,          // pending + redeemed
  now?: Date,
): PromoEligibility

export const STRIPE_MIN_MINOR: Record<'pln' | 'eur' | 'gbp', number>
// { pln: 200, eur: 50, gbp: 30 }

export function computePromoDiscountMinor(
  promo: PromoCode,
  subtotalMinor: number,
  shippingMinor: number,
  currency: 'pln' | 'eur' | 'gbp',
): number
// percent: floor(subtotalMinor * percent / 100); fixed: amount_<currency> ?? 0.
// Clamp 1: never exceeds subtotalMinor.
// Clamp 2 (Stripe minimum): d = min(d, max(0, subtotalMinor + shippingMinor
//          - STRIPE_MIN_MINOR[currency])) — the max discount is the amount by
//          which the undiscounted charge exceeds the minimum, floored at 0.
//          An undersized cart already below the minimum with d = 0 stays at 0
//          (never a negative discount, never a rejection from this function).
// Always returns an integer >= 0.

export async function fetchPromoByCode(
  supabase: SupabaseClient,        // untyped, house style
  code: string,                    // already normalized
): Promise<{ promo: PromoCode | null; redemptionCount: number }>
// select from promo_codes by code + count pending/redeemed rows from promo_redemptions.
```

---

## Task 1: Migration

- [ ] **Step 1: Write the migration** at `supabase/migrations/20260830120000_promo_codes.sql`. Follow house style: `-- ===` rationale banner; invoker-rights plpgsql; `set search_path = public, pg_temp`; revoke-then-grant like `20260813170000_harden_rpc_and_catalog.sql`. Content:

```sql
-- ============================================================================
-- Promo codes (2026-08-30)
-- App-owned promotion definitions + redemption ledger. Stripe PaymentIntents
-- do not support Stripe-native coupons, so the discount is applied to the PI
-- amount server-side; these tables are the source of truth.
-- Lifecycle: checkout claims a 'pending' redemption atomically; the Stripe
-- webhook settles it to 'redeemed' (markPaid) or 'released' (releaseHold /
-- cron expiry). Mirrors reserve_pieces / private_sales patterns.
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

revoke all on function claim_promo_redemption(uuid, uuid) from public, anon, authenticated;
revoke all on function settle_promo_redemption(uuid, text) from public, anon, authenticated;
grant execute on function claim_promo_redemption(uuid, uuid) to service_role;
grant execute on function settle_promo_redemption(uuid, text) to service_role;
```

- [ ] **Step 2: Sanity-check the SQL locally if a local Supabase stack is available** (`supabase db reset` / `supabase migration up` if configured). If no local stack exists (likely — the repo has no `supabase start` workflow), verify by careful re-read against an existing applied migration (`20260615120000_private_sales.sql`) for syntax conventions instead, and note this in the phase self-review. **Do NOT apply to the remote project.**
- [ ] **Step 3: Commit** — `git add supabase/migrations/20260830120000_promo_codes.sql && git commit -m "feat(promo): schema for promo codes, redemptions, claim/settle RPCs"`

## Task 2: Domain module (TDD)

- [ ] **Step 1: Write failing tests** in `src/lib/promo.test.ts` covering, at minimum (use the interface block above as the contract; build a `mkPromo(overrides)` helper):
  - `normalizePromoCode`: `'  welcome10 '` → `'WELCOME10'`; rejects (`null` for) empty, non-string, 2-char, 33-char, spaces inside, `zażółć`, emoji.
  - `checkPromoEligibility`: null promo → `not_found`; `active:false` → `inactive`; `starts_at` in the future → `not_started`; `expires_at` in the past → `expired`; `applies_to:'ceramics'` vs `track:'prints'` → `wrong_track` (and the `'all'` promo passes both tracks); `max_redemptions:5, redemptionCount:5` → `exhausted` (4 passes); boundary: `expires_at === now` → expired (strictly-before semantics: valid while `now < expires_at`).
  - `computePromoDiscountMinor`:
    - percent 10 on subtotal 57500 (575 zł) → 5750; floor check: 15% of 999 → 149.
    - fixed: `amount_eur: 1000` at `currency:'eur'` → 1000; clamps to subtotal when `amount > subtotal`.
    - Stripe-minimum clamp (max discount = `max(0, subtotalMinor + shippingMinor − STRIPE_MIN_MINOR[currency])`): percent 100 on subtotal 5000, shipping 0, `'pln'` → 4800 (charge = 200); percent 100 with shipping 2000 → 5000 (shipping already ≥ min, full discount stands); undersized cart already below the minimum: fixed `amount_pln: 1000` on subtotal 150, shipping 0, `'pln'` → 0 (max discount is `max(0, 150 − 200) = 0`; the discount floors at 0, never goes negative, and the function never rejects — a cart Stripe can't charge is not the promo's problem).
    - always integer, never negative.
- [ ] **Step 2: Run** `npx vitest run src/lib/promo.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement `src/lib/promo.ts`** exactly per the interface block. `fetchPromoByCode` does two queries via the injected client: `from('promo_codes').select('*').eq('code', code).maybeSingle()`, then (if found) `from('promo_redemptions').select('id', { count: 'exact', head: true }).eq('promo_id', promo.id).in('status', ['pending','redeemed'])`; cast rows inline (`as PromoCode | null`) per house style. Keep the module dependency-free apart from the Supabase client type import — everything else is pure.
- [ ] **Step 4: Run** `npx vitest run src/lib/promo.test.ts` — expect PASS. For `fetchPromoByCode`, add 2 tests with a stubbed client object (resolve found/not-found) following the stub style used in `src/lib/checkout.test.ts`.
- [ ] **Step 5: Commit** — `git commit -m "feat(promo): domain module — normalization, eligibility, discount math"` (stage the two files by path).

## Acceptance checklist (phase self-review)

- [ ] Migration is purely additive; no existing table/RPC altered beyond `orders` column adds with defaults (backward-compatible with running prod code — see master's auto-apply warning).
- [ ] RPCs match house style: invoker rights, search_path pinned, revoke/grant block present, `for update` serializes the max-redemption check.
- [ ] `claim_promo_redemption`: the promo-row lock is taken BEFORE the re-entrancy check; re-entrant for the same order+promo; can re-claim after a `released` settle (retry after failed payment on the same order); returns `false` when the order holds a live claim for a different promo; the final exists post-condition guarantees `true` ⇒ the requested promo is held.
- [ ] `settle_promo_redemption` returns whether the requested terminal state is recorded — never `true` for a missing row or a row at the other terminal state (the late-markPaid-after-expiry case must be detectable by the caller).
- [ ] Migration enforces `starts_at < expires_at` (NULL-tolerant CHECK) alongside the kind/amount checks.
- [ ] Discount math: integers only, subtotal-only, both clamps covered by tests, `STRIPE_MIN_MINOR` values `{pln:200, eur:50, gbp:30}`.
- [ ] `npm run lint && npm run typecheck && npm run test` green (modulo the known pre-existing Windows-local failures — diff against baseline).
- [ ] No route/UI/webhook files touched.
