# Fine-Art Collections Migration — Plan 2 (Remaining Consumers + Cleanup) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every remaining fine-art-print naming/grouping consumer —
the cart, order invoices, client-side GA4/Meta analytics, marketing
conversion tracking, the product feed, admin listings, and account order
history — read from the CMS-managed collections data (via
`loadPrintCollectionDefinitions`, already built in Plan 1), then delete
the now-fully-unused static curation file and its dead code.

**Precondition:** Plan 1
(`docs/superpowers/plans/2026-09-16-fine-art-collections-plan1.md`) is
merged and verified live — `printDisplayName`/`groupPrintDesigns` already
have their optional `definitions` parameter, and `/sklep`/the PDP/the
homepage/SEO structured data already load and pass it.

**Architecture:** Two different mechanisms, matched to each consumer's
actual execution context:
1. **Server contexts with an already-available Supabase client**
   (webhooks, admin pages, account pages, feed routes) — call
   `loadPrintCollectionDefinitions(supabase)` directly using the client
   already in scope, then pass `definitions` into the existing
   `printDisplayName`/helper-function call, exactly like Plan 1.
2. **Client-side analytics** — rather than threading `definitions` (and a
   Supabase dependency) into `analytics.ts` itself, each client component
   that already has (or can cheaply get) `definitions` computes the
   correct name itself and passes it as an explicit override — mirroring
   the existing `priceOverride` pattern already used throughout
   `analytics.ts`. This keeps `analytics.ts` free of any new async/DB
   concerns.

**Tech Stack:** Same as Plan 1.

**Spec:** `docs/plans/2026-09-16-fine-art-collections-migration.md`

## Global Constraints

- Every change in this plan is additive/backward-compatible in the same
  way Plan 1's were — no existing test or caller should need to change
  unless it's explicitly one of this plan's target files.
- Client components never call `loadPrintCollectionDefinitions` or touch
  Supabase directly — `definitions` (or an already-resolved name string)
  always arrives as a prop from a server-rendered ancestor.
