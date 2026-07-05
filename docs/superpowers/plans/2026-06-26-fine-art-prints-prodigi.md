# Fine Art Prints + Prodigi Fulfilment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver fine-art prints storefront + Prodigi Classic Frame Print fulfilment on a single branch from `main`, with the correct variant model (30×40/50×70/70×100 + framed/mount/frameColour), ceramics completely untouched.

**Architecture:** Port the battle-tested mechanics from `claude/prints-feature` (ceramic guards, checkout structure, invoice/email) while rebuilding the variant model from scratch against the verified Prodigi SKU catalog. Storefront tasks (1–9) produce a checkouteable print storefront; fulfilment tasks (10–15) add the Prodigi pipeline on top. Both layers land in one PR; `claude/prints-feature` (PR #97) and related branches close on merge.

**Tech Stack:** Next.js 16 App Router, TypeScript (no Zod), Supabase (service-role), Stripe, Cloudflare Workers/Queues/R2, OpenNext, Vitest, Playwright.

## Global Constraints

- Build must stay `next build --webpack` — never `--turbo`. This takes production down if violated.
- No Zod/Valibot — plain TypeScript + manual guards only.
- All monetary values: PLN in grosze, EUR in euro-cents, GBP in pence (integers). Display uses major units.
- Secrets never in client code — Prodigi key, R2, Supabase service-role stay server-side.
- `PRODIGI_ENV=sandbox` always in dev; never set to `live` until cutover checklist passes.
- Ceramics flow must be unchanged: all existing ceramic tests pass without modification.
- Import `Link` / `useRouter` from `src/i18n/navigation.ts`, not Next.js directly.
- Five locales: `pl` (default, no prefix), `en`, `es`, `de`, `gb`.
- Currency from locale: `pl → PLN`, `gb → GBP`, `en/es/de → EUR`.
- Product images via native `<img>` + `srcSet()` from `src/lib/images.ts` — not `next/image`.

## File Map

### New files
```
src/lib/pod-skus.ts                           # 21-entry SKU + printAreaPx lookup table
src/server/prodigi/types.ts                   # Prodigi API request/response types
src/server/prodigi/client.ts                  # fetch wrapper, error classification
src/server/prodigi/mapper.ts                  # local order → Prodigi POST /orders payload
src/server/prodigi/callbacks.ts               # CloudEvents parse, dedup, re-fetch
src/server/fulfilment/enqueue.ts              # insert fulfilment_jobs + push to Queue
src/server/fulfilment/process-job.ts          # queue consumer: verify → map → POST → persist
src/server/fulfilment/status-map.ts           # Prodigi stage → local status
src/app/api/webhooks/prodigi/route.ts         # Prodigi callback endpoint
scripts/sync-prodigi-skus.ts                  # seed pod_variants from live API
supabase/migrations/20260613120000_order_items_variant.sql  (port)
supabase/migrations/20260626120001_pod_variants.sql
supabase/migrations/20260626120002_fulfilment_jobs.sql
supabase/migrations/20260626120003_webhook_events.sql
```

### Modified files (port + update)
```
src/lib/types.ts                              # add print types (new axes)
src/lib/print-cart.ts                         # new 6-part token (full rewrite)
src/lib/prints.ts                             # new PrintDesign shape (full rewrite)
src/lib/print-pricing.ts                      # new axes (full rewrite)
src/lib/checkout.ts                           # validateCart print branch (port + update axes)
src/lib/fulfillment.ts                        # port as-is from claude/prints-feature
src/lib/invoice.ts                            # port + update variantLabel call
src/lib/email.ts                              # port (print order subject + body)
src/lib/cart-lines.ts                         # port + update label
src/lib/marketing/conversions.ts              # port (print item revenue)
src/app/api/checkout/route.ts                 # port + update CheckoutVariant shape
src/app/api/stripe/webhook/route.ts           # port + add createShipment guard + enqueueProdigi
src/components/shop/PrintConfigurator.tsx     # port + swap axes
src/components/shop/PrintCollectionScreen.tsx # port
src/components/shop/PrintProductScreen.tsx    # port
src/app/[locale]/(collections)/fine-art-prints/page.tsx  # port
src/app/[locale]/(pdp)/[slug]/[id]/page.tsx  # port (branch print vs ceramic)
src/lib/seo/structured-data.ts               # port (AggregateOffer for prints)
src/components/shop/CartView.tsx             # port + update label
messages/{pl,en,es,de,gb}.json              # add print.* keys
wrangler.jsonc                               # add Queue + R2 bindings
cloudflare-env.d.ts                          # add binding types
worker.ts                                    # add queue handler
.env.example                                 # add Prodigi placeholders
package.json                                 # add sync-prodigi-skus script
```

### Test files (new + ported)
```
src/lib/print-cart.test.ts                    # token encode/decode (full rewrite)
src/lib/print-pricing.test.ts                 # priceOfVariant (full rewrite)
src/lib/prints.test.ts                        # isVariantAvailable (full rewrite)
src/lib/checkout.test.ts                      # print branch in validateCart (port + update)
src/lib/fulfillment.test.ts                   # ceramic count guard (port as-is)
src/lib/cart-lines.test.ts                    # print token label (port + update)
src/lib/marketing/conversions.test.ts         # print revenue (port + update)
src/server/prodigi/client.test.ts             # error classification (new)
src/server/prodigi/mapper.test.ts             # payload shape + recipientCost (new)
src/server/fulfilment/process-job.test.ts     # paid guard, duplicate guard (new)
e2e/print-configurator.spec.ts               # full print checkout E2E (new)
```

---

## Task 1: Branch setup + port ceramic fulfillment guard

**Files:**
- Create branch: `feat/fine-art-prints-prodigi`
- Create: `src/lib/fulfillment.ts`
- Create: `src/lib/fulfillment.test.ts`

**Interfaces:**
- Produces: `countCeramicOrderItems(supabase, orderId)`, `isUnderfulfilled(fulfilled, expected)` — used by Task 8 (webhook route)

- [ ] **Create the branch**

```bash
git checkout main
git checkout -b feat/fine-art-prints-prodigi
```

- [ ] **Write `src/lib/fulfillment.ts`**

```typescript
/** Minimal shape of the Supabase head-count query chain. */
export interface CeramicCountClient {
  from(table: string): {
    select(columns: string, opts: { count: 'exact'; head: true }): {
      eq(column: string, value: string): {
        is(column: string, value: null): Promise<{ count: number | null; error: { message: string } | null }>;
      };
    };
  };
}

/**
 * Count ceramic line items (variant IS NULL) only. Print items have no
 * piece_state row; counting them would make every print order look
 * under-fulfilled and trigger an auto-refund.
 */
export function countCeramicOrderItems(
  supabase: CeramicCountClient,
  orderId: string,
): Promise<{ count: number | null; error: { message: string } | null }> {
  return supabase
    .from('order_items')
    .select('*', { count: 'exact', head: true })
    .eq('order_id', orderId)
    .is('variant', null);
}

/** True when fewer ceramics ended up sold than expected. */
export function isUnderfulfilled(fulfilledCount: number, expectedCount: number): boolean {
  return fulfilledCount < expectedCount;
}
```

- [ ] **Write `src/lib/fulfillment.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { isUnderfulfilled } from './fulfillment';

describe('isUnderfulfilled', () => {
  it('returns false when counts match (ceramic order)', () => {
    expect(isUnderfulfilled(2, 2)).toBe(false);
  });
  it('returns false when 0 = 0 (print-only order)', () => {
    expect(isUnderfulfilled(0, 0)).toBe(false);
  });
  it('returns true when under-fulfilled', () => {
    expect(isUnderfulfilled(1, 2)).toBe(true);
  });
});
```

- [ ] **Run tests**

```bash
npx vitest run src/lib/fulfillment.test.ts
```

Expected: 3 passing.

- [ ] **Commit**

```bash
git add src/lib/fulfillment.ts src/lib/fulfillment.test.ts
git commit -m "feat(prints): port ceramic fulfillment count guard"
```

---

## Task 2: DB migrations

**Files:**
- Create: `supabase/migrations/20260613120000_order_items_variant.sql`
- Create: `supabase/migrations/20260626120001_pod_variants.sql`
- Create: `supabase/migrations/20260626120002_fulfilment_jobs.sql`
- Create: `supabase/migrations/20260626120003_webhook_events.sql`

**Interfaces:**
- Produces: `order_items.variant` (jsonb), `pod_variants` table, `fulfilment_jobs` table, `prodigi_orders` table, `webhook_events` table — consumed by Tasks 6, 7, 13, 14

- [ ] **Write `supabase/migrations/20260613120000_order_items_variant.sql`**

```sql
-- Print line items carry the chosen variant (size/framed/mount/frameColour/prodigiSku).
-- NULL = a one-of-a-kind ceramic (unchanged).
alter table order_items add column variant jsonb;

-- Replace (order_id, product_id) PK with a surrogate id so multiple variants
-- of one design can coexist in a single order.
alter table order_items add column id uuid not null default gen_random_uuid();
alter table order_items drop constraint order_items_pkey;
alter table order_items add primary key (id);

-- Preserve the ceramic dedup guarantee: one row per unique piece per order.
-- Scoped to ceramics (variant is null) so print variants are exempt.
create unique index order_items_ceramic_unique
  on order_items (order_id, product_id)
  where variant is null;
```

- [ ] **Write `supabase/migrations/20260626120001_pod_variants.sql`**

```sql
-- Source of truth for verified Prodigi SKUs and print-area dimensions.
-- Seeded via `npm run sync-prodigi-skus` (Task 11).
create table pod_variants (
  id                   uuid primary key default gen_random_uuid(),
  prodigi_sku          text not null unique,
  display_size_label   text not null,
  frame_colour         text not null,        -- 'none' for FAP (unframed)
  mount_enabled        boolean not null,
  paper                text not null default 'EMA',
  print_area_width_px  integer,
  print_area_height_px integer,
  active               boolean not null default true,
  last_synced_at       timestamptz
);
alter table pod_variants enable row level security;

-- Nullable FK: set by sync script after seeding, not at checkout time.
alter table order_items add column pod_variant_id uuid references pod_variants(id);
```

- [ ] **Write `supabase/migrations/20260626120002_fulfilment_jobs.sql`**

```sql
create table fulfilment_jobs (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id),
  provider        text not null default 'prodigi',
  status          text not null default 'queued',
  attempts        integer not null default 0,
  idempotency_key text not null unique,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- Prevent duplicate active jobs per order.
create unique index fulfilment_jobs_order_unique
  on fulfilment_jobs(order_id)
  where status not in ('cancelled', 'failed_action_required');
alter table fulfilment_jobs enable row level security;

create table prodigi_orders (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references orders(id),
  prodigi_order_id      text unique,
  prodigi_status_stage  text,
  prodigi_raw_json      jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
alter table prodigi_orders enable row level security;
```

- [ ] **Write `supabase/migrations/20260626120003_webhook_events.sql`**

```sql
create table webhook_events (
  id                    uuid primary key default gen_random_uuid(),
  provider              text not null,
  provider_event_id     text,
  event_type            text,
  status                text not null default 'processing',
  raw_json              jsonb,
  processing_started_at timestamptz,
  processed_at          timestamptz,
  created_at            timestamptz not null default now()
);
-- Dedup gate: one row per (provider, event id).
create unique index webhook_events_dedup
  on webhook_events(provider, provider_event_id)
  where provider_event_id is not null;
alter table webhook_events enable row level security;
```

- [ ] **Apply migrations**

```bash
npx supabase db push
```

Expected: all 4 migrations applied, no errors.

- [ ] **Commit**

```bash
git add supabase/migrations/
git commit -m "feat(prints): DB migrations — variant, pod_variants, fulfilment_jobs, webhook_events"
```

---

## Task 3: Core variant types

**Files:**
- Modify: `src/lib/types.ts`

**Interfaces:**
- Produces: `PrintSize`, `PrintFrameColour`, `PrintVariantSelection`, `PrintDesign` — consumed by every subsequent task

- [ ] **Add to `src/lib/types.ts`** (after the existing `CategorySlug` type, add `'fine-art-prints'` to the union, then append at the end of the file)

First, extend `CategorySlug`:
```typescript
// Before (find this line):
export type CategorySlug = 'kubki' | 'wazony' | 'wazony-srednie' | 'wazony-duze' | 'talerzyki' | 'talerze-srednie' | 'talerze-duze' | 'duze-michy' | 'miski-falowane';

// After:
export type CategorySlug = 'kubki' | 'wazony' | 'wazony-srednie' | 'wazony-duze' | 'talerzyki' | 'talerze-srednie' | 'talerze-duze' | 'duze-michy' | 'miski-falowane' | 'fine-art-prints';
```

Then append at the end of the file:
```typescript
// ── Fine-art prints ──────────────────────────────────────────────────────────

/** Display size labels (cm). Maps to Prodigi SKU suffix: 30x40→12X16, 50x70→20X28, 70x100→28X40. */
export type PrintSize = '30x40' | '50x70' | '70x100';

/** Frame colour offered in the store (3 of 8 Prodigi colours). */
export type PrintFrameColour = 'black' | 'white' | 'natural';

/** A single resolved variant choice. mount is only meaningful when framed=true. */
export interface PrintVariantSelection {
  size: PrintSize;
  framed: boolean;
  mount: boolean;
  frameColour: PrintFrameColour | 'none'; // 'none' when framed=false
}

/** A fine-art print design (open edition, configurable). */
export interface PrintDesign {
  id: string;                        // e.g. 'fap01'
  category: 'fine-art-prints';
  num: string;                       // display number, e.g. '01'
  image: string;
  gallery?: string[];
  noteIndex: number;
  sizes: PrintSize[];
  frameColours: PrintFrameColour[];  // colours offered; empty means unframed-only
  mountAvailable: boolean;
  unavailable?: string[];            // variantKey strings to exclude
  published: boolean;
  fromPLN: number;                   // display "from" price in PLN
}
```

- [ ] **Run typecheck**

```bash
npm run lint
```

Expected: no type errors on the new additions. (Other files using old print types will error — that's expected; they get fixed in subsequent tasks.)

- [ ] **Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(prints): add PrintSize/PrintFrameColour/PrintVariantSelection/PrintDesign types"
```

---

## Task 4: print-cart.ts — new 6-part token + SKU lookup table

**Files:**
- Create: `src/lib/print-cart.ts` (full rewrite)
- Create: `src/lib/print-cart.test.ts`

**Interfaces:**
- Consumes: `PrintSize`, `PrintFrameColour`, `PrintVariantSelection` from `./types`
- Produces:
  - `isPrintToken(id: string): boolean`
  - `encodePrintToken(designId: string, sel: PrintVariantSelection): string`
  - `decodePrintToken(token: string): { designId: string; sel: PrintVariantSelection } | null`
  - `variantKey(sel: PrintVariantSelection): string`
  - `variantLabel(sel: PrintVariantSelection, locale: string): string`
  - `PRODIGI_SKU_MAP: Record<string, { sku: string; printAreaPx: { w: number; h: number } }>`
  - `PRINT_SIZES`, `PRINT_FRAME_COLOURS`

- [ ] **Write `src/lib/print-cart.ts`**

```typescript
import type { PrintFrameColour, PrintSize, PrintVariantSelection } from './types';

export const PRINT_SIZES: readonly PrintSize[] = ['30x40', '50x70', '70x100'];
export const PRINT_FRAME_COLOURS: readonly PrintFrameColour[] = ['black', 'white', 'natural'];

const TOKEN_PREFIX = 'print';

/** True when a cart id is a print token (vs a bare ceramic id like 'k01'). */
export function isPrintToken(id: string): boolean {
  return id.startsWith(`${TOKEN_PREFIX}:`);
}

/** Canonical key for variant lookup and unavailable-combination checks. */
export function variantKey(sel: PrintVariantSelection): string {
  return `${sel.size}:${sel.framed}:${sel.mount}:${sel.frameColour}`;
}

/** Encode a variant selection into a cart token. */
export function encodePrintToken(designId: string, sel: PrintVariantSelection): string {
  return `${TOKEN_PREFIX}:${designId}:${sel.size}:${sel.framed}:${sel.mount}:${sel.frameColour}`;
}

/**
 * Decode and validate a cart token. Returns null for any malformed token or
 * unknown axis value. Does NOT check design existence or combination availability
 * — that's the caller's job (getPrintById + isVariantAvailable).
 */
export function decodePrintToken(
  token: string,
): { designId: string; sel: PrintVariantSelection } | null {
  if (!isPrintToken(token)) return null;
  const parts = token.split(':');
  if (parts.length !== 6) return null;
  const [, designId, size, framedStr, mountStr, frameColour] = parts;
  if (!designId) return null;
  if (!PRINT_SIZES.includes(size as PrintSize)) return null;
  const framed = framedStr === 'true';
  const mount = mountStr === 'true';
  if (framedStr !== 'true' && framedStr !== 'false') return null;
  if (mountStr !== 'true' && mountStr !== 'false') return null;
  const validColour =
    frameColour === 'none' ||
    PRINT_FRAME_COLOURS.includes(frameColour as PrintFrameColour);
  if (!validColour) return null;
  if (!framed && frameColour !== 'none') return null;
  if (framed && frameColour === 'none') return null;
  return {
    designId,
    sel: {
      size: size as PrintSize,
      framed,
      mount,
      frameColour: frameColour as PrintFrameColour | 'none',
    },
  };
}

// ── Human-readable labels ────────────────────────────────────────────────────

const SIZE_LABEL: Record<PrintSize, string> = {
  '30x40': '30×40 cm',
  '50x70': '50×70 cm',
  '70x100': '70×100 cm',
};

const UNFRAMED_LABEL: Record<string, string> = {
  pl: 'bez ramy', en: 'no frame', es: 'sin marco', de: 'ohne Rahmen', gb: 'no frame',
};

const COLOUR_LABEL: Record<string, Record<PrintFrameColour, string>> = {
  pl: { black: 'czarna', white: 'biała', natural: 'naturalna' },
  en: { black: 'black', white: 'white', natural: 'natural' },
  es: { black: 'negro', white: 'blanco', natural: 'natural' },
  de: { black: 'schwarz', white: 'weiß', natural: 'natur' },
  gb: { black: 'black', white: 'white', natural: 'natural' },
};

const MOUNT_LABEL: Record<string, string> = {
  pl: '+ passe-partout', en: '+ mount', es: '+ passepartout',
  de: '+ Passepartout', gb: '+ mount',
};

/** One-line variant label for cart, emails, invoice. No i18n runtime needed. */
export function variantLabel(sel: PrintVariantSelection, locale: string): string {
  const loc = locale in COLOUR_LABEL ? locale : 'pl';
  const parts = [SIZE_LABEL[sel.size]];
  if (!sel.framed) {
    parts.push(UNFRAMED_LABEL[loc]);
  } else {
    parts.push(`rama ${COLOUR_LABEL[loc][sel.frameColour as PrintFrameColour]}`);
    if (sel.mount) parts.push(MOUNT_LABEL[loc]);
  }
  return parts.join(' · ');
}

// ── Prodigi SKU lookup (from prodigi/sku-catalog.md) ─────────────────────────

/** Authoritative mapping from variantKey → Prodigi SKU + print-area pixels at 300 DPI. */
export const PRODIGI_SKU_MAP: Record<string, { sku: string; printAreaPx: { w: number; h: number } }> = {
  '30x40:false:false:none':    { sku: 'GLOBAL-FAP-12X16',  printAreaPx: { w: 3600, h: 4800 } },
  '30x40:true:false:black':    { sku: 'GLOBAL-CFP-12X16',  printAreaPx: { w: 3614, h: 4795 } },
  '30x40:true:false:white':    { sku: 'GLOBAL-CFP-12X16',  printAreaPx: { w: 3614, h: 4795 } },
  '30x40:true:false:natural':  { sku: 'GLOBAL-CFP-12X16',  printAreaPx: { w: 3600, h: 4800 } },
  '30x40:true:true:black':     { sku: 'GLOBAL-CFPM-12X16', printAreaPx: { w: 2400, h: 3600 } },
  '30x40:true:true:white':     { sku: 'GLOBAL-CFPM-12X16', printAreaPx: { w: 2400, h: 3600 } },
  '30x40:true:true:natural':   { sku: 'GLOBAL-CFPM-12X16', printAreaPx: { w: 2400, h: 3600 } },
  '50x70:false:false:none':    { sku: 'GLOBAL-FAP-20X28',  printAreaPx: { w: 6000, h: 8400 } },
  '50x70:true:false:black':    { sku: 'GLOBAL-CFP-20X28',  printAreaPx: { w: 6000, h: 8400 } },
  '50x70:true:false:white':    { sku: 'GLOBAL-CFP-20X28',  printAreaPx: { w: 6000, h: 8400 } },
  '50x70:true:false:natural':  { sku: 'GLOBAL-CFP-20X28',  printAreaPx: { w: 6000, h: 8400 } },
  '50x70:true:true:black':     { sku: 'GLOBAL-CFPM-20X28', printAreaPx: { w: 4800, h: 7200 } },
  '50x70:true:true:white':     { sku: 'GLOBAL-CFPM-20X28', printAreaPx: { w: 4800, h: 7200 } },
  '50x70:true:true:natural':   { sku: 'GLOBAL-CFPM-20X28', printAreaPx: { w: 4800, h: 7200 } },
  '70x100:false:false:none':   { sku: 'GLOBAL-FAP-28X40',  printAreaPx: { w: 8400, h: 12000 } },
  '70x100:true:false:black':   { sku: 'GLOBAL-CFP-28X40',  printAreaPx: { w: 8400, h: 12000 } },
  '70x100:true:false:white':   { sku: 'GLOBAL-CFP-28X40',  printAreaPx: { w: 8400, h: 12000 } },
  '70x100:true:false:natural': { sku: 'GLOBAL-CFP-28X40',  printAreaPx: { w: 8400, h: 12000 } },
  '70x100:true:true:black':    { sku: 'GLOBAL-CFPM-28X40', printAreaPx: { w: 7200, h: 10800 } },
  '70x100:true:true:white':    { sku: 'GLOBAL-CFPM-28X40', printAreaPx: { w: 7200, h: 10800 } },
  '70x100:true:true:natural':  { sku: 'GLOBAL-CFPM-28X40', printAreaPx: { w: 7200, h: 10800 } },
};
```

- [ ] **Write `src/lib/print-cart.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import {
  encodePrintToken, decodePrintToken, isPrintToken,
  variantKey, variantLabel, PRODIGI_SKU_MAP,
} from './print-cart';

describe('isPrintToken', () => {
  it('identifies print tokens', () => {
    expect(isPrintToken('print:fap01:50x70:true:true:natural')).toBe(true);
  });
  it('rejects ceramic ids', () => {
    expect(isPrintToken('k01')).toBe(false);
  });
});

describe('encodePrintToken / decodePrintToken round-trip', () => {
  const sel = { size: '50x70' as const, framed: true, mount: true, frameColour: 'natural' as const };
  it('round-trips a framed+mount variant', () => {
    const token = encodePrintToken('fap01', sel);
    expect(token).toBe('print:fap01:50x70:true:true:natural');
    expect(decodePrintToken(token)).toEqual({ designId: 'fap01', sel });
  });
  it('round-trips an unframed variant', () => {
    const unframed = { size: '30x40' as const, framed: false, mount: false, frameColour: 'none' as const };
    expect(decodePrintToken(encodePrintToken('fap01', unframed))).toEqual({ designId: 'fap01', sel: unframed });
  });
});

describe('decodePrintToken validation', () => {
  it('rejects unknown size', () => {
    expect(decodePrintToken('print:fap01:a3:true:false:black')).toBeNull();
  });
  it('rejects wrong part count', () => {
    expect(decodePrintToken('print:fap01:50x70:true:black')).toBeNull();
  });
  it('rejects framed=false with a colour', () => {
    expect(decodePrintToken('print:fap01:50x70:false:false:black')).toBeNull();
  });
  it('rejects framed=true with none colour', () => {
    expect(decodePrintToken('print:fap01:50x70:true:false:none')).toBeNull();
  });
});

describe('variantLabel', () => {
  it('labels an unframed print in Polish', () => {
    const sel = { size: '30x40' as const, framed: false, mount: false, frameColour: 'none' as const };
    expect(variantLabel(sel, 'pl')).toBe('30×40 cm · bez ramy');
  });
  it('labels a framed+mount print in English', () => {
    const sel = { size: '50x70' as const, framed: true, mount: true, frameColour: 'natural' as const };
    expect(variantLabel(sel, 'en')).toBe('50×70 cm · rama natural · + mount');
  });
});

describe('PRODIGI_SKU_MAP', () => {
  it('has exactly 21 entries', () => {
    expect(Object.keys(PRODIGI_SKU_MAP)).toHaveLength(21);
  });
  it('maps unframed 30x40 to FAP-12X16', () => {
    expect(PRODIGI_SKU_MAP[variantKey({ size: '30x40', framed: false, mount: false, frameColour: 'none' })].sku)
      .toBe('GLOBAL-FAP-12X16');
  });
  it('maps framed+mount 50x70 to CFPM-20X28 with correct print area', () => {
    const entry = PRODIGI_SKU_MAP[variantKey({ size: '50x70', framed: true, mount: true, frameColour: 'black' })];
    expect(entry.sku).toBe('GLOBAL-CFPM-20X28');
    expect(entry.printAreaPx).toEqual({ w: 4800, h: 7200 });
  });
});
```

- [ ] **Run tests**

```bash
npx vitest run src/lib/print-cart.test.ts
```

Expected: all passing.

- [ ] **Commit**

```bash
git add src/lib/print-cart.ts src/lib/print-cart.test.ts
git commit -m "feat(prints): new 6-part cart token with Prodigi SKU map"
```

---

## Task 5: prints.ts + print-pricing.ts

**Files:**
- Create: `src/lib/prints.ts` (full rewrite)
- Create: `src/lib/print-pricing.ts` (full rewrite)
- Create: `src/lib/prints.test.ts`
- Create: `src/lib/print-pricing.test.ts`

**Interfaces:**
- Consumes: `PrintDesign`, `PrintVariantSelection`, `PrintSize`, `PrintFrameColour` from `./types`; `variantKey` from `./print-cart`
- Produces:
  - `PRINT_DESIGNS: PrintDesign[]`
  - `getPrintDesigns(): PrintDesign[]`
  - `getPrintById(id: string): PrintDesign | undefined`
  - `isVariantAvailable(design: PrintDesign, sel: PrintVariantSelection): boolean`
  - `priceOfVariant(sel: PrintVariantSelection, currency: 'pln' | 'eur' | 'gbp'): number`

- [ ] **Write `src/lib/prints.ts`**

```typescript
import type { PrintDesign, PrintVariantSelection } from './types';
import { variantKey } from './print-cart';

export const PRINT_DESIGNS: PrintDesign[] = [
  {
    id: 'fap01',
    category: 'fine-art-prints',
    num: '01',
    image: '/uploads/fap-01.svg',
    gallery: ['/uploads/fap-01-room.svg', '/uploads/fap-01-detail.svg'],
    noteIndex: 0,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'white', 'natural'],
    mountAvailable: true,
    published: true,
    fromPLN: 105,
  },
  {
    id: 'fap02',
    category: 'fine-art-prints',
    num: '02',
    image: '/uploads/fap-02.svg',
    gallery: ['/uploads/fap-02-room.svg'],
    noteIndex: 1,
    sizes: ['30x40', '50x70'],
    frameColours: ['black', 'white'],
    mountAvailable: false,
    published: true,
    fromPLN: 105,
  },
  {
    id: 'fap03',
    category: 'fine-art-prints',
    num: '03',
    image: '/uploads/fap-03.svg',
    noteIndex: 2,
    sizes: ['30x40', '50x70', '70x100'],
    frameColours: ['black', 'white', 'natural'],
    mountAvailable: true,
    published: false,
    fromPLN: 105,
  },
];

const BY_ID = new Map(PRINT_DESIGNS.map((d) => [d.id, d]));

/** Published designs in registry order. */
export function getPrintDesigns(): PrintDesign[] {
  return PRINT_DESIGNS.filter((d) => d.published);
}

/** Resolve by id including unpublished — lets checkout reject hidden vs unknown. */
export function getPrintById(id: string): PrintDesign | undefined {
  return BY_ID.get(id);
}

/** Whether a variant is sellable for this design. */
export function isVariantAvailable(design: PrintDesign, sel: PrintVariantSelection): boolean {
  if (!design.published) return false;
  if (!design.sizes.includes(sel.size)) return false;
  if (sel.framed) {
    if (design.frameColours.length === 0) return false;
    if (sel.frameColour === 'none') return false;
    if (!design.frameColours.includes(sel.frameColour)) return false;
    if (sel.mount && !design.mountAvailable) return false;
  } else {
    if (sel.frameColour !== 'none') return false;
  }
  if (design.unavailable?.includes(variantKey(sel))) return false;
  return true;
}
```

- [ ] **Write `src/lib/print-pricing.ts`**

```typescript
import type { PrintSize, PrintVariantSelection } from './types';

type Money = { pln: number; eur: number; gbp: number };

const SIZE_BASE: Record<PrintSize, Money> = {
  '30x40':  { pln: 105, eur: 25, gbp: 22 },
  '50x70':  { pln: 150, eur: 35, gbp: 30 },
  '70x100': { pln: 190, eur: 45, gbp: 38 },
};

// ponytail: zero deltas until studio confirms framing margins
const FRAMED_DELTA: Money = { pln: 0, eur: 0, gbp: 0 };
const MOUNT_DELTA:  Money = { pln: 0, eur: 0, gbp: 0 };

/** Price in MAJOR units (PLN złoty / EUR / GBP). Conversion to minor units at checkout. */
export function priceOfVariant(
  sel: PrintVariantSelection,
  currency: 'pln' | 'eur' | 'gbp',
): number {
  const base  = SIZE_BASE[sel.size];
  const frame = sel.framed ? FRAMED_DELTA : { pln: 0, eur: 0, gbp: 0 };
  const mount = sel.framed && sel.mount ? MOUNT_DELTA : { pln: 0, eur: 0, gbp: 0 };
  if (currency === 'gbp') return base.gbp + frame.gbp + mount.gbp;
  if (currency === 'eur') return base.eur + frame.eur + mount.eur;
  return base.pln + frame.pln + mount.pln;
}
```

- [ ] **Write `src/lib/prints.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { getPrintById, getPrintDesigns, isVariantAvailable } from './prints';

describe('getPrintDesigns', () => {
  it('returns only published designs', () => {
    const designs = getPrintDesigns();
    expect(designs.every(d => d.published)).toBe(true);
    expect(designs.find(d => d.id === 'fap03')).toBeUndefined();
  });
});

describe('getPrintById', () => {
  it('resolves unpublished designs (so checkout can reject them)', () => {
    expect(getPrintById('fap03')?.published).toBe(false);
  });
  it('returns undefined for unknown id', () => {
    expect(getPrintById('unknown')).toBeUndefined();
  });
});

describe('isVariantAvailable', () => {
  const fap01 = getPrintById('fap01')!;

  it('accepts valid unframed variant', () => {
    expect(isVariantAvailable(fap01, { size: '30x40', framed: false, mount: false, frameColour: 'none' })).toBe(true);
  });
  it('accepts valid framed+mount variant', () => {
    expect(isVariantAvailable(fap01, { size: '50x70', framed: true, mount: true, frameColour: 'natural' })).toBe(true);
  });
  it('rejects unpublished design', () => {
    const fap03 = getPrintById('fap03')!;
    expect(isVariantAvailable(fap03, { size: '30x40', framed: false, mount: false, frameColour: 'none' })).toBe(false);
  });
  it('rejects mount when design does not offer it', () => {
    const fap02 = getPrintById('fap02')!;
    expect(isVariantAvailable(fap02, { size: '30x40', framed: true, mount: true, frameColour: 'black' })).toBe(false);
  });
  it('rejects size not offered by design', () => {
    const fap02 = getPrintById('fap02')!;
    expect(isVariantAvailable(fap02, { size: '70x100', framed: false, mount: false, frameColour: 'none' })).toBe(false);
  });
  it('rejects framed=false with non-none colour', () => {
    expect(isVariantAvailable(fap01, { size: '30x40', framed: false, mount: false, frameColour: 'black' as any })).toBe(false);
  });
});
```

- [ ] **Write `src/lib/print-pricing.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { priceOfVariant } from './print-pricing';

const unframed30 = { size: '30x40' as const, framed: false, mount: false, frameColour: 'none' as const };
const framed50   = { size: '50x70' as const, framed: true,  mount: false, frameColour: 'black' as const };
const mounted70  = { size: '70x100' as const, framed: true, mount: true,  frameColour: 'natural' as const };

describe('priceOfVariant', () => {
  it('returns PLN base for unframed 30x40', () => {
    expect(priceOfVariant(unframed30, 'pln')).toBe(105);
  });
  it('returns EUR for framed 50x70', () => {
    expect(priceOfVariant(framed50, 'eur')).toBe(35);
  });
  it('returns GBP for mounted 70x100', () => {
    expect(priceOfVariant(mounted70, 'gbp')).toBe(38);
  });
});
```

- [ ] **Run tests**

```bash
npx vitest run src/lib/prints.test.ts src/lib/print-pricing.test.ts
```

Expected: all passing.

- [ ] **Commit**

```bash
git add src/lib/prints.ts src/lib/prints.test.ts src/lib/print-pricing.ts src/lib/print-pricing.test.ts
git commit -m "feat(prints): print registry + pricing with correct Prodigi variant axes"
```

---

## Task 6: checkout.ts — validateCart updated

**Files:**
- Modify: `src/lib/checkout.ts`
- Modify: `src/lib/checkout.test.ts` (port + update for new axes)

**Interfaces:**
- Consumes: `getPrintById`, `isVariantAvailable` from `./prints`; `decodePrintToken`, `isPrintToken`, `variantKey`, `PRODIGI_SKU_MAP` from `./print-cart`; `priceOfVariant` from `./print-pricing`
- Produces:
  - `CheckoutVariant` type
  - `CheckoutItem` type: `{ product_id: string; unit_price: number; variant?: CheckoutVariant }`
  - `validateCart(rawIds, currency): ValidateResult`

- [ ] **Update `src/lib/checkout.ts`**

Find the existing `validateCart` function and the `CheckoutVariant`/`CheckoutItem` types. Replace the print-related type definitions and the print branch of `validateCart`:

```typescript
// Add to imports at top:
import { getPrintById, isVariantAvailable } from './prints';
import { decodePrintToken, isPrintToken, variantKey, PRODIGI_SKU_MAP } from './print-cart';
import { priceOfVariant } from './print-pricing';
import type { PrintVariantSelection } from './types';

// Replace CheckoutVariant definition:
export type CheckoutVariant = PrintVariantSelection & {
  prodigiSku: string;
  printAreaPx: { w: number; h: number };
};

export type CheckoutItem = { product_id: string; unit_price: number; variant?: CheckoutVariant };
export type ValidateResult =
  | { ok: true; items: CheckoutItem[] }
  | { ok: false; reason: 'empty' | 'too_many' | 'unknown' };
```

Inside `validateCart`, replace the print token branch:

```typescript
    if (isPrintToken(raw)) {
      const dec = decodePrintToken(raw);
      if (!dec) return { ok: false, reason: 'unknown' };
      const design = getPrintById(dec.designId);
      if (!design || !isVariantAvailable(design, dec.sel)) return { ok: false, reason: 'unknown' };
      const skuInfo = PRODIGI_SKU_MAP[variantKey(dec.sel)];
      if (!skuInfo) return { ok: false, reason: 'unknown' };
      seen.add(raw);
      const major = priceOfVariant(dec.sel, currency);
      const unit_price =
        currency === 'eur' ? toEuroCents(major) :
        currency === 'gbp' ? toGBPPence(major) :
        toGrosze(major);
      items.push({
        product_id: dec.designId,
        unit_price,
        variant: {
          ...dec.sel,
          prodigiSku: skuInfo.sku,
          printAreaPx: skuInfo.printAreaPx,
        },
      });
      continue;
    }
```

- [ ] **Update `src/lib/checkout.test.ts`** — find print-related tests and update axes:

Key tests to update (the rest of the file tests ceramic validation and stays unchanged):

```typescript
// Find and replace any test using old axes (a4/a3/paper/frame). Replace with:
it('accepts a valid print token', () => {
  const token = encodePrintToken('fap01', { size: '50x70', framed: true, mount: false, frameColour: 'black' });
  const result = validateCart([token], 'pln');
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.items[0].variant?.prodigiSku).toBe('GLOBAL-CFP-20X28');
  expect(result.items[0].unit_price).toBe(15000); // 150 PLN × 100
});

