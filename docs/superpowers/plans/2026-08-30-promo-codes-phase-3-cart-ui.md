# Promo Codes — Phase 3: Cart UI + validate endpoint

> **For agentic workers:** Part of `2026-08-30-promo-codes-master.md` — master decisions/constraints binding. Depends on Phases 1–2. Worktree `feat/promo-codes`; commit per green step; self-review loop at the end.

**Goal:** Customers can enter a promo code on the shared cart page (`CartView` serves BOTH ceramics and prints), see the authoritative discount preview, and check out with it. Clear states for valid/invalid/expired/exhausted/wrong-track. Hermetic `@ci` e2e coverage.

**Files:**
- Create: `src/app/api/promo/validate/route.ts`
- Create: `src/app/api/promo/validate/route.test.ts`
- Modify: `src/components/shop/CartView.tsx` (+ its colocated CSS file)
- Modify: `messages/pl.json`, `messages/en.json`, `messages/es.json`, `messages/de.json`
- Create: `e2e/promo-code.spec.ts`
- Modify: `e2e/helpers/checkout.ts` (testid map additions)

**Interfaces:**
- Consumes: Phase 2's checkout contract (`promo_code` in POST body, `invalid_promo`/`promo_exhausted` errors, `discount` in success JSON); Phase 1 domain functions.
- Produces: `POST /api/promo/validate` with body `{ code: string, ids: string[] }` (ids = current cart tokens, ceramic ids or `print:` tokens; currency from the `currency_pref` cookie exactly like checkout). Responses: 200 `{ ok: true, code, discount: number /* minor units */ }`; 200 `{ ok: false, reason: PromoIneligibleReason }` (soft failure — deliberate 200 so the UI treats it as data, matching `/api/inventory`-style reads); 400 `{ error: 'invalid_request' }`; 429 rate-limited. Testids (Phase 7 + e2e rely on): `promo-input`, `promo-apply`, `promo-error`, `promo-discount-row`, `promo-remove`.

---

## Task 1: Validate endpoint (TDD)

- [ ] **Step 1: Write failing tests** in `src/app/api/promo/validate/route.test.ts` (mock style copied from `src/app/api/checkout/route.test.ts`): valid percent code on ceramic PLN cart → correct `discount`; fixed EUR code on print cart (cookie `currency_pref=eur`) → `amount_eur`; wrong-track / expired / unknown → `{ ok:false, reason }`; empty `ids` or malformed code → 400; rate limiter wired (reuse the `createCheckoutRateLimiter()` pattern — new instance, same module — to block promo-code enumeration; assert 429 after threshold like the checkout tests do).
- [ ] **Step 2: Run to fail**, then **implement** the route: derive currency from cookie (same helpers as checkout ~route.ts:70), `validateCart(ids, currency)` for the authoritative subtotal + track, compute shipping the same way checkout does **only** for the Stripe-minimum clamp input, then `fetchPromoByCode` → `checkPromoEligibility` → `computePromoDiscountMinor`. No DB writes, no reservation, no claim — preview only.
- [ ] **Step 3: Run to pass. Commit** — `git commit -m "feat(promo): rate-limited promo validate endpoint (preview only)"`

## Task 2: CartView integration