- `analytics.ts`'s public function signatures gain new *optional* fields
  only — every existing call site (including this file's own tests)
  continues to work unmodified.
- Task 11 (cleanup) runs last, after every other task in this plan is
  done and verified — deleting `config/print-catalog-curation.json` or
  any `print-curation.ts` export before then would break a
  still-migrating caller.

---

### Task 1: `analytics.ts` — accept a pre-resolved item name

**Files:**
- Modify: `src/lib/analytics.ts`
- Test: `src/lib/analytics.test.ts`

**Interfaces:**
- Produces: `PrintItemInput` gains an optional `itemName?: string`;
  `printAnalyticsItem` uses it when present; `analyticsItemForId` gains an
  optional 3rd parameter `nameOverride?: string`; `analyticsItemsForIds`
  gains an optional 3rd parameter `nameOverrides?: (string | undefined)[]`
  (positional, parallel to `ids`).

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/analytics.test.ts`:

```typescript
describe('printAnalyticsItem with an itemName override', () => {
  it('uses PrintItemInput.itemName when provided, instead of deriving from printDisplayName', () => {
    const e = buildPrintAddToCartEvent(
      { id: 'fap001', num: '01', variantLabel: '50x70', price: 100, itemName: 'Custom Override Name' },
      { currency: 'EUR' },
    );
    expect(e.ecommerce.items[0].item_name).toBe('Custom Override Name');
  });

  it('falls back to printDisplayName when itemName is omitted', () => {
    const e = buildPrintAddToCartEvent({ id: 'fap001', num: '01', variantLabel: '50x70', price: 100 }, { currency: 'EUR' });
    expect(e.ecommerce.items[0].item_name).toBe('Ostrea 01');
  });
});

describe('analyticsItemForId with a nameOverride', () => {
  it('uses nameOverride for a print token when provided', () => {
    const item = analyticsItemForId('print:fap005:50x70:true:false:black', 220, 'Custom Print Name');
    expect(item?.item_name).toBe('Custom Print Name');
  });

  it('falls back to printDisplayName when nameOverride is omitted', () => {
    const item = analyticsItemForId('print:fap005:50x70:true:false:black', 220);
    expect(item?.item_name).not.toBe('Custom Print Name');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/analytics.test.ts`
Expected: FAIL — `itemName`/`nameOverride` aren't recognized/used yet.

- [ ] **Step 3: Implement**

Find:

```typescript
type PrintItemInput = { id: string; num: string; variantLabel: string; price: number };
```

replace with:

```typescript
type PrintItemInput = { id: string; num: string; variantLabel: string; price: number; itemName?: string };
```

Find:

```typescript
function printAnalyticsItem(print: PrintItemInput): AnalyticsItem {
  return {
    item_id: print.id,
    item_name: printDisplayName(print),
```

replace with:

```typescript
function printAnalyticsItem(print: PrintItemInput): AnalyticsItem {
  return {
    item_id: print.id,
    item_name: print.itemName ?? printDisplayName(print),
```

Find:

```typescript
export function analyticsItemForId(id: string, priceOverride?: number): AnalyticsItem | null {
```

replace with:

```typescript
export function analyticsItemForId(id: string, priceOverride?: number, nameOverride?: string): AnalyticsItem | null {
```

Inside that function's print branch, find:

```typescript
    return {
      item_id: design.id,
      item_name: printDisplayName(design),
      item_brand: BRAND,
      item_category: 'fine-art-prints',
      item_variant: variantLabel(dec.sel, 'en'),
      price: priceOverride,
      quantity: 1,
    };
```

replace with:

```typescript
    return {
      item_id: design.id,
      item_name: nameOverride ?? printDisplayName(design),
      item_brand: BRAND,
      item_category: 'fine-art-prints',
      item_variant: variantLabel(dec.sel, 'en'),
      price: priceOverride,
      quantity: 1,
    };
```

Find:

```typescript
export function analyticsItemsForIds(ids: string[], itemPrices?: number[]): AnalyticsItem[] {
  return ids
    .map((id, i) => analyticsItemForId(id, itemPrices?.[i]))
    .filter((it): it is AnalyticsItem => it !== null);
}
```

replace with:

```typescript
export function analyticsItemsForIds(
  ids: string[],
  itemPrices?: number[],
  nameOverrides?: (string | undefined)[],
): AnalyticsItem[] {
  return ids
    .map((id, i) => analyticsItemForId(id, itemPrices?.[i], nameOverrides?.[i]))
    .filter((it): it is AnalyticsItem => it !== null);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/analytics.test.ts`
Expected: PASS, all tests including pre-existing ones (unchanged calls
default `itemName`/`nameOverride`/`nameOverrides` to `undefined`,
preserving current behavior exactly).

- [ ] **Step 5: Run the full test suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/analytics.ts src/lib/analytics.test.ts
git commit -m "feat: let print analytics events accept a pre-resolved item name"
```

---

### Task 2: Cart — resolve names server-side, use them for display and analytics

**Files:**
- Modify: `src/lib/cart-lines-server.ts`
- Modify: `src/components/shop/CartView.tsx`
- Test: `src/lib/cart-lines-server.test.ts` (extend if it exists, else create)

**Interfaces:**
- Consumes: `loadPrintCollectionDefinitions` (Plan 1), `getSupabaseAdmin()`.
- Produces: `CartLine`'s `print` variant gains a `name: string` field,
  resolved once per cart-lines request.

- [ ] **Step 1: Read the current full files**

```bash
git -C . show HEAD:src/lib/cart-lines-server.ts
git -C . show HEAD:src/components/shop/CartView.tsx
git -C . show HEAD:src/app/api/cart-lines/route.ts
```

- [ ] **Step 2: Write the failing test**

Create/extend `src/lib/cart-lines-server.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('./supabase', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('./print-collections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./print-collections')>();
  return {
    ...actual,
    loadPrintCollectionDefinitions: vi.fn(async () => [
      { slug: 'ostrea', name: 'Ostrea', designIds: ['fap001'], prints: [] },
    ]),
  };
});

// getPrintById / registryPrintById / isVariantAvailable / withRegistryMockups
// are exercised via the real modules in this test — only the two DB-facing
// calls above are mocked, matching this file's own existing test style (read
// it first: `git show HEAD:src/lib/cart-lines-server.test.ts` if it exists).

import { resolveCartLinesServer } from './cart-lines-server';

describe('resolveCartLinesServer print line names', () => {
  it('resolves a print line with the CMS-collection-derived name', async () => {
    const lines = await resolveCartLinesServer(['print:fap001:50x70:false:false:none']);
    const printLine = lines.find((l) => l.kind === 'print');
    expect(printLine).toBeDefined();
    if (printLine?.kind === 'print') {
      expect(printLine.name).toBe('Ostrea 01');
    }
  });
});
```

(If a real `cart-lines-server.test.ts` already exists with its own
mocking conventions for `getPrintById`/registry lookups, follow its
existing pattern instead of introducing a second one — read it first per
Step 1 and adapt this test to match.)

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/cart-lines-server.test.ts`
Expected: FAIL — `printLine.name` is `undefined` (the `CartLine` type has
no `name` field yet).

- [ ] **Step 4: Implement**

In `src/lib/cart-lines-server.ts`, add the imports:

```typescript
import { getSupabaseAdmin } from './supabase';
import { loadPrintCollectionDefinitions } from './print-collections';
import { printDisplayName } from './print-curation';
```

Find:

```typescript
export type CartLine =
  | { kind: 'ceramic'; id: string; product: Product }
  | { kind: 'print'; id: string; design: PrintDesign; sel: PrintVariantSelection }
  | { kind: 'giftcard'; id: string; tier: GiftCardTier }
  | { kind: 'unavailable'; id: string };
```

replace with:

```typescript
export type CartLine =
  | { kind: 'ceramic'; id: string; product: Product }
  | { kind: 'print'; id: string; design: PrintDesign; sel: PrintVariantSelection; name: string }
  | { kind: 'giftcard'; id: string; tier: GiftCardTier }
  | { kind: 'unavailable'; id: string };
```

Find (inside `resolveCartLinesServer`, before the `const lines: CartLine[] = [];` line):

```typescript
export async function resolveCartLinesServer(rawIds: string[]): Promise<CartLine[]> {
  const seen = new Set<string>();
```

replace with:

```typescript
export async function resolveCartLinesServer(rawIds: string[]): Promise<CartLine[]> {
  const definitions = await loadPrintCollectionDefinitions(getSupabaseAdmin());
  const seen = new Set<string>();
```

Find:

```typescript
      lines.push({ kind: 'print', id, design, sel: dec.sel });
```

replace with:

```typescript
      lines.push({ kind: 'print', id, design, sel: dec.sel, name: printDisplayName(design, 'Print', definitions) });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/cart-lines-server.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire `CartView.tsx` to use the resolved name**

In `src/components/shop/CartView.tsx`, find each of the 3 current
`printDisplayName(d, t('product.print'))`-style calls (around lines 820,
1100, 1105 — re-confirm exact lines against the file read in Step 1) and
replace with reading `l.name` directly from the `CartLine`, instead of
recomputing it — e.g. if the current code is:

```typescript
const name = printDisplayName(d, t('product.print'));
```

and `d` is a `CartLine`'s `design` field with `l` as the enclosing line
variable, replace with:

```typescript
const name = l.name;
```

(Match this precisely against the actual variable names in context — the
three call sites may destructure differently; the principle is: use the
line's own already-resolved `.name`, never re-derive via
`printDisplayName`, since `CartView.tsx` has no `definitions` of its own
and shouldn't need one.)

Find the two `analyticsItemsForIds(lines.map((l) => l.id), lines.map(priceOfLine))`
calls (lines ~461, ~538) and add the third argument:

```typescript
const items = analyticsItemsForIds(
  lines.map((l) => l.id),
  lines.map(priceOfLine),
  lines.map((l) => (l.kind === 'print' ? l.name : undefined)),
);
```

Find the `buildPrintRemoveFromCartEvent({ id: design.id, num: design.num, variantLabel: ..., price }, ...)`
call (~line 838) and add `itemName` to the object literal, using the
enclosing line's `name`:

```typescript
buildPrintRemoveFromCartEvent(
  { id: design.id, num: design.num, variantLabel: variantLabel(sel, locale), price, itemName: name },
  { currency: analyticsCurrency },
),
```

(Confirm the exact enclosing variable holding the resolved name at that
call site against the actual file — it should be the same `CartLine`'s
`.name` already in scope from the surrounding render code.)

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Run the full test suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/cart-lines-server.ts src/lib/cart-lines-server.test.ts src/components/shop/CartView.tsx
git commit -m "feat: resolve cart print names from CMS collections, server-side"
```

---

### Task 3: `/sklep` collection-view analytics

**Files:**
- Modify: `src/components/shop/PrintCollectionScreen.tsx`
- Modify: `src/components/shop/PrintCollectionAnalytics.tsx`

**Interfaces:**
- Consumes: `definitions`, already a prop on `PrintCollectionScreen`
  since Plan 1 Task 3.

- [ ] **Step 1: Read the current full files**

```bash
git -C . show HEAD:src/components/shop/PrintCollectionScreen.tsx
git -C . show HEAD:src/components/shop/PrintCollectionAnalytics.tsx
```

- [ ] **Step 2: Wire `PrintCollectionScreen.tsx`**

Find where it builds the `items: PrintListItem[]` array passed to
`<PrintCollectionAnalytics items={...} ...>` (around line 79's call site
— read the surrounding code for the exact `items` construction). Each
item is built from a design; add `itemName: printDisplayName(d, t('product.print'), definitions)`
to each item object (matching whatever the current per-item mapping
looks like — `PrintListItem = { id, num, variantLabel, price }`, from
`PrintCollectionAnalytics.tsx`'s own exported type, gains no new required
field since `itemName` will be optional there too — see Step 4).

- [ ] **Step 3: Add `itemName` to `PrintListItem`**

In `PrintCollectionAnalytics.tsx`, find:

```typescript
export type PrintListItem = { id: string; num: string; variantLabel: string; price: number };
```

replace with:

```typescript
export type PrintListItem = { id: string; num: string; variantLabel: string; price: number; itemName?: string };
```

- [ ] **Step 4: Thread `itemName` into the two event builders**

Find where `PrintCollectionAnalytics.tsx` calls
`buildPrintViewItemListEvent(items, ...)` and `buildPrintSelectItemEvent(item, ...)`
— since `items`/`item` already carry `itemName` (from Step 2/3), and
`printAnalyticsItem` (Task 1) already reads `print.itemName` when
present, **no further change is needed here** — the field flows through
automatically as part of the existing `PrintItemInput`-shaped objects.
Confirm this by reading the two call sites and verifying `items`/`item`
are passed through unchanged (not reconstructed/destructured in a way
that would drop the new field).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Run the full test suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/shop/PrintCollectionScreen.tsx src/components/shop/PrintCollectionAnalytics.tsx
git commit -m "feat: resolve print collection tile analytics names from the CMS"
```

---

### Task 4: PDP view analytics

**Files:**
- Modify: `src/components/shop/PrintProductScreen.tsx`
- Modify: `src/components/shop/PrintViewAnalytics.tsx`

**Interfaces:**
- Consumes: `definitions`, already a prop on `PrintProductScreen` since
  Plan 1 Task 4.

- [ ] **Step 1: Read the current full files**

```bash
git -C . show HEAD:src/components/shop/PrintProductScreen.tsx
git -C . show HEAD:src/components/shop/PrintViewAnalytics.tsx
```

- [ ] **Step 2: Wire `PrintViewAnalytics.tsx`**

Find:

```typescript
type Props = { design: PrintDesign; pricing: PrintPricingConfig };

export function PrintViewAnalytics({ design, pricing }: Props) {
```

replace with:

```typescript
import type { PrintCollectionDefinition } from '@/lib/print-curation';
import { printDisplayName } from '@/lib/print-curation';

type Props = { design: PrintDesign; pricing: PrintPricingConfig; definitions?: PrintCollectionDefinition[] };

export function PrintViewAnalytics({ design, pricing, definitions }: Props) {
```

Find the `buildPrintViewItemEvent({ id: design.id, num: design.num, variantLabel: ..., price: ... }, ...)`
call and add `itemName`:

```typescript
buildPrintViewItemEvent(
  { id: design.id, num: design.num, variantLabel: variantLabel(sel, locale), price: priceOfVariant(sel, printCurrency, pricing), itemName: printDisplayName(design, undefined, definitions) },
  { currency: analyticsCurrency },
),
```

(Match the exact surrounding object literal against the file — only
adding the `itemName` field, not altering the other fields' computation.)

- [ ] **Step 3: Wire `PrintProductScreen.tsx`**

Find:

```typescript
<PrintViewAnalytics design={design} pricing={pricing} />
```

replace with:

```typescript
<PrintViewAnalytics design={design} pricing={pricing} definitions={definitions} />
```

(`definitions` is already a prop on `PrintProductScreen` itself, per Plan
1 Task 4 Step 3 — this just forwards it one level further.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/shop/PrintProductScreen.tsx src/components/shop/PrintViewAnalytics.tsx
git commit -m "feat: resolve PDP view analytics name from the CMS"
```

---

### Task 5: PDP configurator (add/remove-to-cart analytics)

**Files:**
- Modify: `src/components/shop/PrintPdpPurchase.tsx`
- Modify: `src/components/shop/PrintConfigurator.tsx`

**Interfaces:**
- Consumes: `definitions`, threaded from `PrintProductScreen` (Plan 1
  Task 4) through `PrintPdpPurchase` (new in this task) to
  `PrintConfigurator`.

- [ ] **Step 1: Read the current full files**

```bash
git -C . show HEAD:src/components/shop/PrintPdpPurchase.tsx
git -C . show HEAD:src/components/shop/PrintConfigurator.tsx
git -C . show HEAD:src/components/shop/PrintProductScreen.tsx
```

- [ ] **Step 2: Wire `PrintProductScreen.tsx` → `PrintPdpPurchase`**

Find where `PrintProductScreen.tsx` renders `<PrintPdpPurchase design={...} images={...} .../>`
and add `definitions={definitions}` (the prop it already has since Plan 1
Task 4).

- [ ] **Step 3: Wire `PrintPdpPurchase.tsx`**

Find:

```typescript
export function PrintPdpPurchase({
  design,
  images,
  alt,
  usableVariantKeys,
  pricing,
  header,
  footer,
}: {
  design: PrintDesign;
  images: string[];
  alt: string;
  usableVariantKeys?: string[];
  pricing: PrintPricingConfig;
  header: ReactNode;
  footer: ReactNode;
}) {
```

replace with:

```typescript
import type { PrintCollectionDefinition } from '@/lib/print-curation';

export function PrintPdpPurchase({
  design,
  images,
  alt,
  usableVariantKeys,
  pricing,
  header,
  footer,
  definitions,
}: {
  design: PrintDesign;
  images: string[];
  alt: string;
  usableVariantKeys?: string[];
  pricing: PrintPricingConfig;
  header: ReactNode;
  footer: ReactNode;
  definitions?: PrintCollectionDefinition[];
}) {
```

Find:

```typescript
        <PrintConfigurator
          design={design}
          usableVariantKeys={usableVariantKeys}
          pricing={pricing}
          sel={sel}
          onSelChange={setSel}
        />
```

replace with:

```typescript
        <PrintConfigurator
          design={design}
          usableVariantKeys={usableVariantKeys}
          pricing={pricing}
          sel={sel}
          onSelChange={setSel}
          definitions={definitions}
        />
```

- [ ] **Step 4: Wire `PrintConfigurator.tsx`**

Find:

```typescript
export function PrintConfigurator({
  design,
  usableVariantKeys,
  pricing,
  sel,
  onSelChange,
}: {
  design: PrintDesign;
  usableVariantKeys?: string[];
  pricing: PrintPricingConfig;
  sel: PrintVariantSelection;
  onSelChange: (sel: PrintVariantSelection) => void;
}) {
```

replace with:

```typescript
import { printDisplayName, type PrintCollectionDefinition } from '@/lib/print-curation';

export function PrintConfigurator({
  design,
  usableVariantKeys,
  pricing,
  sel,
  onSelChange,
  definitions,
}: {
  design: PrintDesign;
  usableVariantKeys?: string[];
  pricing: PrintPricingConfig;
  sel: PrintVariantSelection;
  onSelChange: (sel: PrintVariantSelection) => void;
  definitions?: PrintCollectionDefinition[];
}) {
```

Find the two `{ id: design.id, num: design.num, variantLabel: variantLabel(sel, locale), price }`
object literals (inside `buildPrintRemoveFromCartEvent(...)` and
`buildPrintAddToCartEvent(...)`) and add `itemName` to each:

```typescript
{ id: design.id, num: design.num, variantLabel: variantLabel(sel, locale), price, itemName: printDisplayName(design, undefined, definitions) },
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Run the full test suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 7: Manual verification (client component behavior can't be fully covered by unit tests)**

Start the dev server, open a print PDP, add it to cart, open browser
devtools → check the pushed `dataLayer` event (or use
`localStorage.setItem('acc_analytics_debug', '1')` if this file's debug
flag gates console logging — check `analytics.ts` for how
`DEBUG_STORAGE_KEY` is used) and confirm `item_name` matches the CMS
collection's name, not a stale/fallback value.

- [ ] **Step 8: Commit**

```bash
git add src/components/shop/PrintPdpPurchase.tsx src/components/shop/PrintConfigurator.tsx
git commit -m "feat: resolve PDP add/remove-to-cart analytics name from the CMS"
```

---

### Task 6: Order invoices

**Files:**
- Modify: `src/lib/invoice.ts`
- Test: `src/lib/invoice.test.ts` (extend if it exists)

**Interfaces:**
- Consumes: `loadPrintCollectionDefinitions`, the `supabase` local
  variable `createInvoiceForOrder` already resolves internally
  (`deps?.supabase ?? getSupabaseAdmin()`).

- [ ] **Step 1: Read the current full file**

```bash
git -C . show HEAD:src/lib/invoice.ts
```

- [ ] **Step 2: Implement**

Add the import:

```typescript
import { loadPrintCollectionDefinitions } from './print-collections';
```

Find (inside `createInvoiceForOrder`, right after `const supabase = deps?.supabase ?? getSupabaseAdmin();`):

```typescript
  const stripe = deps?.stripe ?? getStripe();
  const supabase = deps?.supabase ?? getSupabaseAdmin();
```

replace with:

```typescript
  const stripe = deps?.stripe ?? getStripe();
  const supabase = deps?.supabase ?? getSupabaseAdmin();
  const definitions = await loadPrintCollectionDefinitions(supabase);
```

Find:

```typescript
        const design = registryPrintById(it.product_id);
        const printName = productNames['print'] ?? 'Fine-art print';
        label = (design ? printDisplayName(design, printName) : printName)
          + ` — ${variantLabel(variant, invoiceLocale)} (${variant.prodigiSku})`;
```

replace with:

```typescript
        const design = registryPrintById(it.product_id);
        const printName = productNames['print'] ?? 'Fine-art print';
        label = (design ? printDisplayName(design, printName, definitions) : printName)
          + ` — ${variantLabel(variant, invoiceLocale)} (${variant.prodigiSku})`;
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run the full test suite**

Run: `npm run test`
Expected: PASS — if `invoice.test.ts` mocks `deps.supabase`, confirm its
mock's `.from('collections')`/`.from('collection_drafts')` chains don't
error (they'll return empty via a real or mocked builder — add mock
support for these two tables if the existing test's fake Supabase client
doesn't already handle arbitrary `.from(table)` calls gracefully; read
the existing test file first to see its mocking style before assuming).

- [ ] **Step 5: Commit**

```bash
git add src/lib/invoice.ts
git commit -m "feat: resolve invoice line-item print names from the CMS"
```

---

### Task 7: Marketing conversion tracking

**Files:**
- Modify: `src/lib/marketing/conversions.ts`
- Test: `src/lib/marketing/conversions.test.ts` (extend if it exists)

**Interfaces:**
- Produces: `ConversionsDeps` gains an optional
  `loadDefinitions?: () => Promise<PrintCollectionDefinition[]>`,
  defaulting to a real implementation — matching this file's existing
  injectable-with-default pattern (`sendMeta`, `sendGa4`).

- [ ] **Step 1: Read the current full file**

```bash
git -C . show HEAD:src/lib/marketing/conversions.ts
```

- [ ] **Step 2: Implement**

Add the imports:

```typescript
import { getSupabaseAdmin } from '../supabase';
import { loadPrintCollectionDefinitions } from '../print-collections';
import type { PrintCollectionDefinition } from '../print-curation';
```

Find:

```typescript
export type ConversionsDeps = {
  loadOrder: (paymentIntentId: string) => Promise<ConversionOrder | null>;
  metaConfig?: MetaCapiConfig;
  ga4Config?: Ga4Config;
  sendMeta?: typeof sendMetaPurchase;
  sendGa4?: typeof sendGa4Purchase;
  appVersion?: string;
  appGitSha?: string;
};
```

replace with:

```typescript
export type ConversionsDeps = {
  loadOrder: (paymentIntentId: string) => Promise<ConversionOrder | null>;
  metaConfig?: MetaCapiConfig;
  ga4Config?: Ga4Config;
  sendMeta?: typeof sendMetaPurchase;
  sendGa4?: typeof sendGa4Purchase;
  appVersion?: string;
  appGitSha?: string;
  loadDefinitions?: () => Promise<PrintCollectionDefinition[]>;
};
```

Find:

```typescript
export async function sendPurchaseConversions(
  paymentIntentId: string,
  deps: ConversionsDeps,
): Promise<void> {
  const order = await deps.loadOrder(paymentIntentId);
  if (!order || !order.marketing || order.marketing.consent !== 'granted') return;
  if (order.status !== 'paid') return;
```

replace with:

```typescript
export async function sendPurchaseConversions(
  paymentIntentId: string,
  deps: ConversionsDeps,
): Promise<void> {
  const order = await deps.loadOrder(paymentIntentId);
  if (!order || !order.marketing || order.marketing.consent !== 'granted') return;
  if (order.status !== 'paid') return;

  const definitions = await (deps.loadDefinitions ?? (() => loadPrintCollectionDefinitions(getSupabaseAdmin())))();
```

Find:

```typescript
    if (item.variant) {
      const design = registryPrintById(item.product_id);
      return {
        item_id: item.product_id,
        item_name: design ? printDisplayName(design) : item.product_id,
```

replace with:

```typescript
    if (item.variant) {
      const design = registryPrintById(item.product_id);
      return {
        item_id: item.product_id,
        item_name: design ? printDisplayName(design, undefined, definitions) : item.product_id,
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run the full test suite**

Run: `npm run test`
Expected: PASS — existing tests that construct `deps` without
`loadDefinitions` fall back to the real
`loadPrintCollectionDefinitions(getSupabaseAdmin())`, which will attempt
a real Supabase call; if `conversions.test.ts` doesn't already mock
Supabase globally (check `vi.mock('../supabase', ...)` or similar in the
existing test file), add a `loadDefinitions: async () => []` stub to
each existing test's `deps` object to keep tests hermetic — read the
existing test file first (Step 1 covers this) to match its actual style.

- [ ] **Step 5: Commit**

```bash
git add src/lib/marketing/conversions.ts
git commit -m "feat: resolve purchase-conversion print item names from the CMS"
```

---

### Task 8: Product feed (Google/Meta)

**Files:**
- Modify: `src/lib/feed.ts`
- Test: `src/lib/feed.test.ts` (extend if it exists)

**Interfaces:**
- Consumes: `loadPrintCollectionDefinitions`, `getSupabaseAdmin()`.

- [ ] **Step 1: Read the current full file**

```bash
git -C . show HEAD:src/lib/feed.ts
```

- [ ] **Step 2: Implement**

Add the imports:

```typescript
import { getSupabaseAdmin } from './supabase';
import { loadPrintCollectionDefinitions } from './print-collections';
```

Find:

```typescript
async function buildPrintFeedItems(locale: FeedLocale): Promise<FeedItem[]> {
  const msg = LOCALE_MESSAGES[locale];
  const cur = currency(locale); // 'PLN' | 'EUR'
  const chargeable = locale === 'pl' ? 'pln' : 'eur'; // feeds never quote GBP
  const singular = (msg.product as Record<string, string>).print ?? 'Print';
  const country = SHIPPING_COUNTRY[locale] as PrintCountry;
  const designs = await getPrintDesigns(); // published only, CATALOG_SOURCE-aware
  const pricing = await getPrintPricingConfig(); // global price list, CATALOG_SOURCE-aware

  return designs.map((design) => {
    const title = printDisplayName(design, singular);
```

replace with:

```typescript
async function buildPrintFeedItems(locale: FeedLocale): Promise<FeedItem[]> {
  const msg = LOCALE_MESSAGES[locale];
  const cur = currency(locale); // 'PLN' | 'EUR'
  const chargeable = locale === 'pl' ? 'pln' : 'eur'; // feeds never quote GBP
  const singular = (msg.product as Record<string, string>).print ?? 'Print';
  const country = SHIPPING_COUNTRY[locale] as PrintCountry;
  const designs = await getPrintDesigns(); // published only, CATALOG_SOURCE-aware
  const pricing = await getPrintPricingConfig(); // global price list, CATALOG_SOURCE-aware
  const definitions = await loadPrintCollectionDefinitions(getSupabaseAdmin());

  return designs.map((design) => {
    const title = printDisplayName(design, singular, definitions);
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run the full test suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/feed.ts
git commit -m "feat: resolve product-feed print titles from the CMS"
```

---

### Task 9: Admin listings

**Files:**
- Modify: `src/lib/admin/content.ts`
- Modify: `src/lib/admin/products.ts`
- Modify: their calling Server Component pages (found in Step 1)

**Interfaces:**
- Consumes: `loadPrintCollectionDefinitions`, `adminSupabase()`
  (`src/lib/admin/clients.ts`).

- [ ] **Step 1: Read the current full files and find every caller**

```bash
git -C . show HEAD:src/lib/admin/content.ts
git -C . show HEAD:src/lib/admin/products.ts
git -C . grep -n "contentItems(" -- 'src/app/*'
git -C . grep -n "productRef(" -- 'src/*'
```

- [ ] **Step 2: Add `definitions` parameters**

In `src/lib/admin/content.ts`, find:

```typescript
export function contentItems(slug: string): ContentItem[] {
  if (slug === PRINT_PDP_SLUG) return [];
  if (slug === HOME_PAGE_SLUG) return [];
  if (slug === 'fine-art-prints') {
    return registryPrintDesigns().map((design) => ({
      id: design.id,
      label: printDisplayName(design, 'Druk'),
      image: design.image,
    }));
  }
```

replace with:

```typescript
export function contentItems(slug: string, definitions?: PrintCollectionDefinition[]): ContentItem[] {
  if (slug === PRINT_PDP_SLUG) return [];
  if (slug === HOME_PAGE_SLUG) return [];
  if (slug === 'fine-art-prints') {
    return registryPrintDesigns().map((design) => ({
      id: design.id,
      label: printDisplayName(design, 'Druk', definitions),
      image: design.image,
    }));
  }
```

(add `import type { PrintCollectionDefinition } from '@/lib/print-curation';`
alongside the existing `printDisplayName` import).

In `src/lib/admin/products.ts`, find the function containing
`label: \`${printDisplayName(print, CATEGORY_LABEL['fine-art-prints'])}${suffix}\`,`
(named `productRef` per the earlier investigation — confirm against the
actual file read in Step 1) and add a `definitions?: PrintCollectionDefinition[]`
parameter to its signature, passing it as the third argument to that
`printDisplayName(...)` call the same way.

- [ ] **Step 3: Update each calling Server Component page**

For each caller found in Step 1 (`getContentEditorState()`'s call to
`contentItems()`, and every `productRef()` call site — e.g.
`src/app/admin/inventory/page.tsx`, `src/app/admin/orders/[id]/page.tsx`,
`src/lib/admin/catalog-list.ts`, `src/lib/admin/fulfillment.ts`): add

```typescript
import { getSupabaseAdmin } from '@/lib/supabase';
import { loadPrintCollectionDefinitions } from '@/lib/print-collections';
```

load `const definitions = await loadPrintCollectionDefinitions(getSupabaseAdmin());`
once near that function's other data loading, and pass `definitions` into
the `contentItems(...)`/`productRef(...)` call. Since `src/lib/admin/catalog-list.ts`
and `src/lib/admin/fulfillment.ts` are themselves library functions (not
page components), thread `definitions` as a new parameter through them
too, loaded by whichever page ultimately calls them — read each file in
Step 1 to confirm its exact current signature before adding the
parameter, rather than guessing.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/admin/content.ts src/lib/admin/products.ts src/lib/admin/catalog-list.ts src/lib/admin/fulfillment.ts src/app/admin
git commit -m "feat: resolve admin listing print labels from the CMS"
```

---

### Task 10: Account order history

**Files:**
- Modify: `src/lib/account/items.ts`
- Modify: `src/app/[locale]/konto/page.tsx`
- Modify: `src/app/[locale]/konto/zamowienia/[id]/page.tsx`

**Interfaces:**
- Consumes: `loadPrintCollectionDefinitions`, `getSupabaseAdmin()`.

- [ ] **Step 1: Read the current full files**

```bash
git -C . show HEAD:src/lib/account/items.ts
git -C . show HEAD:"src/app/[locale]/konto/page.tsx"
git -C . show HEAD:"src/app/[locale]/konto/zamowienia/[id]/page.tsx"
```

- [ ] **Step 2: Add the parameter**

In `src/lib/account/items.ts`, add the import
`import type { PrintCollectionDefinition } from '@/lib/print-curation';`,
find:

```typescript
export function accountItemLabel(item: AccountOrderItem, t: Translate, locale: string): AccountItemLabel {
  if (item.variant != null) {
    const design = registryPrintById(item.product_id);
    return {
      key: `${item.product_id}-${JSON.stringify(item.variant)}`,
      name: design ? printDisplayName(design, t('product.print')) : item.product_id,
      detail: printDetail(item.variant, locale),
    };
  }
```

replace with:

```typescript
export function accountItemLabel(
  item: AccountOrderItem,
  t: Translate,
  locale: string,
  definitions?: PrintCollectionDefinition[],
): AccountItemLabel {
  if (item.variant != null) {
    const design = registryPrintById(item.product_id);
    return {
      key: `${item.product_id}-${JSON.stringify(item.variant)}`,
      name: design ? printDisplayName(design, t('product.print'), definitions) : item.product_id,
      detail: printDetail(item.variant, locale),
    };
  }
```

- [ ] **Step 3: Wire both account pages**

In each of `src/app/[locale]/konto/page.tsx` and
`src/app/[locale]/konto/zamowienia/[id]/page.tsx`, add:

```typescript
import { getSupabaseAdmin } from '@/lib/supabase';
import { loadPrintCollectionDefinitions } from '@/lib/print-collections';
```

load `definitions` alongside their existing `listAccountOrders()`/
`getAccountOrder()` calls (via `Promise.all` if there's already a
parallel-load pattern in that page — match its existing style, found in
Step 1), and pass it as the fourth argument everywhere `accountItemLabel(item, t, locale)`
is currently called.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/account/items.ts "src/app/[locale]/konto/page.tsx" "src/app/[locale]/konto/zamowienia/[id]/page.tsx"
git commit -m "feat: resolve account order-history print names from the CMS"
```

---

### Task 11: Cleanup

**Files:**
- Modify: `src/lib/print-curation.ts` (a documentation comment only — see
  the self-review correction below; nothing gets deleted in this task)

**Interfaces:** none.

**Self-review correction, made while writing this task:** the spec
originally framed this task as deleting
`config/print-catalog-curation.json` and `print-curation.ts`'s exports.
While writing the actual steps, that turned out to require a bigger,
separate decision — see Step 2 — so this task now only verifies and
documents, it does not delete. Flagging this explicitly since it's a real
change from what the spec promised, not a silent scope cut.

- [ ] **Step 1: Confirm every caller has migrated**

```bash
git grep -n "PRINT_COLLECTION_DEFINITIONS\|PRINT_CURATION\b\|ACTIVE_PRINT_CURATION\|RETIRED_PRINT_CURATION\|validatePrintCuration\|curationForProduct" -- 'src/*'
```

Expected: the only remaining hits should be inside `print-curation.ts`
itself (the default-parameter fallback values for `printDisplayName`/
`groupPrintDesigns`, which still need `PRINT_COLLECTION_DEFINITIONS` as
their default) and `catalog/seed.ts`'s `catalogStatusForPrint` call
(confirmed out of scope for both plans — `curationForProduct` stays, do
NOT remove it or the `RETIRED_PRINT_CURATION`/`ACTIVE_PRINT_CURATION`
exports it depends on). If anything else appears, that caller was missed
— stop and address it before proceeding; do not delete the file with a
live caller still depending on it.

- [ ] **Step 2: Remove only the genuinely dead grouping-definition machinery**

`validatePrintCuration`'s strict schema check
(`schemaVersion`/collection-name/product-id-universe validation) and
`PRINT_COLLECTION_DEFINITIONS`'s construction from the JSON stay in
`print-curation.ts` **as the default value** `printDisplayName`/
`groupPrintDesigns` fall back to when no explicit `definitions` argument
is passed — do not remove these; every one of this plan's changes is
additive/optional, and nothing forces removing the static fallback
itself. What actually becomes safe to delete is only
`config/print-catalog-curation.json` **if and only if** you also decide
to remove the fallback default and make `definitions` a required
parameter everywhere — which is a bigger, separate decision than "cleanup
after migration" and is explicitly NOT part of this plan (it would mean
every one of Plan 1 + Plan 2's ~20 call sites loses its safety-net
default). **Do not delete the JSON file or any export in this task** —
re-scope this task as: confirm the static file is no longer the ACTIVE
source of truth for any of the 20 call sites (verified via Step 1's
grep), leave it in place as the deliberate fallback/disaster-recovery
default, and document this decision.

- [ ] **Step 3: Document the final state**

Add a comment to the top of `config/print-catalog-curation.json`'s
sibling doc or `print-curation.ts` itself noting: as of this plan, every
real caller passes an explicit, CMS-loaded `definitions` array; this
file/the static exports remain only as the parameter defaults (used if a
caller is ever added without passing `definitions`, or if the CMS-backed
loader ever fails and a caller chooses to catch that and fall back). This
is a deliberate safety net, not dead code.

- [ ] **Step 4: Run the full test suite one final time**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/print-curation.ts
git commit -m "docs: clarify static print curation JSON's role as a fallback default post-migration"
```

---

## Self-Review Notes

- **Spec coverage:** every file from the spec's finalized Plan 2 list has
  a task — `CartView.tsx`/`cart-lines-server.ts` (Task 2), `analytics.ts`
  and its 4 client-component consumers (Tasks 1, 3, 4, 5), `invoice.ts`
  (Task 6), `marketing/conversions.ts` (Task 7), `feed.ts` (Task 8),
  `admin/content.ts`/`admin/products.ts` (Task 9), `account/items.ts`
  (Task 10), cleanup (Task 11). `catalog/seed.ts` needs no task
  (confirmed out of scope). `AddToCartButton.tsx`/`Gallery.tsx`/
  `ProductTile.tsx` need no task (confirmed ceramics-only).
- **Placeholder scan:** no TBD/TODO. Task 11 deliberately narrows its own
  original "delete the file" framing once the self-review surfaced that
  the static file is a load-bearing *default*, not dead code — this is a
  real design correction made during self-review, not a placeholder.
- **Type consistency:** `PrintCollectionDefinition` and the `itemName`/
  `nameOverride`/`nameOverrides` override pattern are used identically
  across every task; `CartLine`'s new `name: string` field (Task 2) is
  consumed only within Task 2 (CartView), matching Plan 1's precedent of
  keeping each task's new interface consumed by a known, bounded set of
  later steps.