it('rejects an unknown design id in print token', () => {
  const token = encodePrintToken('fap99', { size: '30x40', framed: false, mount: false, frameColour: 'none' });
  expect(validateCart([token], 'pln')).toEqual({ ok: false, reason: 'unknown' });
});

it('rejects an unpublished design', () => {
  const token = encodePrintToken('fap03', { size: '30x40', framed: false, mount: false, frameColour: 'none' });
  expect(validateCart([token], 'pln')).toEqual({ ok: false, reason: 'unknown' });
});
```

- [ ] **Run tests**

```bash
npx vitest run src/lib/checkout.test.ts
```

Expected: all passing. No regressions in ceramic validation tests.

- [ ] **Commit**

```bash
git add src/lib/checkout.ts src/lib/checkout.test.ts
git commit -m "feat(prints): validateCart print branch — new variant axes + prodigiSku denormalisation"
```

---

## Task 7: checkout/route.ts — CheckoutVariant + order_items insert

**Files:**
- Modify: `src/app/api/checkout/route.ts`

**Interfaces:**
- Consumes: `CheckoutItem`, `CheckoutVariant`, `validateCart` from `src/lib/checkout.ts`
- Produces: `order_items` rows with `variant` jsonb containing `{ kind:'print', designId, size, framed, mount, frameColour, prodigiSku, printAreaPx }` — consumed by Task 8 (webhook) and Task 12 (mapper)

- [ ] **Port `src/app/api/checkout/route.ts` from `claude/prints-feature`**

```bash
git checkout claude/prints-feature -- src/app/api/checkout/route.ts
```

- [ ] **Update the `order_items` insert to include `kind` field in variant**

Find the `supabase.from('order_items').insert(...)` call and ensure each print item's variant includes `kind: 'print'`:

```typescript
  const itemRows = valid.items.map((item) => ({
    order_id: orderId,
    product_id: item.product_id,
    unit_price: item.unit_price,
    variant: item.variant
      ? { kind: 'print' as const, ...item.variant }
      : null,
  }));
  const { error: itemsErr } = await supabase.from('order_items').insert(itemRows);