- [ ] **Step 1: Add the promo UI** to `CartView.tsx` in the summary block (near the `.sum-row` totals, ~879–890 — re-locate by the `sum-row` class, line numbers drift): an input + apply button (`data-testid="promo-input"` / `"promo-apply"`), collapsed behind a "Mam kod rabatowy" disclosure link per the cart's existing visual style. On apply: POST `/api/promo/validate` with current cart ids; on `ok:true` store `{ code, discount }` in component state **and** render a `.sum-row` discount line (`promo-discount-row`, negative amount via the same currency formatter the totals use) + updated total; on `ok:false` render the reason-specific message (`promo-error`). A `promo-remove` control clears it.
- [ ] **Step 2: Wire checkout** in `handleCheckout()` (~346): include `promo_code` in the POST body when applied. Handle new error responses: 400 `invalid_promo` / 409 `promo_exhausted` → clear the applied code, show the message, **do not** clear the rest of the checkout form (match how `unavailable`/409 conflicts are surfaced today). **Critical:** the applied code participates in the attempt identity — wherever cart-content changes currently regenerate `attemptId` (`acc_checkout_attempt_v1`), applying/removing/changing a code must ALSO regenerate it (Phase 2's Stripe idempotency key is amount-sensitive). Find the existing regeneration trigger and extend it; add a unit test in `src/lib/checkout-client.test.ts` if the attempt logic lives there.
- [ ] **Step 3: Client resilience:** if `/api/promo/validate` network-fails, show a retryable generic error and leave checkout usable without the code. The applied discount is display-only — the POST sends just the code string; totals shown after checkout success may re-sync from the response's `discount`.
- [ ] **Step 4: i18n** — add to all four `messages/*.json` under a `cart.promo` namespace: `label` ("Kod rabatowy"), `placeholder`, `apply`, `remove`, `discountRow` ("Rabat ({code})"), and reason messages `invalid`, `expired`, `notStarted`, `wrongTrackCeramics`, `wrongTrackPrints`, `exhausted`, `networkError`. Keep PL as the authored source; EN/ES/DE translated directly in the files (Notion sync is PL-only — memory note).
- [ ] **Step 5: Manual smoke** — `npm run dev`, add a ceramic piece, exercise the UI states by stubbing `/api/promo/validate` via browser devtools OR temporarily pointing the fetch at a mocked response; do NOT create promo rows in the DB (local env points at prod Supabase — master constraint). Verify layout on mobile width (390px iframe trick — memory note).
- [ ] **Step 6: Commit** — `git commit -m "feat(promo): cart promo entry, discount row and checkout wiring for both tracks"`

## Task 3: Hermetic e2e (`@ci`)

- [ ] **Step 1: Write `e2e/promo-code.spec.ts`** tagged `@ci`, following the interception pattern of `checkout-409.spec.ts` (intercept the app's OWN endpoints — never Stripe):
  - Case A (ceramics): seed cart via `addFirstUnsoldFromCategory`; `page.route('**/api/promo/validate', fulfill 200 { ok:true, code:'WELCOME10', discount:5750 })`; apply; assert `promo-discount-row` visible with formatted amount and total reduced; then `page.route('**/api/checkout', ...)` capture the request body and assert it contains `promo_code:'WELCOME10'` (fulfill 409 unavailable to end the flow cheaply, or fulfill a fake client_secret-free error — pick whichever the existing spec style supports without Stripe.js).
  - Case B (error state): fulfill `{ ok:false, reason:'expired' }` → assert `promo-error` shows the expired message and no discount row.
  - Case C (prints track): seed a print token via `appendToCart`; fulfill `ok:true`; assert the discount row renders in the print cart too.
- [ ] **Step 2: Add the new testids** to the `sel` map in `e2e/helpers/checkout.ts`.
- [ ] **Step 3: Run** the spec (Windows: serve manually on :3210 + `PLAYWRIGHT_BASE_URL`, per master constraints): `npx playwright test e2e/promo-code.spec.ts`. Read the actual output; fix until green.
- [ ] **Step 4: Commit** — `git commit -m "test(promo): hermetic e2e for promo entry across both cart tracks"`

## Acceptance checklist (phase self-review)

- [ ] The client never sends an amount — only the code string; the discount row is preview data from the server.
- [ ] Both tracks verified (ceramic + print carts) — the shared-CartView assumption re-checked against the actual `hasPrints` branching.
- [ ] Applying/removing a code regenerates `attemptId` (tested).
- [ ] Checkout promo errors clear the code but preserve the form; no-code flow pixel/behavior-identical to `main`.
- [ ] All 4 locales have every new key (run `npm run i18n:check` if it validates key parity).
- [ ] `npm run lint && npm run typecheck && npm run test` + the new e2e spec green; adversarial diff re-read done (watch for: forgotten `useTranslations` keys, hydration issues from the disclosure state, layout shift in the sticky CTA ~813–815).
