# Analytics Identity, Testing & Governance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add customer identity to analytics, guard the event contract with CI, isolate/scrub Sentry, harden CSP, and give the Stripe webhook a proper event ledger.

**Architecture:** All browser analytics already funnel through one typed builder layer (`src/lib/analytics.ts` → `pushDataLayer`) into GTM; server conversions go direct to GA4 MP / Meta CAPI from the Stripe webhook. This plan threads *identity* (a fallback GA4 client_id at checkout; `login`/`sign_up` + `user_id` at auth) through those existing seams, wraps the Stripe webhook in the same `webhook_events` idempotency ledger Prodigi already uses, and adds the missing CI guards (an e2e dataLayer smoke, an ESLint ban on direct `gtag`/`fbq`, unit tests) plus CSP/Sentry hygiene — with **no** new frameworks and no change to the transport topology.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest, Playwright, Supabase, Sentry, Cloudflare Workers, GA4.

## Global Constraints
- Build MUST stay `next build --webpack` — never Turbopack.
- All analytics events go through `pushDataLayer()` in `src/lib/analytics.ts`; never call `gtag()`/`fbq()` directly in `src/` (this plan ADDS the ESLint rule enforcing it).
- Auth must never block payment; `/api/auth/*` fail-closed 404 unless `SUPABASE_PUBLISHABLE_KEY` set. `src/middleware.ts` must NOT be renamed to `proxy.ts`.
- New migrations go in `supabase/migrations/` with a timestamp prefix; preserve webhook idempotency/backward-compat.
- Unit tests: `npx vitest run <file>`. E2E: `npx playwright test <spec>` (@ci hermetic).

---

## File Structure

New files:

```text
src/components/analytics/AuthAnalytics.tsx              # G2 — one-shot login/sign_up dataLayer emitter (client island)
src/app/api/csp-report/route.ts                        # G5 — CSP violation-report sink (logs, 204)
src/lib/marketing/context.test.ts                      # G1 — resolveGaClientId unit tests
src/lib/sentry-options.test.ts                         # G4 — scrubSentryEvent unit tests
src/app/api/resend/webhook/route.test.ts               # G3+G7 — resend webhook route + bounce-alert tests
e2e/analytics-funnel.spec.ts                           # G3 — @ci dataLayer smoke + token-leak assertion
supabase/migrations/20260728120000_webhook_events_stripe.sql   # G6 — Stripe shares the ledger (hardening)
supabase/migrations/20260728120100_orders_resend_email_id.sql  # G7 — send-side email↔order correlation
```

Modified files:

```text
src/lib/marketing/context.ts                # G1 — resolveGaClientId() helper
src/app/api/checkout/route.ts               # G1 — persist fallback ga_client_id
src/lib/analytics.ts                        # G2 — buildLoginEvent / buildSignUpEvent
src/lib/auth/redirects.ts                   # G2 — AUTH_EVENT_COOKIE constant
src/app/api/auth/callback/route.ts          # G2 — set one-shot auth-event cookie on success
src/app/[locale]/layout.tsx                 # G2 — render <AuthAnalytics/>
eslint.config.mjs                           # G3 — ban direct gtag/fbq in src/
src/lib/analytics.test.ts                   # G3 — cover untested builders + new auth builders
src/lib/sentry-options.ts                   # G4 — beforeSend scrub + (env already read)
src/middleware.ts                           # G5 — Clarity hosts + report-to/report-uri
docs/cloudflare-deployment.md               # G4+G5 — preview SENTRY_ENVIRONMENT + CSP enforce runbook
src/app/api/stripe/webhook/route.ts         # G6 — webhook_events claim/mark-done wrapper
src/lib/email.ts                            # G7 — return Resend id from send helpers
```

---

## G1 — N-6: Fallback GA4 client_id so the server purchase is never silently skipped

**Problem.** `sendGa4Purchase` returns `{ ok:false, skipped:true }` when `clientId` is null (`src/lib/marketing/ga4-mp.ts:66`), and `conversions.ts:173-187` escalates that to a Sentry warning — the server-side revenue safety net is lost whenever Safari ITP / a cleared cookie leaves no `_ga`. `orders.marketing.ga_client_id` is captured once at checkout (`src/app/api/checkout/route.ts:365`, from the client-sent `_ga` value) and read by BOTH the purchase send (`conversions.ts:120`) and the refund send (`conversions.ts:239`). Fixing it at capture time therefore fixes both channels at the root.

**Decision (minimal):** persist a per-order fallback UUID when the real `_ga` client_id is absent. Not a first-party cookie — per-order is strictly less code and both send paths read the persisted value, so retries and refunds stay consistent. Documented caveat: a minted id cannot stitch that order to the visitor's other sessions/devices.

- [ ] **Add `resolveGaClientId` to `src/lib/marketing/context.ts`** (after `parseGaSessionId`, ~line 28):

```ts
/**
 * The GA4 client_id to persist for a checkout. Prefer the visitor's real `_ga`
 * client_id (already parsed from the cookie by the caller); when it is absent —
 * Safari ITP cleared `_ga`, or storage was denied — mint a per-order fallback so
 * the server-side GA4 MP purchase (the revenue safety net) still records instead
 * of skipping (see sendGa4Purchase in ga4-mp.ts / audit N-6). Caveat: a minted id
 * is unique to this order, so GA4 cannot stitch it to the visitor's other
 * sessions or devices.
 * ponytail: per-order fallback; upgrade to a first-party `acc_ga_cid` cookie only
 * if within-browser session stitching for cleared-cookie visitors ever matters.
 */
export function resolveGaClientId(fromCookie: string | null): string {
  return fromCookie ?? crypto.randomUUID();
}
```

- [ ] **Use it in `src/app/api/checkout/route.ts`.** Import `resolveGaClientId` from `@/lib/marketing/context` (the file already imports `MarketingContext` from there), and in the **`consent === 'granted'`** branch change line 365 from `ga_client_id: str2(mc.ga_client_id),` to:

```ts
          ga_client_id: resolveGaClientId(str2(mc.ga_client_id)),
```

Leave the `denied` branch (`ga_client_id: null`, line 376) unchanged — conversions never send under denied consent, so a fallback there would be dead code.