```

- [ ] **Verify the `hasPrints` metadata flag is present** — find `paymentIntents.create` metadata and confirm:

```typescript
      metadata: {
        order_id: orderId,
        product_ids: productIds.join(','),
        delivery_method: method,
        ...(hasPrints ? { has_prints: '1' } : {}),
      },
```

- [ ] **Run lint + typecheck**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Commit**

```bash
git add src/app/api/checkout/route.ts
git commit -m "feat(prints): checkout route — denormalise prodigiSku + kind into order_items.variant"
```

---

## Task 8: Webhook route — createShipment guard + enqueueProdigi stub

**Files:**
- Modify: `src/app/api/stripe/webhook/route.ts`
- Create: `src/server/fulfilment/enqueue.ts` (stub — real implementation in Task 13)

**Interfaces:**
- Consumes: `countCeramicOrderItems`, `isUnderfulfilled` from `src/lib/fulfillment.ts`
- Produces: webhook route that skips InPost for print-only orders; calls `enqueueProdigi` stub after `createShipment`

- [ ] **Port `src/app/api/stripe/webhook/route.ts` from `claude/prints-feature`**

```bash
git checkout claude/prints-feature -- src/app/api/stripe/webhook/route.ts
```

- [ ] **Add `createShipment` guard and `enqueueProdigi` call**

Find the `payment_intent.succeeded` handler section. After `ensureInvoiced`, replace the unconditional `createShipment` with:

```typescript
      // Determine what line items this order has.
      const { data: lineItems } = await supabase
        .from('order_items')
        .select('variant')
        .eq('order_id', orderId);
      const hasCeramics = lineItems?.some((i) => i.variant === null) ?? false;
      const hasPrints   = lineItems?.some((i) => i.variant !== null) ?? false;

      // InPost fulfilment: ceramics only.
      if (hasCeramics) {
        await createShipment(...);  // keep existing call signature
      }

      // Prodigi fulfilment: prints only.
      if (hasPrints) {
        await enqueueProdigi(orderId, env, ctx);
      }
