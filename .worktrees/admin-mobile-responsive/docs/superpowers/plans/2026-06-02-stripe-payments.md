# Stripe Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the simulated checkout with real Stripe payments (cards + BLIK + Przelewy24, PLN) for one-of-a-kind ceramics, backed by Supabase for an orders ledger and atomic 1/1 inventory protection.

**Architecture:** A server route reserves the cart's pieces in Postgres (atomic, 15-min hold) *and* creates a Stripe PaymentIntent in one call; the embedded Payment Element confirms payment client-side; a Stripe webhook is the sole source of fulfillment truth — it marks pieces sold, records the order paid, and emits a no-VAT invoice. Pure logic (pricing, availability, event handling) lives in injectable `lib/` modules so it is unit-testable; routes and React components are thin adapters.

**Tech Stack:** Next.js 16 (App Router) · React 19 · TypeScript · Cloudflare Workers (OpenNext) · Supabase (Postgres 17) · Stripe (`stripe` server SDK + `@stripe/stripe-js` / `@stripe/react-stripe-js`) · Vitest · next-intl.

**Reference spec:** `docs/superpowers/specs/2026-06-02-stripe-payments-design.md`

**Known environment facts (already provisioned):**
- Stripe account: **Anna-ciok** `acct_1Qiwd0J0KFK9lrjH` (keys: https://dashboard.stripe.com/acct_1Qiwd0J0KFK9lrjH/apikeys).
- Supabase project: **ceramics** ref `wnlysejenowymjdxlnaq`, region `eu-west-1`, org `Ania-Shop` (`odicgyqdrloaxvbsexpo`). URL: `https://wnlysejenowymjdxlnaq.supabase.co`.
- Branch: `feat/stripe-payments` (already created off `main`).
- Deploy: `wrangler.jsonc` exists; `nodejs_compat` is on; secrets are set with `npx wrangler secret put NAME`.

---

## File Structure

**Create:**
- `supabase/migrations/0001_stripe_orders.sql` — schema: `piece_state`, `orders`, `order_items`, `reserve_pieces()` fn, seed.
- `src/lib/pricing.ts` — PLN price table (grosze) + `orderAmountGrosze()`. Pure.
- `src/lib/inventory.ts` — server-only: `getSoldIds()` (tag-cached), `isAvailable()`. 
- `src/lib/stripe.ts` — server-only Stripe client factory (`getStripe()`).
- `src/lib/supabase.ts` — server-only service-role client factory (`getSupabaseAdmin()`).
- `src/lib/checkout.ts` — pure helpers: `validateCart()`, reused by the route.
- `src/lib/invoice.ts` — server-only: `createOrderInvoice()` (no-VAT, paid-out-of-band, emailed).
- `src/lib/webhook.ts` — pure `handleStripeEvent(event, deps)`.
- `src/app/api/checkout/route.ts` — POST: validate → reserve → create PaymentIntent.
- `src/app/api/stripe/webhook/route.ts` — POST: verify signature → `handleStripeEvent`.
- `src/app/api/inventory/route.ts` — GET: `{ sold: string[] }` for client cart pruning.
- `src/app/[locale]/koszyk/return/page.tsx` — post-redirect status page.
- `src/components/shop/CheckoutForm.tsx` — client: `<Elements>` + `<PaymentElement>` + address/email.
- Tests: `src/lib/pricing.test.ts`, `src/lib/inventory.test.ts`, `src/lib/checkout.test.ts`, `src/lib/webhook.test.ts`.

**Modify:**
- `src/lib/format.ts` — `euro()` → `pln()`.
- `src/lib/products.ts` — PLN prices in `CATEGORIES`; drop hardcoded `SOLD`; `sold` defaults false.
- `src/lib/analytics.ts` — `ANALYTICS_CURRENCY = 'PLN'`.
- `src/components/shop/CollectionScreen.tsx` — merge `getSoldIds()` into product `sold`.
- `src/components/shop/ProductTile.tsx` — `euro` → `pln`.
- `src/components/shop/CartView.tsx` — replace simulated checkout with real flow.
- `src/app/[locale]/koszyk/page.tsx` — remove `sim-banner`.
- `messages/pl.json`, `messages/en.json`, `messages/es.json` — PLN strings + new checkout keys.
- `cloudflare-env.d.ts` — add secret bindings.
- `package.json` — new deps.
- `.gitignore` — ensure `.dev.vars` ignored.

---

## Task 1: Install dependencies

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install runtime deps**

Run:
```bash
npm install stripe @stripe/stripe-js @stripe/react-stripe-js @supabase/supabase-js
```
Expected: 4 packages added to `dependencies`; `package-lock.json` updated.

- [ ] **Step 2: Verify the lockfile uses npm 10.9.2 semantics (Cloudflare CI parity)**

Run: `npm ci --dry-run`
Expected: no errors; tree resolves.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(stripe): add stripe and supabase SDKs"
```

---

## Task 2: Supabase schema, reservation function, and seed

**Files:**
- Create: `supabase/migrations/0001_stripe_orders.sql`

This migration is applied to the `ceramics` project via the Supabase MCP `apply_migration` tool (or the SQL editor). Product ids are deterministic: `k01..k22, v01..v08, d01..d09, t01..t15, p01..p12, b01..b06, w01..w16` (88 total). The five already-sold pieces are `k04, k11, k19, v02, v06`.

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/0001_stripe_orders.sql`:
```sql
-- One-of-a-kind inventory + orders ledger for Stripe payments.

create type piece_status as enum ('available', 'reserved', 'sold');
create type order_status as enum ('pending', 'paid', 'failed', 'expired');

create table piece_state (
  product_id     text primary key,
  status         piece_status not null default 'available',
  reserved_until timestamptz,
  order_id       uuid
);

create table orders (
  id                uuid primary key default gen_random_uuid(),
  payment_intent_id text unique not null,
  status            order_status not null default 'pending',
  currency          text not null default 'pln',
  subtotal          integer not null,         -- grosze
  shipping          integer not null,         -- grosze
  total             integer not null,         -- grosze
  shipping_method   text not null,            -- 'kurier' | 'odbior'
  email             text,
  shipping_address  jsonb,
  created_at        timestamptz not null default now(),
  paid_at           timestamptz
);

create table order_items (
  order_id   uuid not null references orders(id) on delete cascade,
  product_id text not null,
  unit_price integer not null,                -- grosze
  primary key (order_id, product_id)
);

-- Atomic reservation: locks the requested rows, rejects if any is sold or
-- actively reserved, else marks them reserved until now()+ttl.
-- Returns the conflicting product_ids (empty array => success).
create or replace function reserve_pieces(
  p_ids       text[],
  p_order_id  uuid,
  p_ttl_secs  integer
) returns text[]
language plpgsql
as $$
declare
  conflicts text[];
begin
  perform 1 from piece_state where product_id = any(p_ids) for update;

  select coalesce(array_agg(product_id), '{}')
    into conflicts
  from piece_state
  where product_id = any(p_ids)
    and (status = 'sold'
         or (status = 'reserved' and reserved_until > now()));

  if array_length(conflicts, 1) is not null then
    return conflicts;
  end if;

  update piece_state
     set status = 'reserved',
         reserved_until = now() + make_interval(secs => p_ttl_secs),
         order_id = p_order_id
   where product_id = any(p_ids);

  return '{}';
end;
$$;

-- Seed all 88 pieces as available.
insert into piece_state (product_id, status)
select 'k' || lpad(g::text, 2, '0'), 'available' from generate_series(1,22) g
union all select 'v' || lpad(g::text,2,'0'),'available' from generate_series(1,8) g
union all select 'd' || lpad(g::text,2,'0'),'available' from generate_series(1,9) g
union all select 't' || lpad(g::text,2,'0'),'available' from generate_series(1,15) g
union all select 'p' || lpad(g::text,2,'0'),'available' from generate_series(1,12) g
union all select 'b' || lpad(g::text,2,'0'),'available' from generate_series(1,6) g
union all select 'w' || lpad(g::text,2,'0'),'available' from generate_series(1,16) g
on conflict (product_id) do nothing;

update piece_state set status = 'sold'
 where product_id in ('k04','k11','k19','v02','v06');

-- RLS: deny everything to anon/auth; only the service role (used server-side) bypasses RLS.
alter table piece_state enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
```

- [ ] **Step 2: Apply the migration**

Apply via Supabase MCP `apply_migration` (project_id `wnlysejenowymjdxlnaq`, name `stripe_orders`, the SQL above), or paste into the SQL editor.
Expected: success, no errors.

- [ ] **Step 3: Verify seed count and sold rows**

Run via MCP `execute_sql` (project `wnlysejenowymjdxlnaq`):
```sql
select count(*) total,
       count(*) filter (where status='sold') sold
from piece_state;
```
Expected: `total = 88`, `sold = 5`.

- [ ] **Step 4: Verify the reservation function (conflict + success paths)**

Run:
```sql
-- sold piece must conflict
select reserve_pieces(array['k04'], gen_random_uuid(), 900);   -- expect {k04}
-- available pieces succeed
select reserve_pieces(array['k01','k02'], gen_random_uuid(), 900); -- expect {}
-- now k01 is held, so a second reservation conflicts
select reserve_pieces(array['k01'], gen_random_uuid(), 900);   -- expect {k01}
-- reset test state
update piece_state set status='available', reserved_until=null, order_id=null
 where product_id in ('k01','k02');
```
Expected: results `{k04}`, `{}`, `{k01}` respectively, then reset.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0001_stripe_orders.sql
git commit -m "feat(stripe): supabase schema + atomic reserve_pieces + seed"
```

---

## Task 3: PLN pricing module (TDD)

**Files:**
- Create: `src/lib/pricing.ts`
- Test: `src/lib/pricing.test.ts`

Prices (PLN, from the spec, EUR×4.20 rounded down to nearest 5 zł). All amounts stored as **grosze** (integer) for Stripe.

| slug | PLN | grosze |
|---|---|---|
| kubki | 90 | 9000 |
| wazony | 210 | 21000 |
| wazony-duze | 395 | 39500 |
| talerzyki | 105 | 10500 |
| talerze-duze | 270 | 27000 |
| duze-michy | 315 | 31500 |
| miski-falowane | 155 | 15500 |
| shipping (kurier) | 75 | 7500 |

- [ ] **Step 1: Write the failing test**

Create `src/lib/pricing.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { PRICE_PLN, SHIPPING_PLN, toGrosze, orderAmountGrosze } from './pricing';

describe('pricing', () => {
  it('exposes PLN prices for all seven categories', () => {
    expect(PRICE_PLN.kubki).toBe(90);
    expect(PRICE_PLN['wazony-duze']).toBe(395);
    expect(SHIPPING_PLN).toBe(75);
  });

  it('converts zloty to grosze', () => {
    expect(toGrosze(90)).toBe(9000);
    expect(toGrosze(0)).toBe(0);
  });

  it('sums item grosze plus courier shipping', () => {
    const amount = orderAmountGrosze([9000, 21000], 'kurier');
    expect(amount).toBe(9000 + 21000 + 7500);
  });

  it('charges no shipping for pickup', () => {
    expect(orderAmountGrosze([9000], 'odbior')).toBe(9000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/pricing.test.ts`
Expected: FAIL — cannot find module `./pricing`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/pricing.ts`:
```ts
/* PLN prices (zloty) and grosze helpers. PLN is the charge currency. */
import type { CategorySlug } from './types';

export const PRICE_PLN: Record<CategorySlug, number> = {
  kubki: 90,
  wazony: 210,
  'wazony-duze': 395,
  talerzyki: 105,
  'talerze-duze': 270,
  'duze-michy': 315,
  'miski-falowane': 155,
};

export const SHIPPING_PLN = 75;

export type ShipMethod = 'kurier' | 'odbior';

/** Zloty (integer) → grosze. Prices have no fractional zloty, so this is ×100. */
export function toGrosze(zloty: number): number {
  return Math.round(zloty * 100);
}

/** Sum item amounts (grosze) plus shipping for the chosen method. */
export function orderAmountGrosze(itemGrosze: number[], method: ShipMethod): number {
  const items = itemGrosze.reduce((s, g) => s + g, 0);
  const shipping = method === 'odbior' ? 0 : toGrosze(SHIPPING_PLN);
  return items + shipping;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/pricing.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pricing.ts src/lib/pricing.test.ts
git commit -m "feat(stripe): PLN pricing module in grosze"
```

---

## Task 4: Reprice catalog, formatter, analytics, and i18n to PLN

**Files:**
- Modify: `src/lib/format.ts`, `src/lib/products.ts`, `src/lib/analytics.ts`, `src/components/shop/ProductTile.tsx`
- Modify: `messages/pl.json`, `messages/en.json`, `messages/es.json`

- [ ] **Step 1: Replace the EUR formatter with PLN**

In `src/lib/format.ts`, replace the whole file with:
```ts
/** Format a PLN amount the brand way: amount then unit — "90 zł". */
export const pln = (n: number): string => `${n} zł`;
```

- [ ] **Step 2: Update catalog prices and drop the hardcoded SOLD set**

In `src/lib/products.ts`:
- Add at top, after the type import: `import { PRICE_PLN } from './pricing';`
- In `CATEGORIES`, change each `price:` to the PLN value: `kubki` 90, `wazony` 210, `wazony-duze` 395, `talerzyki` 105, `talerze-duze` 270, `duze-michy` 315, `miski-falowane` 155. (Equivalently set `price: PRICE_PLN[slug]` per entry.)
- Delete the line `const SOLD = new Set(['k04', 'k11', 'k19', 'v02', 'v06']);`
- In `buildProducts()`, change `sold: SOLD.has(id),` to `sold: false,` (DB is now the source of truth; collection rendering overlays it — Task 8).

- [ ] **Step 3: Switch analytics currency to PLN**

In `src/lib/analytics.ts`, change line 4 to:
```ts
export const ANALYTICS_CURRENCY = 'PLN';
```

- [ ] **Step 4: Update ProductTile to the PLN formatter**

In `src/components/shop/ProductTile.tsx`:
- Change the import `import { euro } from '@/lib/format';` to `import { pln } from '@/lib/format';`
- Change `<span className="pr">{euro(product.price)}</span>` to `<span className="pr">{pln(product.price)}</span>`

- [ ] **Step 5: Update i18n price strings (all three locales)**

In `messages/pl.json`, set:
- `ship.courierPrice` → `"75 zł"`
- `home.card.mug.num` → `"22 prace · 90 zł każda"`, `vase.num` → `"8 prac · 210 zł każdy"`, `bigvase.num` → `"9 prac · 395 zł każdy"`, `dish.num` → `"15 prac · 105 zł każdy"`, `plate.num` → `"12 prac · 270 zł każdy"`, `largebowl.num` → `"6 prac · 315 zł każda"`, `wavybowl.num` → `"16 prac · 155 zł każda"`
- `collection.kubki.lead` → replace `€ 22` with `90 zł`; `wazony.lead` `€ 50`→`210 zł`; `wazony-duze.lead` `€ 95`→`395 zł`; `talerzyki.lead` `€ 25`→`105 zł`; `talerze-duze.lead` `€ 65`→`270 zł`; `duze-michy.lead` `€ 75`→`315 zł`; `miski-falowane.lead` `€ 38`→`155 zł`
- `shipping.s1P` `€ 18`→`75 zł`; `shipping.s1Li1` `€ 18`→`75 zł`; `shipping.s1Li2` keep "gratis"
- `terms.s3P` — change `"Wszystkie ceny podane są w euro..."` to `"Wszystkie ceny podane są w złotych polskich (PLN)..."`

Do the equivalent replacements in `messages/en.json` and `messages/es.json` (find every `€ <n>` token and the matching localized price, replace with the PLN value + `zł`). Verify no `€` remains:
```bash
git grep -n "€" -- messages/ src/ ; echo "exit: $?"
```
Expected: no matches (`exit: 1` from grep).

- [ ] **Step 6: Run the full test + lint to catch type breaks**

Run: `npx vitest run && npm run lint`
Expected: tests PASS (existing `products.test.ts` / `analytics.test.ts` may assert prices/currency — if they reference `22`/`EUR`, update those expectations to the PLN values/`PLN` in the same commit).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(stripe): reprice catalog and copy to PLN"
```

---

## Task 5: Server clients (Stripe + Supabase) and env bindings

**Files:**
- Create: `src/lib/stripe.ts`, `src/lib/supabase.ts`
- Modify: `cloudflare-env.d.ts`
- Create: `.dev.vars` (gitignored), `.env.local` (gitignored)

Secrets are read at request time via OpenNext's `getCloudflareContext()` so module import never touches missing env. The publishable key is a build-time public var (`NEXT_PUBLIC_*`).

- [ ] **Step 1: Declare the bindings**

Replace `cloudflare-env.d.ts` contents:
```ts
/* eslint-disable */
// Workers bindings from wrangler.jsonc + secrets. After changing bindings, run `npm run cf-typegen`.

interface CloudflareEnv {
  ASSETS: Fetcher;
  WORKER_SELF_REFERENCE: Service<typeof import('./.open-next/worker').default>;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

declare namespace Cloudflare {
  interface Env extends CloudflareEnv {}
}
```

- [ ] **Step 2: Write the Stripe client factory**

Create `src/lib/stripe.ts`:
```ts
import Stripe from 'stripe';
import { getCloudflareContext } from '@opennextjs/cloudflare';

/**
 * Server-only Stripe client. Created per request so it reads the current
 * Workers env. Uses the fetch HTTP client (Workers has no Node http) and the
 * account-default API version (omit the literal to avoid SDK type drift).
 */
export function getStripe(): Stripe {
  const { env } = getCloudflareContext();
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}
```

- [ ] **Step 3: Write the Supabase admin client factory**

Create `src/lib/supabase.ts`:
```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getCloudflareContext } from '@opennextjs/cloudflare';

/** Server-only Supabase client using the service-role key (bypasses RLS). */
export function getSupabaseAdmin(): SupabaseClient {
  const { env } = getCloudflareContext();
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}
```

- [ ] **Step 4: Create local dev secret files**

Create `.dev.vars` (used by `next dev` through OpenNext):
```
STRIPE_SECRET_KEY=sk_test_REPLACE_WITH_TEST_KEY
STRIPE_WEBHOOK_SECRET=whsec_REPLACE_AFTER_stripe_listen
SUPABASE_URL=https://wnlysejenowymjdxlnaq.supabase.co
SUPABASE_SERVICE_ROLE_KEY=REPLACE_WITH_SERVICE_ROLE_KEY
```
Create `.env.local`:
```
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_REPLACE_WITH_TEST_KEY
```
Fetch real **test-mode** values from the Stripe keys page (link above) and the Supabase project API settings (service-role key: project settings → API). Ensure `.gitignore` contains `.dev.vars` and `.env*.local` (add them if missing).

- [ ] **Step 5: Verify the build picks up the types**

Run: `npx tsc --noEmit`
Expected: no type errors from `src/lib/stripe.ts` / `src/lib/supabase.ts`.

- [ ] **Step 6: Commit (no secrets)**

```bash
git add src/lib/stripe.ts src/lib/supabase.ts cloudflare-env.d.ts .gitignore
git status   # confirm .dev.vars / .env.local are NOT staged
git commit -m "feat(stripe): server stripe + supabase clients and env bindings"
```

---

## Task 6: Cart validation helper (TDD)

**Files:**
- Create: `src/lib/checkout.ts`
- Test: `src/lib/checkout.test.ts`

Pure logic the route reuses: given raw cart ids, resolve them to known products and compute per-item grosze. Unknown/sold-by-catalog filtering already exists via `resolveCartProducts`, but the route must defend against empty/oversized/garbage input before hitting Stripe.

- [ ] **Step 1: Write the failing test**

Create `src/lib/checkout.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { validateCart, MAX_CART } from './checkout';

describe('validateCart', () => {
  it('maps known ids to products with grosze prices', () => {
    const r = validateCart(['k01', 'v01']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items.map((i) => i.product_id)).toEqual(['k01', 'v01']);
      expect(r.items[0].unit_price).toBe(9000);   // kubki 90 zł
      expect(r.items[1].unit_price).toBe(21000);  // wazony 210 zł
    }
  });

  it('rejects an empty cart', () => {
    expect(validateCart([]).ok).toBe(false);
  });

  it('rejects unknown ids', () => {
    expect(validateCart(['nope']).ok).toBe(false);
  });

  it('dedupes repeated ids (1/1 — one each)', () => {
    const r = validateCart(['k01', 'k01']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items).toHaveLength(1);
  });

  it('rejects carts above MAX_CART', () => {
    const many = Array.from({ length: MAX_CART + 1 }, (_, i) => `x${i}`);
    expect(validateCart(many).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/checkout.test.ts`
Expected: FAIL — cannot find module `./checkout`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/checkout.ts`:
```ts
import { getProductById } from './products';
import { toGrosze } from './pricing';

export const MAX_CART = 88; // total catalog size — a hard sanity bound.

export type CheckoutItem = { product_id: string; unit_price: number };
export type ValidateResult =
  | { ok: true; items: CheckoutItem[] }
  | { ok: false; reason: 'empty' | 'too_many' | 'unknown' };

/** Resolve raw cart ids to deduped, catalog-known items with grosze prices. */
export function validateCart(rawIds: unknown): ValidateResult {
  if (!Array.isArray(rawIds) || rawIds.length === 0) return { ok: false, reason: 'empty' };
  if (rawIds.length > MAX_CART) return { ok: false, reason: 'too_many' };

  const seen = new Set<string>();
  const items: CheckoutItem[] = [];
  for (const id of rawIds) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    const product = getProductById(id);
    if (!product) return { ok: false, reason: 'unknown' };
    seen.add(id);
    items.push({ product_id: id, unit_price: toGrosze(product.price) });
  }
  if (items.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, items };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/checkout.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/checkout.ts src/lib/checkout.test.ts
git commit -m "feat(stripe): cart validation helper"
```

---

## Task 7: Inventory read module + tag-cached sold ids

**Files:**
- Create: `src/lib/inventory.ts`
- Test: `src/lib/inventory.test.ts`

`getSoldIds()` is wrapped in Next's tag-cached layer so collection pages stay near-static; the webhook calls `revalidateTag('inventory')` when a piece sells. The pure `isAvailable()` rule is unit-tested.

- [ ] **Step 1: Write the failing test**

Create `src/lib/inventory.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { isAvailable } from './inventory';

describe('isAvailable', () => {
  const now = new Date('2026-06-02T12:00:00Z');
  it('available when status available', () => {
    expect(isAvailable({ status: 'available', reserved_until: null }, now)).toBe(true);
  });
  it('unavailable when sold', () => {
    expect(isAvailable({ status: 'sold', reserved_until: null }, now)).toBe(false);
  });
  it('unavailable while reservation is live', () => {
    expect(isAvailable({ status: 'reserved', reserved_until: '2026-06-02T12:10:00Z' }, now)).toBe(false);
  });
  it('available again once the hold expires', () => {
    expect(isAvailable({ status: 'reserved', reserved_until: '2026-06-02T11:50:00Z' }, now)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/inventory.test.ts`
Expected: FAIL — cannot find module `./inventory`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/inventory.ts`:
```ts
import { unstable_cache } from 'next/cache';
import { getSupabaseAdmin } from './supabase';

export type PieceRow = {
  status: 'available' | 'reserved' | 'sold';
  reserved_until: string | null;
};

/** Pure availability rule: not sold AND (no live hold). */
export function isAvailable(row: PieceRow, now: Date): boolean {
  if (row.status === 'sold') return false;
  if (row.status === 'reserved' && row.reserved_until && new Date(row.reserved_until) > now) {
    return false;
  }
  return true;
}

/**
 * Sold product ids, cached under the `inventory` tag. The Stripe webhook calls
 * revalidateTag('inventory') on a sale so collection pages refresh promptly
 * while otherwise serving cached, fast responses.
 */
export const getSoldIds = unstable_cache(
  async (): Promise<string[]> => {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('piece_state')
      .select('product_id')
      .eq('status', 'sold');
    if (error) throw error;
    return (data ?? []).map((r) => r.product_id as string);
  },
  ['sold-ids'],
  { tags: ['inventory'], revalidate: 300 },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/inventory.test.ts`
Expected: PASS (4 tests). (`getSoldIds` is not exercised in unit tests — it needs the Workers/Supabase runtime.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventory.ts src/lib/inventory.test.ts
git commit -m "feat(stripe): inventory availability rule + tag-cached sold ids"
```

---

## Task 8: Reflect sold state on collection pages + public inventory endpoint

**Files:**
- Modify: `src/components/shop/CollectionScreen.tsx`
- Create: `src/app/api/inventory/route.ts`

- [ ] **Step 1: Overlay DB sold state in CollectionScreen**

In `src/components/shop/CollectionScreen.tsx`:
- Add import: `import { getSoldIds } from '@/lib/inventory';`
- Replace `const products = getProductsByCategory(slug);` with:
```ts
  const [base, soldIds] = await Promise.all([
    Promise.resolve(getProductsByCategory(slug)),
    getSoldIds(),
  ]);
  const sold = new Set(soldIds);
  const products = base.map((p) => (sold.has(p.id) ? { ...p, sold: true } : p));
```
This keeps `ProductTile`'s existing `product.sold` rendering working, now driven by Supabase.

- [ ] **Step 2: Add the public inventory endpoint for client cart pruning**

Create `src/app/api/inventory/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { getSoldIds } from '@/lib/inventory';

export const dynamic = 'force-dynamic';

export async function GET() {
  const sold = await getSoldIds();
  return NextResponse.json(
    { sold },
    { headers: { 'Cache-Control': 'public, max-age=30' } },
  );
}
```

- [ ] **Step 3: Verify the production build compiles the route + page**

Run: `npm run build`
Expected: build succeeds; `/api/inventory` listed as a route; collection routes still build.

- [ ] **Step 4: Commit**

```bash
git add src/components/shop/CollectionScreen.tsx src/app/api/inventory/route.ts
git commit -m "feat(stripe): reflect supabase sold state on collection pages + inventory API"
```

---

## Task 9: Checkout route — validate, reserve, create PaymentIntent

**Files:**
- Create: `src/app/api/checkout/route.ts`

The single server call that reserves the cart's pieces (atomic, 15-min hold = 900s) and creates the PaymentIntent. On reservation conflict, returns **409** with the sold-out ids so the client can prune. Uses `automatic_payment_methods` so cards/BLIK/P24 (enabled in the Dashboard) appear in the Payment Element; the Element renders the P24 ToS consent itself.

- [ ] **Step 1: Write the route**

Create `src/app/api/checkout/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { getSupabaseAdmin } from '@/lib/supabase';
import { validateCart } from '@/lib/checkout';
import { orderAmountGrosze, type ShipMethod } from '@/lib/pricing';

export const dynamic = 'force-dynamic';

const RESERVE_TTL_SECS = 900; // 15-minute hold

export async function POST(req: Request) {
  let body: { ids?: unknown; shipping_method?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const valid = validateCart(body.ids);
  if (!valid.ok) return NextResponse.json({ error: valid.reason }, { status: 400 });

  const method: ShipMethod = body.shipping_method === 'odbior' ? 'odbior' : 'kurier';
  const amount = orderAmountGrosze(valid.items.map((i) => i.unit_price), method);
  const ids = valid.items.map((i) => i.product_id);

  const supabase = getSupabaseAdmin();
  const orderId = crypto.randomUUID();

  // Reserve atomically BEFORE creating the PaymentIntent.
  const { data: conflicts, error: reserveErr } = await supabase.rpc('reserve_pieces', {
    p_ids: ids,
    p_order_id: orderId,
    p_ttl_secs: RESERVE_TTL_SECS,
  });
  if (reserveErr) return NextResponse.json({ error: 'reserve_failed' }, { status: 500 });
  if (Array.isArray(conflicts) && conflicts.length > 0) {
    return NextResponse.json({ error: 'unavailable', sold: conflicts }, { status: 409 });
  }

  const stripe = getStripe();
  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'pln',
      automatic_payment_methods: { enabled: true },
      metadata: { order_id: orderId, product_ids: ids.join(','), shipping_method: method },
    });
  } catch {
    // Release the hold if Stripe failed, so pieces don't get stuck reserved.
    await supabase.rpc('reserve_pieces', { p_ids: [], p_order_id: orderId, p_ttl_secs: 0 });
    await supabase.from('piece_state').update({ status: 'available', reserved_until: null, order_id: null })
      .eq('order_id', orderId);
    return NextResponse.json({ error: 'stripe_failed' }, { status: 502 });
  }

  const subtotal = valid.items.reduce((s, i) => s + i.unit_price, 0);
  await supabase.from('orders').insert({
    id: orderId,
    payment_intent_id: paymentIntent.id,
    status: 'pending',
    currency: 'pln',
    subtotal,
    shipping: amount - subtotal,
    total: amount,
    shipping_method: method,
  });
  await supabase.from('order_items').insert(
    valid.items.map((i) => ({ order_id: orderId, product_id: i.product_id, unit_price: i.unit_price })),
  );

  return NextResponse.json({ client_secret: paymentIntent.client_secret });
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/checkout/route.ts
git commit -m "feat(stripe): /api/checkout reserve + create PaymentIntent"
```

---

## Task 10: Webhook event handler (TDD, pure) + invoice module

**Files:**
- Create: `src/lib/webhook.ts`, `src/lib/invoice.ts`
- Test: `src/lib/webhook.test.ts`

`handleStripeEvent` is pure over injected deps (`markPaid`, `releaseHold`, `createInvoice`, `revalidate`) so it is fully unit-testable and idempotent.

- [ ] **Step 1: Write the failing test**

Create `src/lib/webhook.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { handleStripeEvent, type WebhookDeps } from './webhook';

function deps(overrides: Partial<WebhookDeps> = {}): WebhookDeps {
  return {
    markPaid: vi.fn().mockResolvedValue(true),
    releaseHold: vi.fn().mockResolvedValue(undefined),
    createInvoice: vi.fn().mockResolvedValue(undefined),
    revalidate: vi.fn(),
    ...overrides,
  };
}

const pi = (id = 'pi_1') => ({ id, object: 'payment_intent' });

describe('handleStripeEvent', () => {
  it('on success: marks paid, invoices, revalidates', async () => {
    const d = deps();
    await handleStripeEvent({ type: 'payment_intent.succeeded', data: { object: pi() } } as any, d);
    expect(d.markPaid).toHaveBeenCalledWith('pi_1');
    expect(d.createInvoice).toHaveBeenCalledWith('pi_1');
    expect(d.revalidate).toHaveBeenCalledWith('inventory');
  });

  it('is idempotent: skips invoice when order was already paid', async () => {
    const d = deps({ markPaid: vi.fn().mockResolvedValue(false) });
    await handleStripeEvent({ type: 'payment_intent.succeeded', data: { object: pi() } } as any, d);
    expect(d.createInvoice).not.toHaveBeenCalled();
  });

  it('on failure: releases the hold', async () => {
    const d = deps();
    await handleStripeEvent({ type: 'payment_intent.payment_failed', data: { object: pi('pi_2') } } as any, d);
    expect(d.releaseHold).toHaveBeenCalledWith('pi_2');
  });

  it('ignores unrelated event types', async () => {
    const d = deps();
    await handleStripeEvent({ type: 'charge.updated', data: { object: {} } } as any, d);
    expect(d.markPaid).not.toHaveBeenCalled();
    expect(d.releaseHold).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/webhook.test.ts`
Expected: FAIL — cannot find module `./webhook`.

- [ ] **Step 3: Write the handler**

Create `src/lib/webhook.ts`:
```ts
import type Stripe from 'stripe';

export type WebhookDeps = {
  /** Flip order pending→paid and pieces reserved→sold. Returns false if already paid (idempotent no-op). */
  markPaid: (paymentIntentId: string) => Promise<boolean>;
  /** Return reserved pieces to available for a failed/canceled intent. */
  releaseHold: (paymentIntentId: string) => Promise<void>;
  /** Generate + send the no-VAT invoice for a freshly-paid order. */
  createInvoice: (paymentIntentId: string) => Promise<void>;
  /** Bust a Next cache tag (e.g. 'inventory'). */
  revalidate: (tag: string) => void;
};

export async function handleStripeEvent(event: Stripe.Event, deps: WebhookDeps): Promise<void> {
  const pi = event.data.object as Stripe.PaymentIntent;
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const firstTime = await deps.markPaid(pi.id);
      if (firstTime) {
        await deps.createInvoice(pi.id);
        deps.revalidate('inventory');
      }
      return;
    }
    case 'payment_intent.payment_failed':
    case 'payment_intent.canceled': {
      await deps.releaseHold(pi.id);
      deps.revalidate('inventory');
      return;
    }
    default:
      return;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/webhook.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the invoice module**

Create `src/lib/invoice.ts`. The charge already happened via the PaymentIntent, so the invoice is a **document**: create a Customer, add full-price line items (no tax), finalize, mark **paid out-of-band**, and email it.
```ts
import type Stripe from 'stripe';
import { getStripe } from './stripe';
import { getSupabaseAdmin } from './supabase';
import { getProductById, CATEGORIES } from './products';

/** Build a no-VAT invoice for a paid order and email it via Stripe. */
export async function createOrderInvoice(paymentIntentId: string): Promise<void> {
  const stripe = getStripe();
  const supabase = getSupabaseAdmin();

  const { data: order } = await supabase
    .from('orders').select('*').eq('payment_intent_id', paymentIntentId).single();
  if (!order || !order.email) return; // no email collected → nothing to send

  const { data: items } = await supabase
    .from('order_items').select('*').eq('order_id', order.id);
  if (!items || items.length === 0) return;

  const customer = await stripe.customers.create({
    email: order.email,
    shipping: order.shipping_address ?? undefined,
    preferred_locales: ['pl'],
  });

  for (const it of items) {
    const product = getProductById(it.product_id);
    const label = product
      ? `${CATEGORIES[product.category].singularKey} Nº ${product.num}`
      : it.product_id;
    await stripe.invoiceItems.create({
      customer: customer.id,
      amount: it.unit_price,
      currency: 'pln',
      description: label,
    });
  }
  if (order.shipping > 0) {
    await stripe.invoiceItems.create({
      customer: customer.id, amount: order.shipping, currency: 'pln', description: 'Wysyłka kurierem',
    });
  }

  const invoice = await stripe.invoices.create({
    customer: customer.id,
    collection_method: 'charge_automatically',
    auto_advance: false,
    metadata: { payment_intent_id: paymentIntentId, order_id: order.id },
  });
  const finalized = await stripe.invoices.finalizeInvoice(invoice.id as string);
  // Goods already paid via the PaymentIntent → record paid without charging again.
  await stripe.invoices.pay(finalized.id as string, { paid_out_of_band: true } as Stripe.InvoicePayParams);
  await stripe.invoices.sendInvoice(finalized.id as string);
}
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (If `paid_out_of_band` typing complains, the cast keeps it valid; this exact call sequence is verified live in Task 13.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/webhook.ts src/lib/webhook.test.ts src/lib/invoice.ts
git commit -m "feat(stripe): webhook handler (pure) + no-VAT invoice module"
```

---

## Task 11: Webhook route — signature verification + DB mutations

**Files:**
- Create: `src/app/api/stripe/webhook/route.ts`

Verifies the signature with `constructEventAsync` (Workers-safe), then wires `handleStripeEvent` to real Supabase mutations. `markPaid` is idempotent via a conditional update that only matches a still-`pending` order.

- [ ] **Step 1: Write the route**

Create `src/app/api/stripe/webhook/route.ts`:
```ts
import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getStripe } from '@/lib/stripe';
import { getSupabaseAdmin } from '@/lib/supabase';
import { handleStripeEvent } from '@/lib/webhook';
import { createOrderInvoice } from '@/lib/invoice';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const sig = req.headers.get('stripe-signature');
  if (!sig) return NextResponse.json({ error: 'no_signature' }, { status: 400 });

  const body = await req.text();
  const stripe = getStripe();
  const { env } = getCloudflareContext();

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return NextResponse.json({ error: 'bad_signature' }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  await handleStripeEvent(event, {
    markPaid: async (pi) => {
      // Only the first 'pending'→'paid' transition returns a row (idempotency).
      const { data } = await supabase
        .from('orders')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('payment_intent_id', pi)
        .eq('status', 'pending')
        .select('id');
      if (!data || data.length === 0) return false;
      const orderId = data[0].id;
      await supabase
        .from('piece_state')
        .update({ status: 'sold', reserved_until: null })
        .eq('order_id', orderId);
      return true;
    },
    releaseHold: async (pi) => {
      const { data } = await supabase
        .from('orders')
        .update({ status: 'failed' })
        .eq('payment_intent_id', pi)
        .eq('status', 'pending')
        .select('id');
      if (data && data.length > 0) {
        await supabase
          .from('piece_state')
          .update({ status: 'available', reserved_until: null, order_id: null })
          .eq('order_id', data[0].id);
      }
    },
    createInvoice: (pi) => createOrderInvoice(pi),
    revalidate: (tag) => revalidateTag(tag),
  });

  return NextResponse.json({ received: true });
}
```

- [ ] **Step 2: Type-check + build**

Run: `npx tsc --noEmit && npm run build`
Expected: build succeeds; `/api/stripe/webhook` and `/api/checkout` both appear as routes.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/stripe/webhook/route.ts
git commit -m "feat(stripe): webhook route with signature verify + idempotent fulfillment"
```

---

## Task 12: Checkout UI — Payment Element, address, return page

**Files:**
- Create: `src/components/shop/CheckoutForm.tsx`, `src/app/[locale]/koszyk/return/page.tsx`
- Modify: `src/components/shop/CartView.tsx`, `src/app/[locale]/koszyk/page.tsx`
- Modify: `messages/pl.json`, `messages/en.json`, `messages/es.json`

- [ ] **Step 1: Add i18n keys for the real checkout (all locales)**

In `messages/pl.json` `cart`, replace `fineprint` and `simBanner` and add keys:
```json
"checkout": "Przejdź do płatności",
"pay": "Zapłać teraz",
"payProcessing": "Przetwarzanie…",
"soldOut": "Niektóre prace zostały właśnie sprzedane i usunęliśmy je z koszyka.",
"payError": "Płatność nie powiodła się. Spróbuj ponownie.",
"fineprint": "Płatność obsługuje bezpiecznie Stripe — karta, BLIK lub Przelewy24."
```
Remove the `cart.simBanner` key. Update `confirm.*` is no longer used by the new return page (leave or delete). Add a `return` namespace:
```json
"return": {
  "okH": "Dziękuję — <em>zamówienie przyjęte.</em>",
  "okP": "Płatność się powiodła. Potwierdzenie i fakturę wysłaliśmy mailem.",
  "processingH": "Płatność w toku…",
  "processingP": "Czekamy na potwierdzenie z banku. Możesz odświeżyć tę stronę za chwilę.",
  "failH": "Płatność nie powiodła się",
  "failP": "Nie pobraliśmy żadnych środków. Wróć do koszyka i spróbuj ponownie.",
  "back": "Wróć na stronę główną",
  "cart": "Wróć do koszyka"
}
```
Add equivalent translations in `en.json` and `es.json`.

- [ ] **Step 2: Build the CheckoutForm client component**

Create `src/components/shop/CheckoutForm.tsx`:
```tsx
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  PaymentElement,
  AddressElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';

export function CheckoutForm({ returnUrl }: { returnUrl: string }) {
  const t = useTranslations('cart');
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
    });
    // Reached only if confirmation fails immediately (e.g. card validation);
    // redirect-based methods (BLIK/P24) navigate away on success.
    if (error) {
      setError(error.message ?? t('payError'));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="pay-form">
      <AddressElement options={{ mode: 'shipping', fields: { phone: 'auto' } }} />
      <PaymentElement />
      {error && <p className="pay-error">{error}</p>}
      <button className="btn btn-primary" type="submit" disabled={!stripe || submitting}>
        {submitting ? t('payProcessing') : t('pay')}
      </button>
    </form>
  );
}
```

- [ ] **Step 3: Rewrite CartView's checkout to mount the Payment Element**

In `src/components/shop/CartView.tsx`:
- Add imports at top:
```tsx
import { loadStripe } from '@stripe/stripe-js';
import { Elements } from '@stripe/react-stripe-js';
import { CheckoutForm } from './CheckoutForm';
```
- After the imports, add a module-level singleton:
```tsx
const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);
```
- Remove the simulation: delete the `ConfirmState` interface, the `confirm` state, the `orderNo` state, the "Clear cart once on confirmation mount" effect, the entire `if (confirm !== null) { … }` confirmation block, and the `buildPurchaseEvent` import/usage. (The `purchase` event now fires on the return page — Step 5.)
- Add checkout state and a real handler:
```tsx
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  async function handleCheckout() {
    if (products.length === 0) return;
    setCheckoutError(null);
    pushDataLayer(
      buildBeginCheckoutEvent(products, { shippingCost: shipCost, shippingMethod: ship }),
    );
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: products.map((p) => p.id), shipping_method: ship }),
    });
    if (res.status === 409) {
      const { sold } = (await res.json()) as { sold: string[] };
      sold.forEach((id) => remove(id));
      setCheckoutError(t('cart.soldOut'));
      return;
    }
    if (!res.ok) {
      setCheckoutError(t('cart.payError'));
      return;
    }
    const { client_secret } = (await res.json()) as { client_secret: string };
    setClientSecret(client_secret);
  }
```
- In the summary `<aside>`, when `clientSecret` is set, render the Elements provider instead of the checkout button:
```tsx
        {clientSecret ? (
          <Elements stripe={stripePromise} options={{ clientSecret, locale: 'pl' }}>
            <CheckoutForm returnUrl={`${typeof window !== 'undefined' ? window.location.origin : ''}/koszyk/return`} />
          </Elements>
        ) : (
          <button className="btn btn-primary" id="checkout" onClick={handleCheckout}>
            {t('cart.checkout')} <Icon name="arrow" />
          </button>
        )}
        {checkoutError && <p className="pay-error">{checkoutError}</p>}
```
- Keep the existing `buildViewCartEvent` effect and the `pln` summary rendering. Change the summary's `euro(...)` calls to `pln(...)` (import `pln` from `@/lib/format`, drop `euro`).
- On mount, prune sold items from the cart:
```tsx
  useEffect(() => {
    fetch('/api/inventory')
      .then((r) => r.json())
      .then(({ sold }: { sold: string[] }) => sold.forEach((id) => { if (ids.includes(id)) remove(id); }))
      .catch(() => {});
    // run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 4: Remove the simulation banner from the cart page**

In `src/app/[locale]/koszyk/page.tsx`, delete the `<div className="sim-banner">…</div>` block and the now-unused `Icon` import / `t` if it becomes unused (keep `t` only if still referenced).

- [ ] **Step 5: Build the return/status page**

Create `src/app/[locale]/koszyk/return/page.tsx` as a client component that reads `payment_intent_client_secret` from the URL, retrieves the PaymentIntent status, clears the cart + fires the `purchase` analytics event on success:
```tsx
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { loadStripe } from '@stripe/stripe-js';
import { useCart } from '@/store/cart';
import { Link } from '@/i18n/navigation';
import { Icon } from '@/components/ui/Icon';
import { richTags } from '@/components/ui/richTags';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);
type Status = 'loading' | 'ok' | 'processing' | 'fail';

export default function ReturnPage() {
  const t = useTranslations('return');
  const clear = useCart((s) => s.clear);
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    const secret = new URLSearchParams(window.location.search).get('payment_intent_client_secret');
    if (!secret) { setStatus('fail'); return; }
    stripePromise.then(async (stripe) => {
      if (!stripe) { setStatus('fail'); return; }
      const { paymentIntent } = await stripe.retrievePaymentIntent(secret);
      switch (paymentIntent?.status) {
        case 'succeeded': clear(); setStatus('ok'); break;
        case 'processing': setStatus('processing'); break;
        default: setStatus('fail');
      }
    });
  }, [clear]);

  if (status === 'loading') return <main id="cart-root" />;
  const key = status === 'ok' ? 'ok' : status === 'processing' ? 'processing' : 'fail';
  return (
    <main id="cart-root">
      <div className="confirm">
        {status === 'ok' && <div className="seal"><Icon name="check" /></div>}
        <h1>{t.rich(`${key}H`, richTags)}</h1>
        <p>{t(`${key}P`)}</p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link href="/" className="btn btn-primary">{t('back')} <Icon name="arrow" /></Link>
          <Link href="/koszyk" className="btn btn-ghost">{t('cart')}</Link>
        </div>
      </div>
    </main>
  );
}
```
> Note: the authoritative `purchase` record is the webhook; this page's success state is for UX. If you want the GTM `purchase` event, fire `buildPurchaseEvent` here using the cart snapshot captured before `clear()`, guarded so it fires once per `payment_intent`.

- [ ] **Step 6: Build to verify everything compiles**

Run: `npm run build`
Expected: build succeeds; `/koszyk/return` route present; no type errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(stripe): embedded Payment Element checkout + return status page"
```

---

## Task 13: Wire secrets, enable methods, and verify end-to-end in test mode

**Files:** none (configuration + manual verification)

- [ ] **Step 1: Enable payment methods in the Stripe Dashboard (test mode)**

At https://dashboard.stripe.com/test/settings/payment_methods enable **Cards**, **BLIK**, **Przelewy24** for the Anna-ciok account. Confirm the account's default/presentment currency supports PLN.

- [ ] **Step 2: Set production secrets on the Worker**

Run (paste test keys when prompted; switch to live keys at go-live):
```bash
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```
Expected: each reports "Success!".

- [ ] **Step 3: Start the dev server + Stripe CLI listener**

In one terminal: `npm run dev`
In another: `stripe listen --forward-to localhost:3000/api/stripe/webhook`
Copy the `whsec_…` it prints into `.dev.vars` as `STRIPE_WEBHOOK_SECRET`, then restart `npm run dev`.

- [ ] **Step 4: Card happy path**

Add a piece to the cart, go to `/koszyk`, click checkout, fill the Address Element, pay with test card `4242 4242 4242 4242` (any future expiry/CVC). 
Verify:
- redirect to `/koszyk/return` shows the success state and clears the cart;
- `stripe listen` shows `payment_intent.succeeded` → your webhook returns 200;
- in Supabase (`execute_sql`): the order row is `paid`, its `order_items` exist, and the bought piece's `piece_state.status = 'sold'`;
- a finalized invoice appears in the Stripe Dashboard (test) and an invoice email is sent to the address used.

- [ ] **Step 5: BLIK + P24 paths**

Repeat with BLIK (test code `777666` authorizes; see Stripe BLIK test docs) and Przelewy24 (choose any bank → "Complete test payment"). Confirm fulfillment is driven by the webhook after redirect, and the piece becomes `sold`.

- [ ] **Step 6: Double-sale / conflict path**

In two browser windows, add the *same* piece to both carts and start checkout in both. The second `/api/checkout` must return **409**; that window shows the "sold out" message and prunes the item. Confirm only one order can ever reach `paid` for that piece.

- [ ] **Step 7: Reservation expiry**

Start a checkout (reserves the piece) but do not pay. In Supabase, confirm `piece_state.status='reserved'` with `reserved_until ≈ now()+15min`. After expiry, re-running `/api/checkout` for that piece succeeds (the lazy availability rule frees it). Optionally fast-forward by setting `reserved_until` to a past time via `execute_sql`.

- [ ] **Step 8: Verify collection page reflects a sale**

After a successful purchase, load that piece's collection page. It shows as sold (the webhook's `revalidateTag('inventory')` refreshed the cached `getSoldIds`). 

- [ ] **Step 9: Document the verification outcome**

Record pass/fail for each path in the PR description. If invoice-emailing behaves differently than coded (the `paid_out_of_band` → `sendInvoice` sequence), adjust `src/lib/invoice.ts` and re-verify Step 4.

---

## Task 14: Final regression + open PR

**Files:** none

- [ ] **Step 1: Full test + lint + build**

Run: `npx vitest run && npm run lint && npm run build`
Expected: all green.

- [ ] **Step 2: Confirm no secrets committed**

Run: `git grep -nE "sk_(test|live)_|whsec_|service_role" -- . ':!docs' || echo "clean"`
Expected: `clean` (real keys live only in `.dev.vars` / Wrangler secrets, both untracked).

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/stripe-payments
gh pr create --base main --title "feat: Stripe payments (PLN, cards/BLIK/P24, Supabase 1/1 inventory)" \
  --body "Implements docs/superpowers/specs/2026-06-02-stripe-payments-design.md. See verification results below."
```

---

## Self-Review notes (spec coverage)

- Supabase schema + `reserve_pieces` + seed → Task 2. ✅
- PLN repricing (catalog, formatter, analytics, i18n) → Tasks 3–4. ✅
- `/api/checkout` reserve + PaymentIntent (PI-first for BLIK) → Task 9. ✅
- `/api/stripe/webhook` (`constructEventAsync`, idempotent, raw body) → Tasks 10–11. ✅
- Embedded Payment Element + address/email + return page → Task 12. ✅
- No-VAT invoice via Stripe Invoicing, emailed → Task 10 (`invoice.ts`), verified Task 13. ✅
- Sold-state on site, perf-safe (tag cache + on-demand revalidate) → Tasks 7–8, 11. ✅
- Defence-in-depth authoritative checkout validation → Tasks 6, 9. ✅
- Dashboard alerts for seller (no custom email) → no code; enable in Dashboard (Task 13 note). ✅
- Secrets/config, test→live → Tasks 5, 13. ✅
- Tests: pricing, checkout, inventory rule, webhook handler → Tasks 3, 6, 7, 10. ✅
- Out of scope items (accounts, admin, Stripe Tax, multi-currency) → not included. ✅