- [ ] **Test — create `src/lib/marketing/context.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import { resolveGaClientId } from './context';

describe('resolveGaClientId', () => {
  it('returns the real _ga client_id when present', () => {
    expect(resolveGaClientId('111.222')).toBe('111.222');
  });
  it('mints a non-empty fallback when absent (so GA4 MP is not skipped)', () => {
    const a = resolveGaClientId(null);
    const b = resolveGaClientId(null);
    expect(a).toBeTruthy();
    expect(a).not.toBe(b); // per-order, unique
  });
});
```

- [ ] **Verify:**

```bash
npx vitest run src/lib/marketing/context.test.ts
npm run typecheck
```

Expected: vitest `Test Files  1 passed`, `Tests  2 passed`; typecheck exits 0 with no output.

---

## G2 — N-7: `login`/`sign_up` events + GA4 `user_id`

**Problem.** `/api/auth/callback` (success at `src/app/api/auth/callback/route.ts:59-74`) and guest-order linking fire no analytics; no event carries `user_id`, so logged-in customers are indistinguishable from guests. The callback is server-side, so it can't push to `dataLayer` — hand the client a one-shot cookie the browser reads once.

**Decision (minimal):** emit a single `login`/`sign_up` event at the moment of auth, carrying `user_id` (the opaque Supabase user id — not PII). GTM maps `user_id` onto the GA4 config (ops sub-step below). Persistent per-page `user_id` for the whole session is explicitly out of scope (would need a client-readable id on every load) — noted as the upgrade path.

- [ ] **Add builders to `src/lib/analytics.ts`** (after `buildEngagementEvent`, ~line 368):

```ts
export type AuthMethod = 'google' | 'apple';

/**
 * login / sign_up dataLayer events. `user_id` is the opaque Supabase user id
 * (a random UUID, not PII) — emitted so GTM can set GA4's user_id for the
 * session; `method` is the OAuth provider. No ecommerce/meta payload.
 */
export function buildLoginEvent(method: AuthMethod, userId: string): DataLayerEvent {
  return { event: 'login', event_id: createEventId('login', userId), method, user_id: userId };
}

export function buildSignUpEvent(method: AuthMethod, userId: string): DataLayerEvent {
  return { event: 'sign_up', event_id: createEventId('sign_up', userId), method, user_id: userId };
}
```

- [ ] **Add the cookie name to `src/lib/auth/redirects.ts`** (alongside `AUTH_NEXT_COOKIE`). This module is pure string utils (no Supabase import), so it is safe to import from a client component:

```ts
/** One-shot, client-readable cookie the auth callback sets so the browser can
 *  emit a login/sign_up analytics event exactly once (AuthAnalytics.tsx). NOT
 *  httpOnly — the client must read it. Value: `<login|sign_up>:<method>:<userId>`. */
export const AUTH_EVENT_COOKIE = 'acc_auth_event';
```

- [ ] **Set the cookie on callback success — `src/app/api/auth/callback/route.ts`.** Import `AUTH_EVENT_COOKIE` from `@/lib/auth/redirects`. Replace the final `return finish(storedNext ?? KONTO_PATH, setCookies);` (line 74) with:

```ts
  const response = finish(storedNext ?? KONTO_PATH, setCookies);

  // One-shot analytics hint (N-7). The provider comes from Supabase's identity
  // metadata; created within ~60s of now ⇒ first-ever sign-in (sign_up) vs a
  // returning login — a heuristic that only ever mislabels a funnel event, never
  // blocks auth. Best-effort: a bad/absent provider just skips the event.
  // ponytail: created_at recency; swap for an explicit "new user" signal if
  // Supabase ever exposes one.
  const provider = data.user.app_metadata?.provider;
  if (provider === 'google' || provider === 'apple') {
    const isNew = Date.now() - new Date(data.user.created_at).getTime() < 60_000;
    response.cookies.set(AUTH_EVENT_COOKIE, `${isNew ? 'sign_up' : 'login'}:${provider}:${data.user.id}`, {
      httpOnly: false, // the client island must read it
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 120,
    });
  }
  return response;
```

- [ ] **Create the client island `src/components/analytics/AuthAnalytics.tsx`** (mirrors the existing `'use client'` effect pattern in `AnalyticsEvents.tsx`):

```tsx
'use client';

import { useEffect } from 'react';
import { buildLoginEvent, buildSignUpEvent, pushDataLayer, type AuthMethod } from '@/lib/analytics';
import { AUTH_EVENT_COOKIE } from '@/lib/auth/redirects';
import { readConsent } from '@/components/consent/consent-mode';

/**
 * Reads the one-shot `acc_auth_event` cookie the auth callback sets, emits the
 * login / sign_up dataLayer event (with user_id for GA4), then clears it — so a
 * later navigation never re-fires. No-op for anonymous traffic (no cookie).
 */
export function AuthAnalytics() {
  useEffect(() => {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${AUTH_EVENT_COOKIE}=([^;]+)`));
    if (!m) return;
    // Clear immediately so a refresh can't double-fire.
    document.cookie = `${AUTH_EVENT_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
    // Defense-in-depth for the durable `user_id`: a denied-consent visitor must
    // never have user_id / an auth event pushed. The rest of the app relies on
    // GTM tag-gating (Consent Mode); this is the extra belt because user_id is a
    // durable identifier. Cookie is still cleared above, so no re-fire later.
    if (readConsent(document.cookie) !== 'granted') return;
    const [kind, method, userId] = decodeURIComponent(m[1]).split(':');
    if (!userId || (method !== 'google' && method !== 'apple')) return;
    if (kind === 'sign_up') pushDataLayer(buildSignUpEvent(method as AuthMethod, userId));
    else if (kind === 'login') pushDataLayer(buildLoginEvent(method as AuthMethod, userId));
  }, []);
  return null;
}
```

- [ ] **Render it in `src/app/[locale]/layout.tsx`.** Add the import beside `AnalyticsEvents` (line 15) and render it next to `<AnalyticsEvents />` (line 92):

```tsx
import { AuthAnalytics } from '@/components/analytics/AuthAnalytics';
// ...
            <AnalyticsEvents />
            <AuthAnalytics />
```

- [ ] **Ops sub-step (GTM, no code):** in container `GTM-NPHLG9NR`, (a) confirm the `ACC - analytics dataLayer events` trigger's event-name regex matches `login` and `sign_up` (extend it if not), and (b) add a Data Layer Variable `user_id` and set the GA4 config tag's **User ID** field to it so authenticated hits carry `user_id`. Use `npm run gtm:list` / `scripts/gtm-api.mjs` per `docs/notion-i18n.md`-style workflow. **Limitation to document:** `user_id` is set at the login/sign_up moment (per session); persistent per-page-load `user_id` for the whole logged-in session is a follow-up (needs a client-readable id in the layout).