```

- [ ] **Create stub `src/server/fulfilment/enqueue.ts`**

```typescript
import type { CloudflareEnv } from '../../../cloudflare-env';

/**
 * Enqueue a Prodigi fulfilment job for a paid print order.
 * Real implementation in Task 13 — stub returns void for now.
 */
export async function enqueueProdigi(
  orderId: string,
  env: CloudflareEnv,
  ctx: ExecutionContext,
): Promise<void> {
  // ponytail: stub — wired but inert until Task 13
  console.log('[enqueueProdigi] stub — orderId:', orderId);
}
```

- [ ] **Add import to webhook route**

```typescript
import { enqueueProdigi } from '@/server/fulfilment/enqueue';
```

- [ ] **Run lint + typecheck**

```bash
npm run lint
```

- [ ] **Commit**

```bash
git add src/app/api/stripe/webhook/route.ts src/server/fulfilment/enqueue.ts
git commit -m "feat(prints): webhook — createShipment guard + enqueueProdigi stub"
```

---

## Task 9: Invoice, email, cart-lines, conversions — port + update

**Files:**
- Modify: `src/lib/invoice.ts`
- Modify: `src/lib/email.ts`
- Modify: `src/lib/cart-lines.ts`
- Modify: `src/lib/marketing/conversions.ts`
- Modify: `src/lib/cart-lines.test.ts`
- Modify: `src/lib/marketing/conversions.test.ts`

**Interfaces:**
- Consumes: `variantLabel` from `src/lib/print-cart.ts` (updated signature)
- Produces: invoice labels, email body, cart line labels that work with new variant axes

- [ ] **Port each file from `claude/prints-feature`**

```bash
git checkout claude/prints-feature -- \
  src/lib/invoice.ts \
  src/lib/email.ts \
  src/lib/cart-lines.ts \
  src/lib/cart-lines.test.ts \
  src/lib/marketing/conversions.ts \
  src/lib/marketing/conversions.test.ts
