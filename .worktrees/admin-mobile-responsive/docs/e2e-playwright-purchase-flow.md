# E2E: Playwright purchase flow (Claude Code prompt)

Use this document as the task brief for Claude Code (or any agent) to implement and run Playwright checkout tests on the Anna Ciok Ceramics storefront.

## Scope and verdict

This plan is **strong enough for a first real E2E run** (release-gate / on-demand validation against the deployed storefront). It is **not yet deterministic enough for every PR in CI** without the enhancements below.

The main design principle: **separate what Playwright can assert from what an operator verifies manually.**

| Layer | Suitable for automation | Operator / manual only |
| --- | --- | --- |
| UI checkout path | Yes | — |
| Return page success | Yes | — |
| Cart cleared | Yes | — |
| `POST /api/checkout` status | Yes (network listener) | — |
| `/api/inventory` → `sold` (with retry) | Yes | — |
| Stripe Dashboard webhook delivery | No (unless Stripe API test helper exists) | Yes |
| Cloudflare Worker logs | No | Yes |
| InPost shipment / label follow-up | No | Yes |
| Real Geowidget map interaction | Flaky; real mode only | Optional headed run |

---

## Goal

1. Add **two different products from two different categories** to the cart (prove distinct categories from data).
2. Complete checkout with **Stripe test-mode card** payment.
3. Choose **InPost Paczkomat** and select a locker (real widget in release-gate mode; mocked selection in CI mode).
4. Finish payment and confirm success.
5. **Write a findings summary** that labels each check as **automated** or **manual verification**.

Terminology:

| User phrase | Meaning |
| --- | --- |
| Test drive | Stripe **test mode** |
| Patch command | **Paczkomat** (InPost parcel locker) |
| Central Warsaw | Locker in centrum / Śródmieście (`Warszawa`, `centrum`, `00-` in Geowidget search) |

---

## Test modes

### Real E2E release-gate mode (`@checkout @destructive`)

**Use for:** confidence before release; manual or scheduled runs — **not every PR.**

| Uses | Does not use |
| --- | --- |
| Deployed storefront (`https://anna-ciok.studio`) | Parallel workers for this spec |
| Real Stripe test-mode Payment Element | Fake Zustand `localStorage` shape |
| Real InPost Geowidget (headed recommended) | Asserting Stripe Dashboard from Playwright |
| Dashboard webhook endpoint (background) | Assuming instant inventory without retry |
| Real test inventory mutation (reservations, `sold`) | |

Run:

```bash
PLAYWRIGHT_BASE_URL=https://anna-ciok.studio npx playwright test e2e/purchase-two-categories-paczkomat.spec.ts --headed --grep @checkout
```

### Deterministic CI mode (`@checkout @ci`)

**Use for:** repeatability in CI; does not depend on third-party map/widget UI.

| Uses | Does not use |
| --- | --- |
| Deployed preview or local app (explicit `PLAYWRIGHT_BASE_URL`) | Real Geowidget map interaction |
| **Mocked/stubbed** locker selection (same event/callback the app listens for) | Live inventory mutation unless isolated test project |
| Stripe test mode **or** payment boundary stub (document which) | Stripe Dashboard checks |
| Seeded / API-driven unsold product picks | Headed-only assumptions |
| App-owned `data-testid` selectors | CSS-only selectors where testids exist |

Keep **one** separate scheduled job for real-widget release-gate mode.

---

## Hard requirements before coding