- [ ] **Tests** are added in G3 (the new builders join `analytics.test.ts`). The `AuthAnalytics` island's consent gate has no unit-test home (vitest runs `environment: 'node'`, no jsdom/RTL in the repo), so cover it in the G3a e2e spec instead: pre-seed cookies `ciok_consent=denied` + `acc_auth_event=login:google:u-e2e` via `context.addCookies`, load `/`, and assert **no** `login` event lands in the `acc_analytics_debug` buffer (denied-consent = no push); a `ciok_consent=granted` variant with the same auth cookie **does** emit exactly one `login`.

- [ ] **Verify:**

```bash
npm run typecheck
npm run lint
```

Expected: both exit 0. (A signed-in smoke against a real provider is manual — the automated coverage is the builder unit tests in G3.)

---

## G3 — F-19: analytics test + governance guards

Three independent deliverables: (a) an `@ci` e2e dataLayer smoke incl. token-leak; (b) an ESLint ban on direct `gtag`/`fbq`; (c) unit tests for the untested builders and the `resend/webhook` route.

### G3a — `@ci` dataLayer smoke + token-leak assertion

The debug mirror (`analytics.ts:443-469`) writes to `sessionStorage['acc_analytics_debug']` and `document.documentElement.dataset.accAnalyticsDebug` whenever `isDebugHost()` is true — which includes `localhost` even on the production build the `@ci` webServer serves (`playwright.config.ts:45` runs `npm run start`). The spec also reads `window.dataLayer` directly to assert no token leaks into a push (app-layer contract for N-1; the gtag-ambient leak itself is Plan 1's scope). **Cross-plan note:** Plan 1 (`2026-07-28-analytics-privacy-token-redaction.md`) ships the authoritative token-leak guard `e2e/analytics-token-leak.spec.ts` (URL-strip + no token in any dataLayer push **or** network request). If Plan 1 has already merged, keep this spec focused on the **event-sequence smoke** and drop the duplicate `?sale=` push assertion below to avoid two specs testing the same thing.

- [ ] **Create `e2e/analytics-funnel.spec.ts`:**

```ts
import { test, expect } from '@playwright/test';
import {
  resetCart,
  addFirstUnsoldFromCategory,
  goToCart,
  sel,
} from './helpers/checkout';

type DlEntry = Record<string, unknown>;

test.describe('@ci analytics dataLayer contract', () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test('cart funnel emits the expected event sequence', async ({ page }) => {
    await resetCart(page);
    // view_item_list fires on gallery render; add_to_cart on the tile click.
    const picked = await addFirstUnsoldFromCategory(page, 'kubki');
    expect(picked.id, 'a kubki tile must exist').toBeTruthy();
    await goToCart(page); // view_cart fires on cart render
    await expect(page.locator(sel.cartLine).first()).toBeVisible();

    // Read the app-event mirror (acc_analytics_debug — pushDataLayer writes it on
    // debug hosts incl. localhost, per analytics.ts) rather than raw dataLayer: it
    // holds ONLY app events, so the sequence and per-event counts are deterministic
    // (dataLayer also carries gtm.js/gtm.load/consent noise).
    const events = await page.evaluate(() => {
      const raw = sessionStorage.getItem('acc_analytics_debug');
      const buf = raw ? (JSON.parse(raw) as Array<{ event?: string }>) : [];
      return buf.map((e) => e.event ?? '').filter(Boolean);
    });
    // Funnel must fire IN ORDER and exactly once each: /kubki → view_item_list,
    // tile click → add_to_cart, /koszyk → view_cart. A duplicate or a missing
    // event makes this filtered slice differ from the exact sequence → fail.
    const funnel = events.filter((e) => ['view_item_list', 'add_to_cart', 'view_cart'].includes(e));
    expect(funnel).toEqual(['view_item_list', 'add_to_cart', 'view_cart']);
  });

  test('a capability token in the URL never lands in a dataLayer push', async ({ page }) => {
    const TOKEN = 'LEAKTEST-0000-1111';
    await page.goto(`/koszyk?sale=${TOKEN}`);
    await expect(page.locator('#cart-root')).toBeVisible();
    const dl = await page.evaluate(() => window.dataLayer ?? []);
    const leaked = (dl as DlEntry[]).some((e) => JSON.stringify(e).includes(TOKEN));
    expect(leaked, 'no dataLayer entry may contain the ?sale= token').toBe(false);
    // page_view's page_location must be redacted, proving the app-layer control fired.
    const pageView = (dl as DlEntry[]).find((e) => e.event === 'page_view');
    if (pageView) expect(String(pageView.page_location ?? '')).toContain('sale=redacted');
  });
});
```

- [ ] **Verify:**

```bash
rm -rf .next   # webServer only rebuilds when .next is missing (memory: playwright-webserver-stale-next)
npx playwright test e2e/analytics-funnel.spec.ts
```

Expected: `2 passed`. (If `kubki` is ever out of stock in the seed catalogue, switch the category to any stocked one — the ceramic registry always has kubki in code mode.)

### G3b — ESLint ban on direct `gtag`/`fbq`

The **only** current `gtag`/`fbq` references in `src/` are in `src/components/consent/consent-mode.ts` (verified: lines 15-16/26 are inside the CMP snippet string, line 49 is `window.gtag?.(...)`). That file is the documented, legitimate exception, so it gets a scoped override.

- [ ] **Edit `eslint.config.mjs`** — append two config objects after the `ignores` block:

```js
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'gtag', message: 'Use pushDataLayer() from src/lib/analytics.ts — never call gtag() directly.' },
        { name: 'fbq', message: 'Use pushDataLayer() from src/lib/analytics.ts — never call fbq() directly.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'gtag', message: 'Use pushDataLayer() — never call window.gtag() directly.' },
        { object: 'window', property: 'fbq', message: 'Use pushDataLayer() — never call window.fbq() directly.' },
        { object: 'globalThis', property: 'gtag', message: 'Use pushDataLayer() — never call globalThis.gtag() directly.' },
        { object: 'globalThis', property: 'fbq', message: 'Use pushDataLayer() — never call globalThis.fbq() directly.' },
      ],
      // no-restricted-globals/-properties above miss a call like `globalThis.gtag(...)`
      // or `window.fbq?.(...)`; this catches every member call of gtag/fbq on
      // window/globalThis (incl. optional-call `?.()`). NOTE: a fully aliased
      // reference (`const g = window.gtag; g();`) is inherently beyond static
      // lint — that gap is covered by code review, not this rule.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name=/^(window|globalThis)$/][callee.property.name=/^(gtag|fbq)$/]",
          message: 'Use pushDataLayer() from src/lib/analytics.ts — never call gtag()/fbq() via window/globalThis.',
        },
      ],
    },
  },
  {
    // The Consent Mode CMP is the one sanctioned direct-gtag caller (consent
    // signals are GTM-internal and never reach GA4/Meta as events). Its
    // `window.gtag?.(...)` is both a restricted property AND a restricted member
    // call, so both rules are disabled for this one file.
    files: ['src/components/consent/consent-mode.ts'],
    rules: { 'no-restricted-properties': 'off', 'no-restricted-syntax': 'off' },
  },
```

- [ ] **Verify the rule passes clean AND actually bites:**

```bash
npm run lint
```

Expected: `0 problems` on the current tree. Then temporarily add `window.gtag?.('event','x');` to any `src/` file *other* than `consent-mode.ts`, re-run `npm run lint`, and confirm it reports the `no-restricted-properties` error — then revert the probe line.

### G3c — Unit tests for untested builders

`analytics.test.ts` currently imports only `buildAddToCartEvent`, `buildBeginCheckoutEvent`, `buildEngagementEvent`, `buildPageViewEvent`, `buildPurchaseEvent`, `pushDataLayer`, `redactSensitiveUrl`, `toAnalyticsItem`. The remove/view/select/print/auth builders are untested.

- [ ] **Extend `src/lib/analytics.test.ts`** — add these imports and a describe block:

```ts
import {
  analyticsItemForId,
  buildLoginEvent,
  buildPrintAddToCartEvent,
  buildRemoveFromCartEvent,
  buildSelectItemEvent,
  buildSignUpEvent,
  buildViewItemEvent,
  buildViewItemListEvent,
} from './analytics';

describe('previously-untested builders', () => {
  it('remove_from_cart carries a single ceramic item and no meta', () => {
    const e = buildRemoveFromCartEvent(product('k01'), { currency: 'EUR' });
    expect(e.event).toBe('remove_from_cart');
    expect(e.ecommerce?.items).toHaveLength(1);
    expect(e.meta).toBeUndefined();
  });
  it('view_item wraps a ViewContent meta payload', () => {
    const e = buildViewItemEvent(product('k01'), { currency: 'EUR' });
    expect(e.event).toBe('view_item');
    expect(e.meta?.event_name).toBe('ViewContent');
  });
  it('view_item_list indexes items and carries list ids', () => {
    const e = buildViewItemListEvent([product('k01')], { itemListId: 'kubki', itemListName: 'Kubki' });
    expect(e.event).toBe('view_item_list');
    expect(e.ecommerce?.items[0].item_list_id).toBe('kubki');
    expect(e.ecommerce?.items[0].index).toBe(0);
  });
  it('select_item builds a single-item ecommerce payload', () => {
    expect(buildSelectItemEvent(product('k01')).event).toBe('select_item');
  });
  it('print add_to_cart uses the design id + variant label', () => {
    const e = buildPrintAddToCartEvent(
      { id: 'fap01', num: '1', variantLabel: 'A3 · framed', price: 220 },
      { currency: 'EUR' },
    );
    expect(e.ecommerce?.items[0].item_id).toBe('fap01');
    expect(e.ecommerce?.items[0].item_variant).toBe('A3 · framed');
    expect(e.meta?.content_ids).toEqual(['fap01']);
  });
  it('analyticsItemForId drops a print token with no priceOverride', () => {
    expect(analyticsItemForId('print:fap01:a3:satin:oak')).toBeNull();
    expect(analyticsItemForId('print:fap01:a3:satin:oak', 220)?.item_id).toBe('fap01');
  });
  it('login / sign_up carry method + user_id and no ecommerce', () => {
    const l = buildLoginEvent('google', 'u-123');
    expect(l.event).toBe('login');
    expect(l).toMatchObject({ method: 'google', user_id: 'u-123' });
    expect(l.ecommerce).toBeUndefined();
    expect(buildSignUpEvent('apple', 'u-9').event).toBe('sign_up');
  });
});
```

- [ ] The `resend/webhook` route test is created in **G7** (it asserts the bounce-alert behaviour this plan adds there); G3's obligation for it is satisfied by that file. If G7 is deferred, add a minimal `src/app/api/resend/webhook/route.test.ts` asserting the two fail-closed paths (500 when `RESEND_WEBHOOK_SECRET` unset; 400 on missing `svix-*` headers).

- [ ] **Verify:**

```bash
npx vitest run src/lib/analytics.test.ts
```

Expected: existing tests + the new `previously-untested builders` block all pass.

---

## G4 — F-16: Sentry environment isolation + `beforeSend` scrub

**Problem.** `getBaseSentryOptions()` (`src/lib/sentry-options.ts:15`) sets `environment = SENTRY_ENVIRONMENT ?? NODE_ENV`, so preview lands in `production`; there is no `beforeSend`, and `worker.ts:112,291` passes `extra: alert.sentry.extra` unscrubbed. All three init sites (`src/instrumentation-client.ts`, `src/sentry.server.config.ts`, `src/sentry.edge.config.ts`) spread `getBaseSentryOptions()`, so a single change here covers client + server + edge.

- [ ] **Add `scrubSentryEvent` to `src/lib/sentry-options.ts`** and wire it as `beforeSend`. Full new file body:

```ts
import type { BrowserOptions, EdgeOptions, NodeOptions } from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

const isDev = process.env.NODE_ENV === 'development';

/** The event type Sentry hands `beforeSend` — derived so we never guess the export name. */
type SentryEvent = Parameters<NonNullable<NodeOptions['beforeSend']>>[0];

const SCRUB_HEADERS = new Set(['cookie', 'authorization', 'x-forwarded-for']);
const MAX_EXTRA_STRING = 2_000;

/**
 * Strip request cookies + sensitive headers and truncate oversized `extra`
 * strings before an event leaves the process. The worker forwards
 * `extra: alert.sentry.extra` unscrubbed (worker.ts:112,291); this is the single
 * choke point that bounds it. Pure + exported for unit testing.
 */
export function scrubSentryEvent(event: SentryEvent): SentryEvent {
  if (event.request) {
    delete event.request.cookies;
    if (event.request.headers) {
      // Header names are case-insensitive — a runtime may deliver `Cookie` /
      // `Authorization` / `X-Forwarded-For` in any casing. Compare on a
      // lowercased key so none slip through, then delete by the original key.
      for (const key of Object.keys(event.request.headers)) {
        if (SCRUB_HEADERS.has(key.toLowerCase())) delete event.request.headers[key];
      }
    }
  }
  if (event.extra) {
    for (const [k, v] of Object.entries(event.extra)) {
      if (typeof v === 'string' && v.length > MAX_EXTRA_STRING) {
        event.extra[k] = `${v.slice(0, MAX_EXTRA_STRING)}…`;
      }
    }
  }
  return event;
}

/** Shared Sentry init options for all Next.js runtimes. */
export function getBaseSentryOptions(): Partial<NodeOptions & EdgeOptions & BrowserOptions> {
  if (!dsn) {
    return {};
  }

  return {
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    // Correlate every event with the release that shipped it. Inlined at build
    // from package.json (next.config.ts) — matches the source-map `release`.
    release: process.env.NEXT_PUBLIC_APP_VERSION,
    tracesSampleRate: isDev ? 1.0 : 0.1,
    sendDefaultPii: false,
    beforeSend: scrubSentryEvent,
    ignoreErrors: [
      // Android WebView GC artifact from GTM/GA4 keyboard telemetry — not our code.
      /Java object is gone/,
    ],
  };
}

export function isSentryEnabled(): boolean {
  return Boolean(dsn);
}
```

- [ ] **Test — create `src/lib/sentry-options.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import { scrubSentryEvent } from './sentry-options';

describe('scrubSentryEvent', () => {
  it('drops request cookies and sensitive headers regardless of casing', () => {
    const e = scrubSentryEvent({
      request: {
        cookies: { sb: 'secret' },
        // Mixed casing on purpose — case-insensitive scrub must still remove them.
        headers: { Cookie: 'x', Authorization: 'Bearer y', 'X-Forwarded-For': '1.2.3.4', 'x-ok': 'keep' },
      },
    } as never) as { request: { cookies?: unknown; headers: Record<string, string> } };
    expect(e.request.cookies).toBeUndefined();
    expect(e.request.headers.Cookie).toBeUndefined();
    expect(e.request.headers.Authorization).toBeUndefined();
    expect(e.request.headers['X-Forwarded-For']).toBeUndefined();
    expect(e.request.headers['x-ok']).toBe('keep');
  });
  it('truncates oversized extra strings but leaves short/non-strings', () => {
    const big = 'a'.repeat(5000);
    const e = scrubSentryEvent({ extra: { big, small: 'ok', n: 5 } } as never) as {
      extra: Record<string, unknown>;
    };
    expect((e.extra.big as string).length).toBeLessThan(big.length);
    expect(e.extra.small).toBe('ok');
    expect(e.extra.n).toBe(5);
  });
});
```

- [ ] **Ops sub-step (F-16, no code):** in Cloudflare Workers Builds, set `SENTRY_ENVIRONMENT=preview` on the **preview** build's environment variables and document it in `docs/cloudflare-deployment.md`. This isolates server + edge (worker) events — where the unscrubbed `extra` originates. The **browser** bundle only reports under `preview` if the preview env is exposed to the client build as a `NEXT_PUBLIC_`-prefixed value: to isolate browser events too, inline `NEXT_PUBLIC_SENTRY_ENVIRONMENT` in `next.config.ts` and read it in `getBaseSentryOptions` (`process.env.SENTRY_ENVIRONMENT ?? process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV`) plus set it on the preview build. If it is **not** exposed, `docs/cloudflare-deployment.md` MUST state explicitly that preview isolation covers server + edge events only and browser events still report under `production` (the client `process.env.SENTRY_ENVIRONMENT` is not inlined, so it falls back to `NODE_ENV`).

- [ ] **Verify:**

```bash
npx vitest run src/lib/sentry-options.test.ts
npm run typecheck
```

Expected: 2 tests pass; typecheck clean.

---

## G5 — F-11 + N-9: CSP — allowlist Clarity, add reporting, then enforce

**Problem.** `src/middleware.ts:69-80` emits `Content-Security-Policy-Report-Only` with no report sink and no `*.clarity.ms` in `script-src`/`connect-src` (would break Clarity on enforce). The middleware `matcher` excludes `/api` (`middleware.ts:160`), so a first-party `/api/csp-report` route is not itself CSP-processed.

- [ ] **Create the report sink `src/app/api/csp-report/route.ts`:**

```ts
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const MAX_REPORT_BYTES = 4_000;

/** Drop the query string / fragment from a report URI so a capability token in a
 *  document-uri / referrer / blocked-uri never reaches the logs. */
function redactUri(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return value.split(/[?#]/)[0]; // keep origin + path; drop ?query and #fragment
}

/**
 * CSP violation-report sink (report-only phase). Browsers POST either the legacy
 * `application/csp-report` body or the modern `application/reports+json` batch.
 * We log only a bounded, structured line (never the raw body) so violations are
 * observable in Workers logs before enforcing; no storage, no PII.
 */
export async function POST(req: Request) {
  try {
    // (a) Bound memory BEFORE buffering: a CSP report always carries a
    // Content-Length. Reject a missing/unparseable/over-limit length outright so
    // a hostile client can't stream an unbounded body — we only read a body we
    // already know is <= MAX_REPORT_BYTES.
    // ponytail: reports without Content-Length are dropped; browsers always send
    // it for CSP POSTs. Add a streamed byte-cap only if a real client omits it.
    const declared = Number(req.headers.get('content-length'));
    if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_REPORT_BYTES) {
      return new NextResponse(null, { status: 204 });
    }
    const raw = (await req.text()).slice(0, MAX_REPORT_BYTES);
    // (b) Parse only the fields we log and redact their query strings — never
    // console.log the raw body. Handle both report shapes.
    const parsed = JSON.parse(raw) as unknown;
    const reports = Array.isArray(parsed)
      ? parsed.map((r) => (r as { body?: Record<string, unknown> }).body ?? {})
      : [(parsed as { 'csp-report'?: Record<string, unknown> })?.['csp-report'] ?? {}];
    for (const r of reports) {
      console.log(JSON.stringify({
        event: 'csp_report',
        'document-uri': redactUri(r['document-uri'] ?? r['documentURL']),
        referrer: redactUri(r['referrer']),
        'blocked-uri': redactUri(r['blocked-uri'] ?? r['blockedURL']),
        'violated-directive': r['violated-directive'] ?? r['effectiveDirective'] ?? null,
      }));
    }
  } catch {
    // never throw — a malformed/oversized report must still 204
  }
  return new NextResponse(null, { status: 204 });
}
```

- [ ] **Update `SECURITY_HEADERS` in `src/middleware.ts`** — add the Clarity hosts (N-9) and the report directives; add a sibling `Reporting-Endpoints` header. Replace the `Content-Security-Policy-Report-Only` array + add the new key:

```ts
  'Reporting-Endpoints': 'csp="/api/csp-report"',
  // Report-only first so it can't break Stripe/GTM/GA/Meta/InPost/Clarity; tighten + enforce after observing reports.
  'Content-Security-Policy-Report-Only': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://js.stripe.com https://*.googletagmanager.com https://*.google-analytics.com https://connect.facebook.net https://geowidget.inpost.pl https://*.clarity.ms",
    "style-src 'self' 'unsafe-inline' https://geowidget.inpost.pl",
    "img-src 'self' data: https://*.google-analytics.com https://*.googletagmanager.com https://www.facebook.com https://*.clarity.ms",
    "connect-src 'self' https://api.stripe.com https://*.google-analytics.com https://*.googletagmanager.com https://api-shipx-pl.easypack24.net https://*.supabase.co https://*.clarity.ms",
    "frame-src https://js.stripe.com https://geowidget.inpost.pl",
    "font-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "report-uri /api/csp-report",       // legacy reporting (Safari/older Chromium)
    "report-to csp",                      // modern reporting group (Reporting-Endpoints)
  ].join('; '),
```

(Clarity is added to `img-src` too — it beacons via tracking pixels; harmless in report-only and one less report to triage.)

- [ ] **Update `middleware.test.ts`** if it asserts the CSP string shape — add expectations that `script-src`/`connect-src` contain `https://*.clarity.ms` and that a `report-uri /api/csp-report` directive is present. (Search for `Content-Security-Policy` in `src/middleware.test.ts`; extend the matching assertion.)

- [ ] **Verify (report-only phase):**

```bash
npx vitest run src/middleware.test.ts
npm run build
```

Expected: middleware tests pass; build succeeds. After deploy, confirm `csp_report` lines appear in Workers logs and that **no** legit first-party asset (GTM, GA, Stripe, InPost, Clarity, Supabase) is reported blocked.

- [ ] **GATED cutover step — enforce (do NOT run until the observation window is clean).** After ≥1–2 weeks of report-only with zero legitimate violations, change the header **key** in `SECURITY_HEADERS` from `'Content-Security-Policy-Report-Only'` to `'Content-Security-Policy'` (keep `report-uri`/`report-to` so violations stay visible), update the `middleware.test.ts` assertion to the enforced key, and document the flip + rollback (revert the key) in `docs/cloudflare-deployment.md`. Deploy behind a canary if available.

---

## G6 — F-18: Stripe `webhook_events` idempotency ledger

**Problem.** The Stripe webhook (`src/app/api/stripe/webhook/route.ts`) relies only on per-step CAS; there is no event-id ledger. Prodigi already uses `webhook_events` with `provider='prodigi'` (`src/server/prodigi/callbacks.ts:44-93`, table from migration `20260626120003_webhook_events.sql`). The table already supports a second provider structurally — the wrapper reuses `provider`, `provider_event_id`, `event_type`, `status`, `raw_json`, `processing_started_at`, `processed_at`. The wrapper mirrors the Prodigi lease/CAS: a `processing` row within a 5-minute lease is an active claim (deduped), and a stale lease is reclaimed atomically, so two concurrent deliveries can't both process the same event; the per-step CAS inside `handleStripeEvent` stays as the second line.

- [ ] **Migration `supabase/migrations/20260728120000_webhook_events_stripe.sql`** (hardens the shared dedup contract; adds no columns):

```sql
-- Stripe now shares the webhook_events idempotency ledger (provider='stripe'),
-- alongside Prodigi. The Stripe wrapper reuses the existing columns
-- (provider, provider_event_id, event_type, status 'processing'|'done',
-- raw_json, processed_at) — no new columns.
--
-- Harden the dedup contract BOTH providers depend on: a NULL provider_event_id
-- slips past the partial unique index (webhook_events_dedup, which is `where
-- provider_event_id is not null`) and would therefore never dedup. Both writers
-- always supply the provider's event id, so no legitimate row is NULL; add the
-- constraint NOT VALID so future writes are checked without a full-table
-- scan/lock on existing rows.
ALTER TABLE webhook_events
  ADD CONSTRAINT webhook_events_event_id_present
  CHECK (provider_event_id IS NOT NULL) NOT VALID;

COMMENT ON TABLE webhook_events IS
  'Inbound-webhook idempotency ledger, one row per (provider, provider_event_id). Providers: prodigi (leased CAS — server/prodigi/callbacks.ts) and stripe (leased CAS — app/api/stripe/webhook/route.ts).';
```

- [ ] **Wrap the handler in `src/app/api/stripe/webhook/route.ts`.** After `const supabase = getSupabaseAdmin();` (line 111) and BEFORE `await handleStripeEvent(...)`, insert the claim; after `handleStripeEvent` returns, mark done. The block:

```ts
  // Idempotency ledger (F-18): claim this Stripe event id once, mirroring the
  // Prodigi lease/CAS in src/server/prodigi/callbacks.ts (~L44-93). Statuses:
  //  - `done`                      → completed delivery, skip.
  //  - `processing` within lease   → a concurrent in-flight delivery owns it,
  //                                   skip (prevents concurrent double-processing).
  //  - `processing` past lease     → stale/abandoned; reclaim with a CAS on the
  //                                   old lease value so only one racer wins.
  // A mid-handler throw leaves the row `processing`; Stripe's retry (minutes–days
  // later, well past the lease) reclaims the stale lease and re-runs the
  // CAS-idempotent steps as no-ops.
  const STRIPE_LEASE_MS = 5 * 60 * 1000;
  const claimedAt = new Date().toISOString();
  const { data: seen } = await supabase
    .from('webhook_events')
    .select('id, status, processing_started_at')
    .eq('provider', 'stripe')
    .eq('provider_event_id', event.id)
    .maybeSingle();
  const seenRow = seen as { id: string; status: string; processing_started_at: string | null } | null;

  if (seenRow?.status === 'done') {
    return NextResponse.json({ received: true, deduped: true });
  }
  if (seenRow) {
    // Active (non-stale) processing lease ⇒ another delivery is mid-flight.
    if (seenRow.status === 'processing' && seenRow.processing_started_at) {
      const age = Date.now() - new Date(seenRow.processing_started_at).getTime();
      if (age < STRIPE_LEASE_MS) {
        return NextResponse.json({ received: true, deduped: true });
      }
    }
    // Reclaim a stale lease with a compare-and-swap on the prior lease value so
    // two racing deliveries can't both win (same shape as callbacks.ts).
    const claimUpdate = supabase
      .from('webhook_events')
      .update({ status: 'processing', processing_started_at: claimedAt })
      .eq('id', seenRow.id)
      .eq('status', seenRow.status);
    const claimCas = seenRow.processing_started_at === null
      ? claimUpdate.is('processing_started_at', null)
      : claimUpdate.eq('processing_started_at', seenRow.processing_started_at);
    const { data: claimed, error: casErr } = await claimCas.select('id').maybeSingle();
    if (casErr) throw new Error(`webhook_events claim failed: ${casErr.message}`);
    if (!claimed) return NextResponse.json({ received: true, deduped: true });
  } else {
    const { error: insErr } = await supabase.from('webhook_events').insert({
      provider: 'stripe',
      provider_event_id: event.id,
      event_type: event.type,
      raw_json: event as unknown,
      status: 'processing',
      processing_started_at: claimedAt,
    });
    // Unique violation (23505) = a concurrent delivery claimed it first — let that one own it.
    if (insErr && (insErr as { code?: string }).code === '23505') {
      return NextResponse.json({ received: true, deduped: true });
    }
    if (insErr) throw new Error(`webhook_events insert failed: ${insErr.message}`);
  }
```

Then, immediately AFTER the existing `await handleStripeEvent(event, { ... });` closes (before the final `return NextResponse.json({ received: true });`, line 692), add:

```ts
  const { error: doneErr } = await supabase
    .from('webhook_events')
    .update({ status: 'done', processed_at: new Date().toISOString() })
    .eq('provider', 'stripe')
    .eq('provider_event_id', event.id);
  // Fail the request if the completion write errors (F-18): a 200 here would tell
  // Stripe we're done while the ledger row is stuck `processing`. Throw instead so
  // the route 5xxes, Stripe retries, and the retry reclaims the (by-then stale)
  // lease and drives the row to `done` — the CAS-idempotent steps re-run as no-ops.
  if (doneErr) throw new Error(`webhook_events done update failed: ${doneErr.message}`);
```

Do **not** wrap `handleStripeEvent` in try/catch: a throw (e.g. `createShipment` re-throwing a retryable ShipX error) must still propagate so the route 5xxes and Stripe retries; the row stays `processing`, and the next delivery reclaims the stale lease (after `STRIPE_LEASE_MS`) and re-processes (per-step CAS makes completed steps no-ops).

- [ ] **Test — extend `src/app/api/stripe/webhook/route.test.ts`.** The suite swaps `supabaseImpl` per test with a `.from(table)`-returning fake. Add a small helper so each relevant test's fake answers `webhook_events`:
  - `.from('webhook_events').select('id, status, processing_started_at').eq().eq().maybeSingle()` → `{ data: null }` (fresh), `{ data: { status: 'done' } }` (done-dedup), or `{ data: { id: 'we_1', status: 'processing', processing_started_at: <ISO now> } }` (in-flight-dedup).
  - `.from('webhook_events').insert(...)` → `{ error: null }` (or `{ error: { code: '23505' } }` for the concurrent case).
  - the stale-lease CAS `.from('webhook_events').update(...).eq('id').eq('status').is|eq('processing_started_at').select('id').maybeSingle()` → `{ data: { id: 'we_1' } }` (reclaimed) or `{ data: null }` (lost the race → deduped).
  - the done-write `.from('webhook_events').update({status:'done',...}).eq().eq()` → `{ error: null }` (or `{ error: { message: 'boom' } }` for the done-error case).
  Add cases: (1) a `payment_intent.succeeded` whose ledger row is already `done` returns `{ deduped: true }` and does **not** invoke `markPaid` effects; (2) an **in-flight** `processing` row within the lease also returns `{ deduped: true }` and does **not** invoke `markPaid` (concurrent double-processing guard); (3) a fresh event inserts the row, processes, and ends by marking it `done`; (4) when the done-write errors the route throws / returns non-200 so Stripe retries (F-18). Reuse the existing `constructEventAsync.mockResolvedValue({ id: 'evt_1', type: 'payment_intent.succeeded', ... })` pattern.

- [ ] **Verify:**

```bash
npx vitest run src/app/api/stripe/webhook/route.test.ts
npm run typecheck
```

Expected: all webhook tests (existing + 2 new) pass. **Migration apply:** per repo memory, Workers deploy does NOT apply migrations — Supabase Branching git-sync does on merge. Before merge, sanity-check the SQL against a branch/local stack (`supabase migration up` on a local db, or apply on a preview branch) and confirm via `list_migrations`.

---

## G7 — F-13 (send-side): correlate a Resend send with its order

**Problem.** The inbound webhook records `email_id` (`src/app/api/resend/webhook/route.ts:86`) but the SEND side (`src/lib/email.ts`) discards the Resend response id, so a bounce can't be tied to an order. Persist `resend_email_id` at send time (beside the `confirmation_email_sent_at` claim — the customer order-confirmation is the highest-value bounce signal) and Sentry-alert on bounce/complaint with the `order_id`.

- [ ] **Migration `supabase/migrations/20260728120100_orders_resend_email_id.sql`:**

```sql
-- Correlate a Resend send with its order so an inbound bounce/complaint webhook
-- can name the affected order. Set at customer order-confirmation send time,
-- beside confirmation_email_sent_at; resolved by resend_email_id on the inbound
-- /api/resend/webhook. Nullable — pre-existing orders and non-confirmation sends
-- stay NULL.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS resend_email_id TEXT;
CREATE INDEX IF NOT EXISTS orders_resend_email_id_idx
  ON orders (resend_email_id) WHERE resend_email_id IS NOT NULL;
```

- [ ] **Return the Resend id from the send helpers in `src/lib/email.ts`.** Change `sendResendTemplate` and `sendResendHtml` to parse and return the id. For `sendResendTemplate`, replace the trailing `if (!res.ok) {...}` tail with:

```ts
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
  }
  const json = (await res.json().catch(() => null)) as { id?: string } | null;
  return { id: json?.id ?? null };
}
```

and change its signature to `Promise<{ id: string | null }>`. Apply the same two-line change (parse + return `{ id }`) to `sendResendHtml` inside its `try` (after the `!res.ok` throw, before the `finally`), changing its return type to `Promise<{ id: string | null }>`.

- [ ] **Bubble the id out of `emailOrderConfirmationToCustomer`** (only the confirmation email needs correlation). Change its return type to `Promise<{ id: string | null }>`; on the `if (!order.email) return;` early exit return `{ id: null }`; and `return await sendResendTemplate({...})` instead of `await sendResendTemplate({...})`. (Other `email.ts` senders may keep returning the id or `void` — they are unused by the claim path; TypeScript tolerates an ignored `{id}` return.)

- [ ] **Persist the id in `sendEmailOnceWithClaim` — `src/app/api/stripe/webhook/route.ts`.** Add an optional `idColumn` param and write it on success:

```ts
async function sendEmailOnceWithClaim(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orderId: string,
  column: 'studio_email_sent_at' | 'confirmation_email_sent_at',
  send: () => Promise<unknown>,
  idColumn?: 'resend_email_id',
): Promise<void> {
  // ...existing claim + retry loop, but capture the send result:
  //   const result = await send();
  //   sent = true;
  //   if (idColumn) {
  //     const emailId = (result as { id?: string | null } | undefined)?.id ?? null;
  //     if (emailId) {
  //       const { error: idErr } = await supabase
  //         .from('orders').update({ [idColumn]: emailId }).eq('id', orderId);
  //       // Don't silently drop a failed correlation write: without resend_email_id
  //       // the inbound bounce/complaint webhook (F-13) can't name this order. The
  //       // email already sent, so never rethrow — alert so it can be reconciled.
  //       // (Sentry is already imported at the top of this route.)
  //       if (idErr) {
  //         Sentry.captureMessage('resend_email_id persist failed', {
  //           level: 'warning',
  //           extra: { order_id: orderId, email_id: emailId, error: idErr.message },
  //         });
  //       }
  //     }
  //   }
}
```

Then at the confirmation-email call site (line 284) pass the new arg:

```ts
            await sendEmailOnceWithClaim(supabase, orderId, 'confirmation_email_sent_at', () =>
              emailOrderConfirmationToCustomer({
                order: { id: orderId, email: orderRowTyped.email, receiver_first_name: orderRowTyped.receiver_first_name },
                locale: orderRowTyped.locale ?? 'pl',
                kind: isPrintOnlyOrder ? 'print' : 'ceramic',
              }),
              'resend_email_id',
            );
```

Leave the studio-email call (line 277) unchanged — it goes to our own inbox, no bounce correlation needed.

- [ ] **Alert on bounce/complaint in `src/app/api/resend/webhook/route.ts`.** Add `import * as Sentry from '@sentry/nextjs';` at the top. Inside the `if (LOGGED_EVENT_TYPES.has(evt.type)) { ... }` block, after the existing `console.log`, append:

```ts
    if (evt.type === 'email.bounced' || evt.type === 'email.complained') {
      const emailId = evt.data.email_id ?? null;
      let orderId: string | null = null;
      if (emailId) {
        const { getSupabaseAdmin } = await import('@/lib/supabase');
        const { data } = await getSupabaseAdmin()
          .from('orders')
          .select('id')
          .eq('resend_email_id', emailId)
          .maybeSingle();
        orderId = (data as { id: string } | null)?.id ?? null;
      }
      // order_id is not PII (a UUID) — safe to attach, unlike the recipient address.
      Sentry.captureMessage(`resend ${evt.type}`, {
        level: 'warning',
        extra: { type: evt.type, email_id: emailId, order_id: orderId, bounce_type: bounce?.type ?? null },
      });
    }
```

(`getSupabaseAdmin` is imported lazily so the happy delivered/delayed path stays light.)

- [ ] **Test — create `src/app/api/resend/webhook/route.test.ts`** (also satisfies G3c's resend-route obligation). Mock `@opennextjs/cloudflare` (`getCloudflareContext` → `{ env: { RESEND_WEBHOOK_SECRET: 'whsec_x' } }`), `@/lib/resend-webhook` (`verifyResendSignature` → `true`, `parseResendEvent` → the test event), `@/lib/supabase` (`getSupabaseAdmin` → a fake whose `.from('orders').select().eq().maybeSingle()` resolves `{ data: { id: 'ord_1' } }`), and `@sentry/nextjs` (`captureMessage: vi.fn()`). Assert:
  - unset `RESEND_WEBHOOK_SECRET` → 500 `{ error: 'not_configured' }`.
  - missing `svix-*` headers → 400.
  - `email.bounced` with a matching `email_id` → 200, and `Sentry.captureMessage` called with `extra.order_id === 'ord_1'` and `extra.type === 'email.bounced'`.

- [ ] **Verify:**

```bash
npx vitest run src/app/api/resend/webhook/route.test.ts src/lib/email.test.ts
npm run typecheck
```

Expected: new resend-route tests pass; `email.test.ts` still passes (adjust its assertions if any asserted the old `void` return of `sendResendTemplate`); typecheck clean. Migration applies via Supabase Branching git-sync on merge (verify with `list_migrations`).

---

## Final verification (whole plan)

- [ ] `npm run lint` → 0 problems (ESLint gtag/fbq guard green).
- [ ] `npm run typecheck` → clean.
- [ ] `npx vitest run` → all unit suites pass (context, analytics, sentry-options, stripe webhook, resend webhook, email, middleware).
- [ ] `rm -rf .next && npx playwright test e2e/analytics-funnel.spec.ts` → 2 passed.
- [ ] `npm run build` → succeeds with `--webpack` (no Turbopack).
- [ ] Migrations present under `supabase/migrations/` with `20260728*` prefixes; confirm applied on the target branch via `list_migrations` before relying on `resend_email_id` / the Stripe ledger in prod.
- [ ] GTM ops sub-steps (G2 user_id mapping) and Cloudflare ops sub-steps (G4 `SENTRY_ENVIRONMENT=preview`, G5 CSP enforce cutover) tracked separately from the code merge — they are deploy-time, not build-time.