```

- [ ] **Update `invoice.ts` — fix variantLabel call and idempotency key**

Find the print line item label block and update the `sku` reference to `prodigiSku`:

```typescript
      if (variant) {
        const design = getPrintById(it.product_id);
        const printName = productNames['print'] ?? 'Fine-art print';
        label = `${printName} Nº ${design?.num ?? ''}`.trim()
          + ` — ${variantLabel(variant, invoiceLocale)} (${variant.prodigiSku})`;
      }
      // idempotency key uses prodigiSku instead of old sku field:
      await stripe.invoiceItems.create({...}, {
        idempotencyKey: `ii2_${order.id}_${variant?.prodigiSku ?? it.product_id}`
      });
```

- [ ] **Update `cart-lines.ts`** — find variant label call, ensure it uses `variantLabel(variant, locale)` from `./print-cart`. The import path and function name stay the same; the label output changes automatically via the updated `variantLabel`.

- [ ] **Run tests**

```bash
npx vitest run src/lib/cart-lines.test.ts src/lib/marketing/conversions.test.ts
```

Expected: all passing.

- [ ] **Run full unit suite to catch any regressions**

```bash
npm run test
```

Expected: all passing. Fix any type errors from old `sku` references.

- [ ] **Commit**

```bash
git add src/lib/invoice.ts src/lib/email.ts src/lib/cart-lines.ts src/lib/cart-lines.test.ts \
        src/lib/marketing/conversions.ts src/lib/marketing/conversions.test.ts
git commit -m "feat(prints): port invoice/email/cart-lines/conversions — update to new variant axes"
```

---

## Task 10: Prodigi types + client

**Files:**
- Create: `src/server/prodigi/types.ts`
- Create: `src/server/prodigi/client.ts`
- Create: `src/server/prodigi/client.test.ts`

**Interfaces:**
- Produces:
  - `ProdigiError` class with `retryable: boolean`
  - `prodigiClient(env)` → `{ postOrder, getOrder, getProducts }`

- [ ] **Write `src/server/prodigi/types.ts`**

```typescript
// Prodigi API v4.0 types — plain TypeScript, no Zod.

export interface ProdigiOrderItem {
  sku: string;
  copies: number;
  sizing: 'fillPrintArea';
  attributes: Record<string, string>;
  assets: Array<{ printArea: 'default'; url: string }>;
  recipientCost?: { amount: string; currency: string };
}

export interface ProdigiRecipient {
  name: string;
  email?: string;
  phoneNumber?: string;
  address: {
    line1: string;
    line2?: string;
    postalOrZipCode: string;
    countryCode: string;
    townOrCity: string;
    stateOrCounty?: string;
  };
}

export interface ProdigiOrderRequest {
  shippingMethod: string;
  idempotencyKey: string;
  callbackUrl?: string;
  merchantReference?: string;
  recipient: ProdigiRecipient;
  items: ProdigiOrderItem[];
  metadata?: Record<string, string>;
}

export interface ProdigiOrderResponse {
  outcome: 'Created' | 'AlreadyExists' | string;
  order: {
    id: string;
    status: { stage: string };
    items: Array<{ id: string; sku: string; status: { detail: string } }>;
  };
  traceParent?: string;
}

export interface ProdigiProductResponse {
  product: {
    sku: string;
    variants: Array<{
      printAreaSizes: { default: { horizontalResolution: number; verticalResolution: number } };
    }>;
    attributes: Array<{ name: string; values: string[] }>;
  };
}

export interface FulfilmentJobMessage {
  orderId: string;
  jobId: string;
}
```

- [ ] **Write `src/server/prodigi/client.ts`**

```typescript
import type { CloudflareEnv } from '../../../cloudflare-env';
import type { ProdigiOrderRequest, ProdigiOrderResponse, ProdigiProductResponse } from './types';

export class ProdigiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProdigiError';
  }
}

function baseUrl(env: CloudflareEnv): string {
  return env.PRODIGI_ENV === 'live'
    ? 'https://api.prodigi.com/v4.0'
    : 'https://api.sandbox.prodigi.com/v4.0';
}

function apiKey(env: CloudflareEnv): string {
  return env.PRODIGI_ENV === 'live'
    ? env.PRODIGI_API_KEY_LIVE
    : env.PRODIGI_API_KEY_SANDBOX;
}

async function request<T>(
  env: CloudflareEnv,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl(env)}${path}`, {
      method,
      headers: {
        'X-API-Key': apiKey(env),
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ProdigiError(`Network error: ${String(e)}`, null, true);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // 409 from Prodigi means idempotent duplicate — not retryable, not an error.
    // Caller must check outcome field.
    const retryable = res.status >= 500 || res.status === 429;
    throw new ProdigiError(`Prodigi ${res.status}: ${text}`, res.status, retryable);
  }

  return res.json() as Promise<T>;
}

export function prodigiClient(env: CloudflareEnv) {
  return {
    postOrder: (payload: ProdigiOrderRequest) =>
      request<ProdigiOrderResponse>(env, 'POST', '/orders', payload),

    getOrder: (prodigiOrderId: string) =>
      request<{ order: ProdigiOrderResponse['order'] }>(env, 'GET', `/orders/${prodigiOrderId}`),

    getProduct: (sku: string) =>
      request<ProdigiProductResponse>(env, 'GET', `/products/${sku}`),
  };
}
```

- [ ] **Write `src/server/prodigi/client.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { ProdigiError } from './client';

describe('ProdigiError', () => {
  it('marks network failures as retryable', () => {
    const err = new ProdigiError('Network error', null, true);
    expect(err.retryable).toBe(true);
  });
  it('marks 5xx as retryable', () => {
    const err = new ProdigiError('Server error', 500, true);
    expect(err.retryable).toBe(true);
  });
  it('marks 4xx (except 429) as non-retryable', () => {
    const err = new ProdigiError('Bad request', 400, false);
    expect(err.retryable).toBe(false);
  });
  it('is an Error subclass', () => {
    expect(new ProdigiError('x', 400, false)).toBeInstanceOf(Error);
  });
});
```

- [ ] **Run tests**

```bash
npx vitest run src/server/prodigi/client.test.ts
```

- [ ] **Commit**

```bash
git add src/server/prodigi/types.ts src/server/prodigi/client.ts src/server/prodigi/client.test.ts
git commit -m "feat(prodigi): API client — typed errors, sandbox/live URL, retryability"
```

---

## Task 11: SKU sync script

**Files:**
- Create: `scripts/sync-prodigi-skus.ts`
- Modify: `package.json` (add script)

**Interfaces:**
- Consumes: `PRODIGI_SKU_MAP` from `src/lib/print-cart.ts`; `prodigiClient` from `src/server/prodigi/client.ts`
- Produces: `pod_variants` table seeded with verified SKU data

- [ ] **Write `scripts/sync-prodigi-skus.ts`**

```typescript
/**
 * Verify and upsert all 21 Prodigi SKUs into pod_variants.
 * Run: npm run sync-prodigi-skus
 * Requires PRODIGI_API_KEY_SANDBOX and SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env.
 */
import { createClient } from '@supabase/supabase-js';
import { PRODIGI_SKU_MAP } from '../src/lib/print-cart';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const env = {
  PRODIGI_ENV: 'sandbox',
  PRODIGI_API_KEY_SANDBOX: process.env.PRODIGI_API_KEY_SANDBOX!,
  PRODIGI_API_KEY_LIVE: '',
} as any;

async function fetchProduct(sku: string) {
  const res = await fetch(
    `https://api.sandbox.prodigi.com/v4.0/products/${sku}`,
    { headers: { 'X-API-Key': env.PRODIGI_API_KEY_SANDBOX } },
  );
  if (!res.ok) throw new Error(`GET /products/${sku} → ${res.status}`);
  return res.json();
}