1. Add app-owned **`data-testid`** (and product metadata attributes) on critical checkout controls — see [App-owned selectors](#app-owned-selectors).
2. The **purchase happy-path spec** must run **serially** and must **not** run in parallel with itself.
3. The test must **record** selected product IDs, categories, prices, and locker code/name.
4. The test must **attach network evidence** for `/api/checkout` and `/api/inventory` (and log console/page errors).
5. Backend checks must be labelled **automated** or **manual verification** in the report — never claim Dashboard webhook delivery was “asserted by test” unless Stripe API access exists.
6. Implement **preflight** checks that fail fast on environment blockers.
7. Fix Stripe step order: fill card → click pay → wait for redirect → assert return page (see [Test scenario](#test-scenario)).

---

## Target environment

| Setting | Value |
| --- | --- |
| **Playwright `baseURL`** | `https://anna-ciok.studio` |
| **Canonical origin** | `SITE_URL` in `src/lib/site.ts` |
| **Alternate host** | `https://ceramics-drop.konrad-ciok.workers.dev` — only if Stripe Dashboard webhooks target this host |

```ts
// playwright.config.ts
use: {
  baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'https://anna-ciok.studio',
  trace: 'retain-on-failure',
  screenshot: 'only-on-failure',
  video: 'retain-on-failure',
},
// For @checkout @destructive project: workers: 1 in CI
```

```bash
PLAYWRIGHT_BASE_URL=https://anna-ciok.studio npx playwright test
```

Do **not** default to `http://localhost:3000` unless explicitly requested and webhooks are wired to that host.

**Locale:** Polish default — no `/pl` prefix. Cart: `/koszyk`, return: `/koszyk/return`.

---

## Repository context

| Area | Detail |
| --- | --- |
| Stack | Next.js 16, React 19, Zustand cart (`localStorage` key `acc_cart_v1`), Stripe Payment Element, InPost Geowidget v5 |
| Categories | `kubki`, `wazony`, `wazony-duze`, `talerzyki`, `talerze-duze`, `duze-michy`, `miski-falowane` |
| Cart UI | `src/components/shop/CartView.tsx`, `CheckoutForm.tsx`, `GeowidgetPicker.tsx` |
| Shipping (PLN) | Paczkomat **15**, kurier 75, odbiór 0 — `src/lib/pricing.ts` |
| Success UX | `/koszyk/return` + `payment_intent` `succeeded` → `return.okH`; cart cleared |
| Fulfillment truth | `POST /api/stripe/webhook` → `src/lib/webhook.ts` (return page alone is not enough) |

---

## App-owned selectors

Add to the app **before** relying on E2E (first pass can use CSS; migrate to testids):

| Location | Suggested attributes |
| --- | --- |
| `ProductTile` | `data-testid="product-tile"` `data-product-id` `data-category` `data-price` (grosze or PLN integer) |
| Add button | `data-testid="add-to-cart"` |
| Cart line | `data-testid="cart-line"` + `data-product-id` |
| Shipping Paczkomat | `data-testid="shipping-paczkomat"` |
| Selected locker | `data-testid="selected-locker"` (text = locker code/name) |
| Pre-payment checkout | `data-testid="checkout-button"` (today: `#checkout`) |
| Payment submit | `data-testid="payment-submit"` |
| Return success | `data-testid="checkout-success"` |

Playwright: prefer `getByTestId()` for app DOM; use [`frameLocator`](https://playwright.dev/docs/api/class-framelocator) for Stripe iframes only.

**Fallback selectors (first pass only):** `.tile-add`, `.tile:not(.sold)`, `.ship-opt`, `#checkout`, text “Zapłać teraz”.

---

## Webhooks (Stripe Dashboard — no local `stripe listen`)

Fulfillment is driven by Dashboard endpoints on the deployed Worker.

| Route | URL | Secret | Role |
| --- | --- | --- | --- |
| `POST /api/stripe/webhook` | `https://anna-ciok.studio/api/stripe/webhook` | `STRIPE_WEBHOOK_SECRET` | Fulfillment (paid, sold, invoice, shipment) |
| `POST /api/inpost/webhook?token=…` | `https://anna-ciok.studio/api/inpost/webhook?token=<INPOST_WEBHOOK_TOKEN>` | query `token` | Label/status (post-checkout logistics) |

**Handler events:** `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded` (full), `charge.dispute.closed` (`lost`).

Alternate webhook host: `https://ceramics-drop.konrad-ciok.workers.dev/...` if that is what the Dashboard uses.

---

## Preflight phase

Run **before** the destructive checkout flow; fail fast with clear blockers.

```ts
test.beforeEach(async ({ request, baseURL }) => {
  expect(baseURL).not.toMatch(/localhost/); // unless E2E_ALLOW_LOCALHOST=1

  const inventory = await request.get('/api/inventory');
  expect(inventory.ok()).toBeTruthy();
  const { sold } = await inventory.json();
  // Assert at least two unsold products exist in two different categories
  // (derive from catalogue + sold list, or from collection pages in preflight).
});
```

**Preflight checklist:**

- [ ] `GET /api/inventory` → 200
- [ ] ≥ 2 unsold products in **different** categories (data-driven, not hardcoded IDs)
- [ ] Client uses Stripe **test** publishable key (`pk_test_` in page source or env doc)
- [ ] Geowidget token present at build time **or** `E2E_GEOWIDGET_MODE=mock`
- [ ] `PLAYWRIGHT_BASE_URL` is intentional (default `https://anna-ciok.studio`)
- [ ] Synthetic buyer email (e.g. `e2e+playwright@example.com`)
- [ ] Purchase spec: `test.describe.configure({ mode: 'serial' })`; CI `workers: 1` for `@destructive`

**Cart reset** — do not write a fake Zustand persist blob (shape/version can change):

```ts
await page.addInitScript(() => {
  localStorage.removeItem('acc_cart_v1');
});
```

---

## Test scenario (happy path)

Record **product A** and **product B** as `{ id, category, price }` from the DOM or API. **Assert `categoryA !== categoryB`.** Assert both IDs appear in cart and (if automated backend check) both eventually appear in `sold`.

| Step | Action | Expected |
| --- | --- | --- |
| 1 | Preflight passes | ≥ 2 categories with unsold stock |
| 2 | `page.goto` category A; add first unsold piece | `categoryA`, `idA`, `priceA` recorded |
| 3 | Category B; add unsold piece | `categoryB !== categoryA`; `idB` recorded |
| 4 | `/koszyk` | Two `[data-testid="cart-line"]` (or `.cart-row`) with correct IDs |
| 5 | Shipping: **Paczkomat InPost** | Locker picker visible |
| 6 | Contact fields + locker | Checkout enabled; locker code on `[data-testid="selected-locker"]` |
| 7 | Click checkout (“Przejdź do płatności” / `data-testid="checkout-button"`) | `POST /api/checkout` → 2xx; Payment Element visible |
| 8 | Stripe iframe: **Card** | Card fields visible (`frameLocator`) |
| 9 | Fill `4242 4242 4242 4242`, future expiry, CVC | Fields accepted |
| 10 | Click **“Zapłać teraz”** / `data-testid="payment-submit"` | Submit triggered |
| 11 | Wait for navigation | URL `/koszyk/return` with `payment_intent_client_secret` |
| 12 | Assert success | `[data-testid="checkout-success"]` or `return.okH` copy; cart empty |
| 13 | Poll inventory (automated, with timeout) | `idA`, `idB` ∈ `sold` |
| 14 | *(Manual)* Stripe Dashboard | `payment_intent.succeeded` delivery **200** — **not** asserted by Playwright unless API helper exists |

### Stripe test card

[Stripe test cards](https://docs.stripe.com/testing): `4242 4242 4242 4242` — any future expiry, any 3-digit CVC — standard successful path.

**Order matters:** fill card → **then** submit → **then** wait for redirect → **then** assert return page. Do not list “redirect” before “Zapłać teraz”.

### Geowidget — real E2E mode

[InPost Geowidget](https://geowidget.inpost.pl/docs/index.html) is a third-party `<inpost-geowidget>` custom element (shadow DOM / iframes / map tiles). Expect flakes; use headed mode and generous timeouts.

- Wait for `inpost-geowidget` or app `selected-locker` testid
- Search Warsaw / centrum; pick a central locker
- On failure message “Wybór paczkomatu jest chwilowo niedostępny” → **environment blocker**

### Geowidget — deterministic CI mode

Do **not** drive the map UI. Inject the same selection the app expects, e.g. dispatch `onpoint` on the widget with `{ name: '<locker-code>', address: { line1: '...' } }` or call `GeowidgetPicker`’s `onSelect` via a test-only hook / `page.evaluate` after the element mounts.

Assert:

- `[data-testid="selected-locker"]` shows the code
- `#checkout` / `data-testid="checkout-button"` becomes enabled

Document the mock locker code used (e.g. a known sandbox point in Warsaw).

### Price assertions

- Assert **shipping line** separately: Paczkomat **15 zł** (or `15,00 zł` per `pln()` formatting).
- Assert **subtotal** = `priceA + priceB` (prefer `data-price` in grosze; compare integers).
- Assert **total** = subtotal + 15 PLN.
- Normalize PLN text if comparing rendered strings; prefer numeric attributes over scraped text.

---

## Spec structure and concurrency

```ts
test.describe('@checkout @destructive', () => {
  test.describe.configure({ mode: 'serial' });

  test('preflight inventory', async ({ request }) => { /* ... */ });

  test('purchase two categories via paczkomat + card', async ({ page }) => {
    // happy path only — keep focused
  });
});
```

Tag failure-path specs separately (`@checkout-edge`); do **not** merge into the long happy path.

---

## Network and error evidence

Attach listeners for the findings report:

```ts
const checkoutResponses: Array<{ url: string; status: number; body?: string }> = [];
const inventorySnapshots: { before: string[]; after: string[] } = { before: [], after: [] };

page.on('response', async (response) => {
  const url = response.url();
  if (url.includes('/api/checkout')) {
    checkoutResponses.push({
      url,
      status: response.status(),
      body: response.status() >= 400 ? await response.text().catch(() => '') : undefined,
    });
  }
});

page.on('pageerror', (err) => { /* collect */ });
page.on('console', (msg) => { if (msg.type() === 'error') /* collect */ });
```

**Record in report:**

- `POST /api/checkout` status + body on failure
- Return page final URL
- `GET /api/inventory` before/after (sold lists)
- Console / page errors
- Selected locker code, product IDs, categories, prices

---

## Automated vs manual verification

### Automated assertions (Playwright)

- [ ] UI path: two categories → cart → paczkomat → contact → locker → checkout CTA
- [ ] `POST /api/checkout` not 409/5xx
- [ ] Stripe card flow completes; URL reaches `/koszyk/return`
- [ ] Success UI + cart cleared (`localStorage` key removed or empty ids)
- [ ] `categoryA !== categoryB`; both product IDs in cart during flow
- [ ] Totals: subtotal + 15 PLN shipping = displayed total (numeric preferred)
- [ ] `/api/inventory`: purchased IDs in `sold` within timeout (e.g. 30–60s, retry)

### Manual / operator verification (report explicitly)

- [ ] Stripe Dashboard → Webhooks → `payment_intent.succeeded` → **200** *(manual verification)*
- [ ] Cloudflare Workers logs for `ceramics-drop` *(manual)*
- [ ] InPost shipment / label email *(manual, post-checkout)*
- [ ] Real Geowidget map pick *(manual confirmation in release-gate headed run)*

If Dashboard status is checked by a human, the report must say **“manual verification”**, not “asserted by test”.

---

## Adjacent specs (failure paths — separate files)

Do **not** fold these into the main purchase spec.

| Spec | Intent |
| --- | --- |
| `geowidget-unavailable.spec.ts` | Block script / missing token → blocker copy; checkout disabled |
| `checkout-409.spec.ts` | Route mock: `POST /api/checkout` → 409 → sold-out message; cart pruned |
| `stripe-decline.spec.ts` | Decline test card (e.g. `4000 0000 0000 0002`) → error shown; cart **not** cleared |

---

## Implementation requirements

1. **Files:** `e2e/purchase-two-categories-paczkomat.spec.ts`, `playwright.config.ts`, optional `e2e/helpers/`.
2. **Config:** `baseURL` default `https://anna-ciok.studio`; timeouts 60–90s for real Geowidget; artifacts `retain-on-failure`.
3. **Cart reset:** `localStorage.removeItem('acc_cart_v1')` in `addInitScript` — not a hand-rolled Zustand JSON string.
4. **Product pick:** dynamic via `/api/inventory` + catalogue; prove two categories in data.
5. **Tags:** `@checkout @destructive` (release-gate), `@checkout @ci` (mocked widget).
6. **CI:** do not run `@destructive` on every PR until inventory isolation or dedicated test project exists.

---

## Run commands

```bash
# Release-gate (real widget + Stripe + deployed site)
PLAYWRIGHT_BASE_URL=https://anna-ciok.studio npx playwright test e2e/purchase-two-categories-paczkomat.spec.ts --headed --grep @destructive

# CI-safe (after mock seam + testids exist)
E2E_GEOWIDGET_MODE=mock npx playwright test --grep @ci
```

---

## Deliverable: findings summary

Produce `e2e/REPORT.md` (or chat) with sections:

1. **Mode** — release-gate vs CI; `PLAYWRIGHT_BASE_URL`; headed yes/no
2. **Products** — `idA`, `idB`, `categoryA`, `categoryB`, prices; proof `categoryA !== categoryB`
3. **Delivery** — locker code/name; contact email
4. **Payment** — card used; return URL; PaymentIntent status if readable from return page query
5. **Automated checks** — pass/fail list (UI, checkout API, inventory sold, totals)
6. **Manual verification** — Dashboard webhook 200, Worker logs, InPost follow-up (Y/N/N/A)
7. **Network evidence** — checkout responses, inventory before/after, errors
8. **Result** — PASS / FAIL; failing step
9. **Artifacts** — trace, screenshot, video paths
10. **Flakes & recommendations** — Geowidget, Stripe iframes, test data, selector debt

Do **not** commit secrets. Use test keys and synthetic emails only.

---

## Out of scope

- BLIK / Przelewy24
- Courier (`kurier`) / studio pickup (`odbior`)
- EN/ES locales (default PL unless debugging)
- Local `stripe listen` (Dashboard webhooks)
- Claiming webhook Dashboard delivery without manual label or Stripe API

---

## Definition of done

- [ ] `data-testid` (or documented fallback) on critical checkout controls
- [ ] Happy-path spec runs serially against `https://anna-ciok.studio` in release-gate mode at least once
- [ ] Stripe step order correct; cart reset uses `removeItem`
- [ ] Report splits **automated** vs **manual verification**
- [ ] CI mode documented (Geowidget mock) even if not yet wired in pipeline
- [ ] Optional: edge specs for 409 / geowidget unavailable / decline card

---

## Related docs

- [cloudflare-deployment.md](./cloudflare-deployment.md) — production URL, Workers logs
- [analytics-stack.md](./analytics-stack.md) — `purchase` on return page
- [superpowers/plans/2026-06-02-stripe-payments.md](./superpowers/plans/2026-06-02-stripe-payments.md) — Stripe test cards
- [Stripe testing](https://docs.stripe.com/testing)
- [Playwright FrameLocator](https://playwright.dev/docs/api/class-framelocator)
- [InPost Geowidget docs](https://geowidget.inpost.pl/docs/index.html)