async function main() {
  const uniqueSkus = [...new Set(Object.values(PRODIGI_SKU_MAP).map((v) => v.sku))];
  console.log(`Syncing ${uniqueSkus.length} unique SKUs…`);

  for (const sku of uniqueSkus) {
    process.stdout.write(`  ${sku}… `);
    const data = await fetchProduct(sku);
    const variant = data.product?.variants?.[0];
    const printArea = variant?.printAreaSizes?.default;

    const { error } = await supabase.from('pod_variants').upsert({
      prodigi_sku: sku,
      display_size_label: sku,
      frame_colour: sku.includes('FAP') ? 'none' : 'varies',
      mount_enabled: sku.includes('CFPM'),
      print_area_width_px:  printArea?.horizontalResolution ?? null,
      print_area_height_px: printArea?.verticalResolution   ?? null,
      last_synced_at: new Date().toISOString(),
    }, { onConflict: 'prodigi_sku' });

    if (error) { console.log('ERROR', error.message); continue; }
    console.log(`ok (${printArea?.horizontalResolution}×${printArea?.verticalResolution})`);
  }

  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Add script to `package.json`**

```json
"sync-prodigi-skus": "tsx scripts/sync-prodigi-skus.ts"
```

(Add alongside existing scripts like `notes:generate`.)

- [ ] **Run with sandbox key**

```bash
npm run sync-prodigi-skus
```

Expected output: 9 unique SKUs synced, each with `ok (WxH)` confirmation.

- [ ] **Commit**

```bash
git add scripts/sync-prodigi-skus.ts package.json
git commit -m "feat(prodigi): SKU sync script — seed pod_variants from sandbox API"
```

---

## Task 12: Prodigi mapper

**Files:**
- Create: `src/server/prodigi/mapper.ts`
- Create: `src/server/prodigi/mapper.test.ts`

**Interfaces:**
- Consumes: `ProdigiOrderRequest`, `ProdigiOrderItem` from `./types`; `CheckoutVariant` shape from order_items.variant
- Produces: `buildProdigiPayload(order, printItems, assetUrls, env)` → `ProdigiOrderRequest`

- [ ] **Write `src/server/prodigi/mapper.ts`**

```typescript
import type { CloudflareEnv } from '../../../cloudflare-env';
import { SITE_URL } from '@/lib/site';
import type { ProdigiOrderItem, ProdigiOrderRequest, ProdigiRecipient } from './types';

interface OrderRow {
  id: string;
  currency: 'pln' | 'eur' | 'gbp';
  contact: { name: string; email: string; phone?: string };
  shipping_address: {
    line1: string; line2?: string; city: string;
    postal_code: string; country: string;
  };
  delivery_method: string;
}

interface PrintItemRow {
  product_id: string;
  unit_price: number;
  variant: {
    prodigiSku: string;
    framed: boolean;
    mount: boolean;
    frameColour: string;
    printAreaPx: { w: number; h: number };
  };
}

const CURRENCY_CODE: Record<'pln' | 'eur' | 'gbp', string> = {
  pln: 'PLN', eur: 'EUR', gbp: 'GBP',
};

/** Amount in major units (Prodigi expects decimal string, e.g. "35.00"). */
function majorAmount(minorUnits: number, currency: 'pln' | 'eur' | 'gbp'): string {
  return (minorUnits / 100).toFixed(2);
}

function buildAttributes(variant: PrintItemRow['variant']): Record<string, string> {
  if (!variant.framed) return {};
  const attrs: Record<string, string> = { color: variant.frameColour };
  if (variant.mount) {
    attrs['mount'] = '2.4mm';
    attrs['mountColor'] = 'Snow white';
  }
  return attrs;
}

function buildRecipient(order: OrderRow): ProdigiRecipient {
  return {
    name: order.contact.name,
    email: order.contact.email,
    phoneNumber: order.contact.phone,
    address: {
      line1:            order.shipping_address.line1,
      line2:            order.shipping_address.line2,
      postalOrZipCode:  order.shipping_address.postal_code,
      countryCode:      order.shipping_address.country,
      townOrCity:       order.shipping_address.city,
    },
  };
}

export function buildProdigiPayload(
  order: OrderRow,
  printItems: PrintItemRow[],
  assetUrls: Record<string, string>,  // product_id → presigned URL
  env: CloudflareEnv,
): ProdigiOrderRequest {
  const items: ProdigiOrderItem[] = printItems.map((item) => ({
    sku:    item.variant.prodigiSku,
    copies: 1,
    sizing: 'fillPrintArea',
    attributes: buildAttributes(item.variant),
    assets: [{ printArea: 'default', url: assetUrls[item.product_id] }],
    recipientCost: {
      amount:   majorAmount(item.unit_price, order.currency),
      currency: CURRENCY_CODE[order.currency],
    },
  }));

  return {
    shippingMethod:    env.PRODIGI_DEFAULT_SHIPPING_METHOD ?? 'Budget',
    idempotencyKey:    `prodigi:${env.PRODIGI_ENV}:order:${order.id}:v1`,
    callbackUrl:       `${SITE_URL}/api/webhooks/prodigi/${env.PRODIGI_CALLBACK_TOKEN}`,
    merchantReference: order.id,
    recipient:         buildRecipient(order),
    items,
    metadata: { internal_order_id: order.id },
  };
}
```

- [ ] **Write `src/server/prodigi/mapper.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { buildProdigiPayload } from './mapper';

const mockEnv = {
  PRODIGI_ENV: 'sandbox',
  PRODIGI_DEFAULT_SHIPPING_METHOD: 'Budget',
  PRODIGI_CALLBACK_TOKEN: 'test-token',
  PRODIGI_API_KEY_SANDBOX: 'key',
  PRODIGI_API_KEY_LIVE: '',
} as any;

const order = {
  id: 'order-123',
  currency: 'eur' as const,
  contact: { name: 'Jan Kowalski', email: 'jan@example.com' },
  shipping_address: { line1: 'ul. Marszałkowska 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
  delivery_method: 'prodigi',
};

const printItem = {
  product_id: 'fap01',
  unit_price: 3500, // 35 EUR in euro-cents
  variant: {
    prodigiSku: 'GLOBAL-CFPM-20X28',
    framed: true,
    mount: true,
    frameColour: 'natural',
    printAreaPx: { w: 4800, h: 7200 },
  },
};

describe('buildProdigiPayload', () => {
  it('sets correct idempotency key', () => {
    const payload = buildProdigiPayload(order, [printItem], { fap01: 'https://example.com/asset.jpg' }, mockEnv);
    expect(payload.idempotencyKey).toBe('prodigi:sandbox:order:order-123:v1');
  });

  it('maps EUR unit_price to recipientCost correctly', () => {
    const payload = buildProdigiPayload(order, [printItem], { fap01: 'https://example.com/asset.jpg' }, mockEnv);
    expect(payload.items[0].recipientCost).toEqual({ amount: '35.00', currency: 'EUR' });
  });

  it('sets mount attributes for CFPM', () => {
    const payload = buildProdigiPayload(order, [printItem], { fap01: 'https://example.com/asset.jpg' }, mockEnv);
    expect(payload.items[0].attributes).toEqual({ color: 'natural', mount: '2.4mm', mountColor: 'Snow white' });
  });

  it('sets no attributes for unframed FAP', () => {
    const unframed = { ...printItem, variant: { ...printItem.variant, prodigiSku: 'GLOBAL-FAP-20X28', framed: false, mount: false, frameColour: 'none' } };
    const payload = buildProdigiPayload(order, [unframed], { fap01: 'https://example.com/asset.jpg' }, mockEnv);
    expect(payload.items[0].attributes).toEqual({});
  });

  it('uses sandbox callback URL', () => {
    const payload = buildProdigiPayload(order, [printItem], { fap01: 'https://example.com/asset.jpg' }, mockEnv);
    expect(payload.callbackUrl).toContain('/api/webhooks/prodigi/test-token');
  });
});
```

- [ ] **Run tests**

```bash
npx vitest run src/server/prodigi/mapper.test.ts
```

- [ ] **Commit**

```bash
git add src/server/prodigi/mapper.ts src/server/prodigi/mapper.test.ts
git commit -m "feat(prodigi): order mapper — local order → Prodigi payload + recipientCost per currency"
```

---

## Task 13: Fulfilment enqueue + process-job

**Files:**
- Modify: `src/server/fulfilment/enqueue.ts` (replace stub)
- Create: `src/server/fulfilment/status-map.ts`
- Create: `src/server/fulfilment/process-job.ts`
- Create: `src/server/fulfilment/process-job.test.ts`

**Interfaces:**
- Consumes: `prodigiClient` from `../prodigi/client`; `buildProdigiPayload` from `../prodigi/mapper`; `FulfilmentJobMessage` from `../prodigi/types`
- Produces: `enqueueProdigi(orderId, env, ctx)`, `processJob(msg, env, ctx)`

- [ ] **Write `src/server/fulfilment/status-map.ts`**

```typescript
const TERMINAL = new Set(['completed', 'cancelled', 'failed_action_required']);

/** Map Prodigi status.stage → local fulfilment_jobs status. */
export function mapProdigiStage(stage: string): string {
  const map: Record<string, string> = {
    InProgress:    'fulfilment_submitted',
    InProduction:  'in_production',
    Complete:      'shipped',
    Cancelled:     'cancelled',
  };
  return map[stage] ?? 'fulfilment_submitted';
}

/** True when a terminal status must not be overwritten by a later callback. */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}
```

- [ ] **Replace stub `src/server/fulfilment/enqueue.ts`**

```typescript
import { getSupabaseAdmin } from '@/lib/supabase';
import type { CloudflareEnv } from '../../../cloudflare-env';
import type { FulfilmentJobMessage } from '../prodigi/types';

export async function enqueueProdigi(
  orderId: string,
  env: CloudflareEnv,
  ctx: ExecutionContext,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const jobId = crypto.randomUUID();
  const idempotencyKey = `prodigi:${env.PRODIGI_ENV}:order:${orderId}:v1`;

  // Upsert is idempotent: duplicate webhook → same unique idempotency_key → no second row.
  const { data, error } = await supabase
    .from('fulfilment_jobs')
    .upsert(
      { id: jobId, order_id: orderId, idempotency_key: idempotencyKey, status: 'queued' },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select('id')
    .single();

  if (error) {
    console.error('[enqueueProdigi] DB error:', error.message);
    return;
  }

  const msg: FulfilmentJobMessage = { orderId, jobId: data?.id ?? jobId };

  if (env.FULFILMENT_QUEUE) {
    await env.FULFILMENT_QUEUE.send(msg);
  } else {
    // Local dev without wrangler: run inline, never throw from webhook handler.
    const { processJob } = await import('./process-job');
    ctx.waitUntil(
      processJob(msg, env, ctx).catch((e) =>
        console.error('[enqueueProdigi] inline processing failed', e),
      ),
    );
  }
}
```

- [ ] **Write `src/server/fulfilment/process-job.ts`**

```typescript
import { getSupabaseAdmin } from '@/lib/supabase';
import { prodigiClient, ProdigiError } from '../prodigi/client';
import { buildProdigiPayload } from '../prodigi/mapper';
import { mapProdigiStage } from './status-map';
import type { CloudflareEnv } from '../../../cloudflare-env';
import type { FulfilmentJobMessage } from '../prodigi/types';

async function getAssetUrl(
  productId: string,
  jobId: string,
  env: CloudflareEnv,
): Promise<string> {
  if (!env.PRINT_ASSETS) {
    // Local dev fallback — public SVG placeholder
    return `https://anna-ciok.studio/uploads/${productId}.svg`;
  }
  // R2 presigned GET; key convention: {productId}/master.jpg
  const obj = await env.PRINT_ASSETS.createSignedUrl(
    `${productId}/master.jpg`,
    { expiresIn: 60 * 60 * 24 * 7 }, // 7 days
  );
  return obj.url;
}

export async function processJob(
  msg: FulfilmentJobMessage,
  env: CloudflareEnv,
  ctx: ExecutionContext,
): Promise<void> {
  const { orderId, jobId } = msg;
  const supabase = getSupabaseAdmin();

  // 1. Check job is still queued (guard against duplicate queue delivery).
  const { data: job } = await supabase
    .from('fulfilment_jobs')
    .select('status, attempts')
    .eq('id', jobId)
    .single();

  if (!job || !['queued', 'failed_retryable'].includes(job.status)) return;

  // 2. Load order.
  const { data: order } = await supabase
    .from('orders')
    .select('id, status, currency, contact, shipping_address, delivery_method')
    .eq('id', orderId)
    .single();

  if (!order || order.status !== 'paid') {
    await supabase.from('fulfilment_jobs')
      .update({ status: 'failed_action_required', last_error: 'order not paid', updated_at: new Date().toISOString() })
      .eq('id', jobId);
    return;
  }

  // 3. Load print line items.
  const { data: items } = await supabase
    .from('order_items')
    .select('product_id, unit_price, variant')
    .eq('order_id', orderId)
    .not('variant', 'is', null);

  if (!items || items.length === 0) {
    await supabase.from('fulfilment_jobs')
      .update({ status: 'failed_action_required', last_error: 'no print items found', updated_at: new Date().toISOString() })
      .eq('id', jobId);
    return;
  }

  // 4. Mark submitting.
  await supabase.from('fulfilment_jobs')
    .update({ status: 'fulfilment_submitting', updated_at: new Date().toISOString() })
    .eq('id', jobId);

  // 5. Generate asset URLs.
  const assetUrls: Record<string, string> = {};
  for (const item of items) {
    assetUrls[item.product_id] = await getAssetUrl(item.product_id, jobId, env);
  }

  // 6. Build and POST Prodigi order.
  const client = prodigiClient(env);
  const payload = buildProdigiPayload(order as any, items as any, assetUrls, env);

  let prodigiOrderId: string;
  try {
    const res = await client.postOrder(payload);
    prodigiOrderId = res.order.id;
  } catch (e) {
    const retryable = e instanceof ProdigiError ? e.retryable : true;
    await supabase.from('fulfilment_jobs')
      .update({
        status: retryable ? 'failed_retryable' : 'failed_action_required',
        last_error: String(e),
        attempts: (job.attempts ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);
    if (retryable) throw e; // Causes queue to retry.
    return;
  }

  // 7. Persist Prodigi order + mark submitted.
  await supabase.from('prodigi_orders').upsert(
    { order_id: orderId, prodigi_order_id: prodigiOrderId, prodigi_status_stage: 'InProgress' },
    { onConflict: 'prodigi_order_id' },
  );

  await supabase.from('fulfilment_jobs')
    .update({
      status: 'fulfilment_submitted',
      attempts: (job.attempts ?? 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);
}
```

- [ ] **Write `src/server/fulfilment/process-job.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { isTerminalStatus, mapProdigiStage } from './status-map';

describe('mapProdigiStage', () => {
  it('maps InProduction', () => expect(mapProdigiStage('InProduction')).toBe('in_production'));
  it('maps Complete to shipped', () => expect(mapProdigiStage('Complete')).toBe('shipped'));
  it('defaults unknown stages', () => expect(mapProdigiStage('Pending')).toBe('fulfilment_submitted'));
});

describe('isTerminalStatus', () => {
  it('treats completed as terminal', () => expect(isTerminalStatus('completed')).toBe(true));
  it('does not treat in_production as terminal', () => expect(isTerminalStatus('in_production')).toBe(false));
});
```

- [ ] **Run tests**

```bash
npx vitest run src/server/fulfilment/process-job.test.ts
```

- [ ] **Commit**

```bash
git add src/server/fulfilment/enqueue.ts src/server/fulfilment/process-job.ts \
        src/server/fulfilment/status-map.ts src/server/fulfilment/process-job.test.ts
git commit -m "feat(prodigi): fulfilment enqueue + queue consumer — idempotent, retryable"
```

---

## Task 14: Prodigi callback endpoint

**Files:**
- Create: `src/server/prodigi/callbacks.ts`
- Create: `src/app/api/webhooks/prodigi/route.ts`

**Interfaces:**
- Consumes: `prodigiClient` from `../prodigi/client`; `mapProdigiStage`, `isTerminalStatus` from `../fulfilment/status-map`
- Produces: `POST /api/webhooks/prodigi/{token}` — receives Prodigi CloudEvents callbacks

- [ ] **Write `src/server/prodigi/callbacks.ts`**

```typescript
import { getSupabaseAdmin } from '@/lib/supabase';
import { prodigiClient } from './client';
import { isTerminalStatus, mapProdigiStage } from '../fulfilment/status-map';
import type { CloudflareEnv } from '../../../cloudflare-env';

const LEASE_MINUTES = 5;

export async function handleProdigiCallback(
  body: unknown,
  env: CloudflareEnv,
): Promise<{ status: number; message: string }> {
  // 1. Parse CloudEvents shape.
  if (
    typeof body !== 'object' || body === null ||
    !('id' in body) || !('type' in body) || !('data' in body)
  ) {
    return { status: 400, message: 'Invalid CloudEvents shape' };
  }
  const event = body as { id: string; type: string; data: Record<string, unknown> };
  const prodigiOrderId = event.data?.prodigiOrderId as string | undefined;
  if (!prodigiOrderId) {
    return { status: 400, message: 'Missing data.prodigiOrderId' };
  }

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  // 2. Upsert dedup row — claim processing lease.
  const { data: existing, error: upsertErr } = await supabase
    .from('webhook_events')
    .upsert(
      {
        provider: 'prodigi',
        provider_event_id: event.id,
        event_type: event.type,
        raw_json: body,
        status: 'processing',
        processing_started_at: now,
      },
      { onConflict: 'provider,provider_event_id', ignoreDuplicates: false },
    )
    .select('id, status, processing_started_at')
    .single();

  if (upsertErr) return { status: 500, message: 'DB error on dedup upsert' };

  // Already processed.
  if (existing?.status === 'done') return { status: 200, message: 'Already processed' };

  // In-flight: check lease staleness (> 5 min = reacquire, else skip).
  if (existing?.status === 'processing' && existing.processing_started_at) {
    const age = Date.now() - new Date(existing.processing_started_at).getTime();
    if (age < LEASE_MINUTES * 60 * 1000) return { status: 200, message: 'In flight' };
    // Reacquire stale lease — fall through.
    await supabase.from('webhook_events')
      .update({ processing_started_at: now })
      .eq('id', existing.id);
  }

  // 3. Re-fetch order state from Prodigi (never trust callback payload alone).
  const client = prodigiClient(env);
  let prodigiOrder: Awaited<ReturnType<ReturnType<typeof prodigiClient>['getOrder']>>['order'];
  try {
    const res = await client.getOrder(prodigiOrderId);
    prodigiOrder = res.order;
  } catch {
    return { status: 500, message: 'Failed to re-fetch Prodigi order' };
  }

  const newStage = prodigiOrder.status?.stage ?? 'Unknown';
  const localStatus = mapProdigiStage(newStage);

  // 4. Update prodigi_orders + fulfilment_jobs (guard terminal status).
  const { data: existingPO } = await supabase
    .from('prodigi_orders')
    .select('order_id')
    .eq('prodigi_order_id', prodigiOrderId)
    .single();

  if (existingPO) {
    await supabase.from('prodigi_orders')
      .update({ prodigi_status_stage: newStage, prodigi_raw_json: prodigiOrder, updated_at: now })
      .eq('prodigi_order_id', prodigiOrderId);

    const { data: job } = await supabase
      .from('fulfilment_jobs')
      .select('id, status')
      .eq('order_id', existingPO.order_id)
      .single();

    if (job && !isTerminalStatus(job.status)) {
      await supabase.from('fulfilment_jobs')
        .update({ status: localStatus, updated_at: now })
        .eq('id', job.id);
    }
  }

  // 5. Mark event done.
  await supabase.from('webhook_events')
    .update({ status: 'done', processed_at: now })
    .eq('provider', 'prodigi')
    .eq('provider_event_id', event.id);

  return { status: 200, message: 'OK' };
}
```

- [ ] **Write `src/app/api/webhooks/prodigi/route.ts`**

```typescript
import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { handleProdigiCallback } from '@/server/prodigi/callbacks';

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: { token: string } },
) {
  const { env } = getCloudflareContext();

  if (params.token !== env.PRODIGI_CALLBACK_TOKEN) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const result = await handleProdigiCallback(body, env);
  return NextResponse.json({ message: result.message }, { status: result.status });
}
```

- [ ] **Run lint**

```bash
npm run lint
```

- [ ] **Commit**

```bash
git add src/server/prodigi/callbacks.ts src/app/api/webhooks/prodigi/route.ts
git commit -m "feat(prodigi): callback endpoint — CloudEvents, dedup lease, re-fetch, terminal guard"
```

---

## Task 15: Wrangler + worker.ts + .env.example

**Files:**
- Modify: `wrangler.jsonc`
- Modify: `cloudflare-env.d.ts`
- Modify: `worker.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `FULFILMENT_QUEUE`, `PRINT_ASSETS`, `PRODIGI_*` bindings available in `CloudflareEnv`

- [ ] **Add to `wrangler.jsonc`** (inside the root object alongside existing `"queues"` key, or add if absent):

```jsonc
  "queues": {
    "producers": [{ "binding": "FULFILMENT_QUEUE", "queue": "prodigi-fulfilment" }],
    "consumers": [{
      "queue": "prodigi-fulfilment",
      "max_batch_size": 1,
      "max_retries": 10,
      "dead_letter_queue": "prodigi-fulfilment-dlq"
    }]
  },
  "r2_buckets": [
    { "binding": "PRINT_ASSETS", "bucket_name": "anna-ciok-print-assets" }
  ]
```

- [ ] **Add to `cloudflare-env.d.ts`**

```typescript
  FULFILMENT_QUEUE: Queue;
  PRINT_ASSETS: R2Bucket;
  PRODIGI_API_KEY_SANDBOX: string;
  PRODIGI_API_KEY_LIVE: string;
  PRODIGI_ENV: string;
  PRODIGI_CALLBACK_TOKEN: string;
  PRINT_ASSET_TOKEN_SECRET: string;
  PRODIGI_DEFAULT_SHIPPING_METHOD: string;
```

- [ ] **Run `cf-typegen`**

```bash
npm run cf-typegen
```

- [ ] **Add queue handler to `worker.ts`**

Find the existing default export and add the `queue` handler:

```typescript
import { processJob } from './src/server/fulfilment/process-job';
import type { FulfilmentJobMessage } from './src/server/prodigi/types';

export default {
  fetch:     handler.fetch,
  scheduled: handler.scheduled,
  async queue(
    batch: MessageBatch<FulfilmentJobMessage>,
    env: CloudflareEnv,
    ctx: ExecutionContext,
  ) {
    for (const msg of batch.messages) {
      await processJob(msg.body, env, ctx)
        .then(() => msg.ack())
        .catch((err) => {
          if ((err as any)?.retryable === false) msg.ack();
          else msg.retry();
        });
    }
  },
};
```

- [ ] **Add Prodigi placeholders to `.env.example`**

```bash
# Prodigi Print-on-Demand
PRODIGI_API_KEY_SANDBOX=             # Prodigi dashboard → API keys → sandbox
PRODIGI_API_KEY_LIVE=                # Prodigi dashboard → API keys → live
PRODIGI_ENV=sandbox                  # set to "live" only after cutover checklist
PRODIGI_CALLBACK_TOKEN=              # openssl rand -hex 32
PRINT_ASSET_TOKEN_SECRET=            # openssl rand -hex 32
PRODIGI_DEFAULT_SHIPPING_METHOD=Budget
```

- [ ] **Run build to verify bindings don't break webpack**

```bash
npm run build
```

Expected: successful build, no ChunkLoadError, no missing type errors.

- [ ] **Commit**

```bash
git add wrangler.jsonc cloudflare-env.d.ts worker.ts .env.example
git commit -m "feat(prodigi): CF Queue + R2 bindings, worker queue handler, env vars"
```

---

## Task 16: Storefront UI

**Files:**
- Port + update: `src/components/shop/PrintConfigurator.tsx`
- Port: `src/components/shop/PrintCollectionScreen.tsx`
- Port: `src/components/shop/PrintProductScreen.tsx`
- Port: `src/app/[locale]/(collections)/fine-art-prints/page.tsx`
- Port + update: `src/app/[locale]/(pdp)/[slug]/[id]/page.tsx`
- Port + update: `src/lib/seo/structured-data.ts`
- Port + update: `src/components/shop/CartView.tsx`
- Update: `messages/{pl,en,es,de,gb}.json`

- [ ] **Port UI components from `claude/prints-feature`**

```bash
git checkout claude/prints-feature -- \
  src/components/shop/PrintCollectionScreen.tsx \
  src/components/shop/PrintProductScreen.tsx \
  src/app/[locale]/\(collections\)/fine-art-prints/page.tsx \
  src/components/shop/CartView.tsx \
  src/lib/seo/structured-data.ts
```

- [ ] **Port + rewrite `src/components/shop/PrintConfigurator.tsx`**

The configurator's axis selectors must change from `size/paper/frame` to `size/framed/mount/frameColour`. Port the component shell from `claude/prints-feature` and replace the variant state:

```typescript
// Replace old variant state:
const [variant, setVariant] = useState<PrintVariantSelection>({
  size: design.sizes[0],
  framed: false,
  mount: false,
  frameColour: 'none',
});

// Replace the selector UI — three conditional sections:
// 1. Size selector (always shown): design.sizes
// 2. Framing toggle (shown when design.frameColours.length > 0):
//    "No frame" | "Framed" — sets framed: true/false, resets mount + frameColour
// 3. Frame colour selector (shown when variant.framed):
//    maps over design.frameColours
// 4. Mount toggle (shown when variant.framed && design.mountAvailable):
//    "No passe-partout" | "With passe-partout"
```

The `encodePrintToken` and `variantLabel` imports update automatically since they're from `./print-cart` (already rewritten in Task 4).

- [ ] **Update `messages/pl.json`** — add `print.*` keys (others will mirror with translated values):

```json
"print": {
  "size": "Rozmiar",
  "framing": "Oprawa",
  "unframed": "Bez ramy",
  "framed": "W ramie",
  "frameColour": "Kolor ramy",
  "colour_black": "Czarna",
  "colour_white": "Biała",
  "colour_natural": "Naturalna",
  "mount": "Passe-partout",
  "mount_none": "Bez",
  "mount_yes": "Z passe-partout",
  "fromPrice": "Od {price}",
  "addToCart": "Dodaj do koszyka",
  "paperNote": "Druk na papierze Fine Art EMA 200 g/m²"
}
```

Add equivalent translated versions to `en`, `es`, `de`, `gb`.

- [ ] **Update PDP `src/app/[locale]/(pdp)/[slug]/[id]/page.tsx`**

Find where the page branches on `isPrintToken` or design type and ensure it routes fine-art-prints to `PrintProductScreen`. Update any `PrintVariantSelection` props for new axis shape.

- [ ] **Run dev server and verify the configurator renders**

```bash
npm run dev
```

Open `http://localhost:3000/fine-art-prints/fap01` — verify size buttons, framing toggle, frame colour swatches, and passe-partout toggle all render. Verify cart token in localStorage matches `print:fap01:{size}:{framed}:{mount}:{colour}` format.

- [ ] **Run typecheck + lint**

```bash
npm run lint
```

- [ ] **Commit**

```bash
git add src/components/shop/ src/app/ src/lib/seo/ messages/
git commit -m "feat(prints): storefront UI — configurator with framed/mount/frameColour axes"
```

---

## Task 17: Full test suite + build + E2E + PR

**Files:**
- Create: `e2e/print-configurator.spec.ts`

- [ ] **Run full unit test suite**

```bash
npm run test
```

Expected: all passing. Zero regressions in ceramic tests.

- [ ] **Write E2E spec `e2e/print-configurator.spec.ts`**

```typescript
import { test, expect } from '@playwright/test';

test.describe('fine-art print configurator @ci', () => {
  test('renders configurator and adds print to cart', async ({ page }) => {
    await page.goto('/fine-art-prints/fap01');
    // Select 50x70
    await page.getByRole('button', { name: '50×70 cm' }).click();
    // Select framed
    await page.getByRole('button', { name: /w ramie|framed/i }).click();
    // Select black frame
    await page.getByRole('button', { name: /czarna|black/i }).click();
    // Add to cart
    await page.getByRole('button', { name: /dodaj|add to cart/i }).click();
    // Verify cart count increases
    await expect(page.getByTestId('cart-count')).toHaveText('1');
  });

  test('unframed variant shows no colour/mount selectors', async ({ page }) => {
    await page.goto('/fine-art-prints/fap01');
    await page.getByRole('button', { name: /bez ramy|no frame/i }).click();
    await expect(page.getByTestId('frame-colour-selector')).not.toBeVisible();
    await expect(page.getByTestId('mount-selector')).not.toBeVisible();
  });
});
```

- [ ] **Run E2E against dev server**

```bash
npx playwright test e2e/print-configurator.spec.ts
```

- [ ] **Run production build**

```bash
npm run build
```

Expected: `next build --webpack` succeeds, no ChunkLoadError.

- [ ] **Run Workers preview smoke test**

```bash
npm run preview:cf
```

Open `http://localhost:8787/fine-art-prints/fap01` — confirm page loads, no 500.

- [ ] **Close superseded PRs on GitHub**

```bash
gh pr close 97 --comment "Superseded by feat/fine-art-prints-prodigi — correct Prodigi variant model + fulfilment pipeline."
gh pr close 82 --comment "Variant migration subsumed into feat/fine-art-prints-prodigi migrations."
gh pr close 80 --comment "Planning docs superseded by 2026-06-26-fine-art-prints-prodigi-design.md spec."
```

- [ ] **Delete superseded local branches**

```bash
git branch -d claude/prints-feature
```

- [ ] **Open PR**

```bash
git push -u origin feat/fine-art-prints-prodigi
gh pr create \
  --title "feat(prints+prodigi): fine art prints storefront + Prodigi fulfilment" \
  --body "$(cat <<'EOF'
## Summary

- Storefront: fine-art print collection, PDP, configurator with correct Prodigi variant model (30×40/50×70/70×100, framed/mount/frameColour). Replaces old a4/a3 + paper + frame axes.
- Fulfilment: Prodigi Classic Frame Print pipeline — Cloudflare Queue → process-job → POST /orders → R2 presigned asset URL → CloudEvents callback → status tracking.
- Guards: `createShipment` (InPost) skips print-only orders; `markPaid` count guard already filters `variant IS NULL` (ceramic-only); invoice extended for print line items.
- Ceramics: fully untouched. All existing ceramic tests pass.

## Closes
Supersedes PR #97 (claude/prints-feature), PR #82 (variant_key migration), PR #80 (codex plan).

## Test plan
- [ ] `npm run test` — all unit tests pass
- [ ] `npm run lint` — no type errors
- [ ] `npm run build` — webpack build succeeds
- [ ] E2E: `print-configurator.spec.ts` passes
- [ ] `npm run sync-prodigi-skus` — all 9 SKUs verified in sandbox
- [ ] Sandbox smoke test: place print order → Prodigi order created → callback received → status updated
- [ ] Duplicate webhook test: same `payment_intent.succeeded` → only one `fulfilment_jobs` row
- [ ] Print-only order: `createShipment` not called (verify in test or smoke test log)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage check:**

| Spec section | Task(s) |
|---|---|
| Variant model (§3) | Tasks 3, 4 |
| PrintDesign shape (§4) | Task 5 |
| Pricing (§5) | Task 5 |
| DB migrations — all 4 (§6) | Task 2 |
| Module structure (§7) | Tasks 10–14 |
| Webhook flow with guards (§8) | Tasks 1, 8 |
| CF Queue + R2 bindings (§9) | Task 15 |
| Callback endpoint (§10) | Task 14 |
| .env.example (§11) | Task 15 |
| Tests (§12) | Tasks 1, 4, 5, 6, 10, 12, 13, 14, 17 |
| Open PR cleanup (§13) | Task 17 |
| Port from claude/prints-feature | Tasks 7, 8, 9, 16 |

All sections covered. No gaps found.
