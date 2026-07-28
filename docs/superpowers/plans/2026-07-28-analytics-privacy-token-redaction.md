# Analytics Privacy — URL Token & Secret Redaction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop private-sale tokens, CMS preview JWTs, and Stripe client secrets from reaching GA4/Meta via gtag's ambient `page_location`.

**Architecture:** Defense in depth. Layer 1 removes the capability token from `document.location` via `window.history.replaceState` on the three routes that own it (`/koszyk` reads `?sale=`, PDPs read `?preview=`, `/koszyk/return` reads `?payment_intent[_client_secret]=`), *after* the app has consumed it — starving gtag's ambient `page_location`, browser history, and the `Referer` header in one move. Layer 2 seeds a redacted `page_location` into the hand-written GA4 base tag (and keeps it fresh on SPA navigation via the GA4 bridge) so the GA4 auto-events that fire before React can `replaceState` (session_start/first_visit) never carry a raw token either. A Playwright `@ci` spec guards the invariant.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest, Playwright, Google Tag Manager (GTM-NPHLG9NR), Cloudflare Workers.

## Global Constraints
- Build MUST stay `next build --webpack` — never Turbopack.
- All analytics events go through `pushDataLayer()` in `src/lib/analytics.ts`; never call `gtag()`/`fbq()` directly in `src/`.
- Analytics uses MAJOR currency units; display currency comes from `useCurrency()` (client) / `orders.currency` (server), not the locale.
- Import `Link`/`useRouter` from `src/i18n/navigation.ts`, not `next/navigation`.
- Unit tests: `npx vitest run <file>`. E2E: `npx playwright test <spec>` (@ci hermetic localhost).
- Any GTM container change requires re-export to `docs/GTM-NPHLG9NR_v<N>.json` (container-change checklist, `docs/analytics-stack.md`).

---

## Source finding

This plan implements the **Phase 0 / N-1 (Critical)** fix from `docs/audits/analytics-architecture-audit-2026-07-28.md` (§6 "N-1", §8 task 0.1). The audit proved live (GA4 Data API, `pageLocation` dimension) that:
- `.../koszyk?sale=b3926c5d-…` — a complete private-sale token, **51 events**.
- `.../fine-art-prints/fap01?preview=eyJ…` — a CMS preview JWT.
- `.../koszyk/return?payment_intent=pi_…&payment_intent_client_secret=pi_…` — a Stripe **client secret**.

Root cause: `redactSensitiveUrl()` (`src/lib/analytics.ts:388`) only rewrites the app's *own* `page_view` payload (`buildPageViewEvent`, `:406-421`). gtag.js — loaded by the `ACC - GA4 base` tag with `send_page_view:false` (`scripts/gtm-api.mjs:282`) — independently attaches `page_location = document.location.href` (RAW) as a default parameter on every *other* event, which the app-layer redaction never touches. `SENSITIVE_QUERY_PARAMS` (`src/lib/analytics.ts:377-383`) already enumerates the five params: `order`, `payment_intent`, `payment_intent_client_secret`, `sale`, `preview`.

The two exposed `?sale=` tokens are already expired (audit §6 "Exploitability of what already leaked"), so **no piece-level rotation is needed** — but the mechanism leaks continuously, and the Stripe `client_secret` leaks in real time. Task 6 rotates `CMS_PREVIEW_SECRET` as hygiene.

---

## File Structure

New files:
- `src/lib/use-strip-url-token.ts` — `stripUrlParams()` (imperative) + `useStripUrlParams()` (mount hook). Shared by all three routes.
- `src/lib/use-strip-url-token.test.ts` — unit tests for `stripUrlParams()`.
- `src/components/shop/StripUrlToken.tsx` — client host component (`return null`) that calls the hook; mounted on the PDP (a server component that can't call the hook directly).
- `e2e/analytics-token-leak.spec.ts` — `@ci` regression guard.

Edited files:
- `src/components/shop/CartView.tsx` — call `useStripUrlParams(['sale'])`.
- `src/app/[locale]/(pdp)/[slug]/[id]/page.tsx` — render `<StripUrlToken names={['preview']} />` in both branches.
- `src/app/[locale]/koszyk/return/page.tsx` — call `stripUrlParams([...])` in a `.finally()` after `retrievePaymentIntent()` settles (resolve or reject).
- `scripts/gtm-api.mjs` — redact `page_location` in `ga4BaseHtml()` + refresh it in `ga4BridgeHtml()`.

Config / ops (no repo code):
- Publish GTM container + re-export `docs/GTM-NPHLG9NR_v14.json` (**keep** `_v13.json` — it is the committed rollback reference for Plan 6 `2026-07-28-gtm-native-tags-migration.md`, which ships after this plan; v13 and v14 coexist until then).
- Rotate `CMS_PREVIEW_SECRET` via `wrangler secret put`.

---

## Task 1 — Shared URL-token strip primitive (TDD)

Layer-1 core. A pure `stripUrlParams()` (used imperatively by the return page, where the strip must be *deferred* until after the Stripe retrieve) plus a `useStripUrlParams()` mount hook (used by `/koszyk` and the PDP, where the server already consumed the param before the client mounts).

- [ ] **Write the failing test** `src/lib/use-strip-url-token.test.ts`. Mirrors the `vi.stubGlobal('window', …)` pattern already used for `pushDataLayer` in `src/lib/analytics.test.ts:308-360` (Vitest runs in the `node` environment — there is no jsdom; stub `window` by hand):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripUrlParams } from './use-strip-url-token';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stub window.location.href + a history.replaceState spy; returns the spy. */
function stubLocation(href: string) {
  const replaceState = vi.fn();
  vi.stubGlobal('window', {
    location: { href },
    history: { state: { k: 'v' }, replaceState },
  });
  return replaceState;
}

describe('stripUrlParams', () => {
  it('removes a present param and preserves path + other params', () => {
    const replaceState = stubLocation(
      'https://anna-ciok.studio/koszyk?sale=LEAKTEST123&foo=1',
    );
    stripUrlParams(['sale']);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith({ k: 'v' }, '', '/koszyk?foo=1');
  });

  it('removes multiple params (the Stripe return page)', () => {
    const replaceState = stubLocation(
      'https://anna-ciok.studio/koszyk/return?payment_intent=pi_123&payment_intent_client_secret=pi_123_secret_x',
    );
    stripUrlParams(['payment_intent', 'payment_intent_client_secret']);
    expect(replaceState).toHaveBeenCalledWith({ k: 'v' }, '', '/koszyk/return');
  });

  it('is a no-op when no target param is present', () => {
    const replaceState = stubLocation('https://anna-ciok.studio/kubki/k01');
    stripUrlParams(['preview']);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('does nothing on the server (no window)', () => {
    // afterEach unstubbed window → typeof window === 'undefined' here.
    expect(() => stripUrlParams(['sale'])).not.toThrow();
  });
});
```

- [ ] **Run it — expect failure** (module does not exist yet):

```bash
npx vitest run src/lib/use-strip-url-token.test.ts
```

Expected output (fails to import):

```
FAIL  src/lib/use-strip-url-token.test.ts [ src/lib/use-strip-url-token.test.ts ]
Error: Failed to load url ./use-strip-url-token (resolved id: ./use-strip-url-token) ...
```

- [ ] **Implement** `src/lib/use-strip-url-token.ts`:

```ts
'use client';

import { useEffect } from 'react';

/**
 * Remove the given query params from the current URL in place, via
 * history.replaceState (no navigation, no re-render). Next 16's App Router keeps
 * its internal state in sync with native history.replaceState, so this is safe
 * to call from a client component. No-op on the server, or when none of the
 * params are present.
 *
 * Used to scrub capability tokens (?sale=, ?preview=,
 * ?payment_intent[_client_secret]=) from document.location AFTER the app has
 * read them, so gtag's ambient page_location, browser history, and the Referer
 * header never carry the secret. See the N-1 finding in
 * docs/audits/analytics-architecture-audit-2026-07-28.md.
 */
export function stripUrlParams(names: readonly string[]): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const name of names) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      changed = true;
    }
  }
  if (!changed) return;
  window.history.replaceState(
    window.history.state,
    '',
    `${url.pathname}${url.search}${url.hash}`,
  );
}

/**
 * Client hook: strip the given capability-token params from the URL once, on
 * mount — after the server component that owns the route has already read them.
 * The name list is a per-call-site literal, so the effect deliberately runs once.
 */
export function useStripUrlParams(names: readonly string[]): void {
  useEffect(() => {
    stripUrlParams(names);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
```

- [ ] **Run it — expect pass:**

```bash
npx vitest run src/lib/use-strip-url-token.test.ts
```

Expected output:

```
 ✓ src/lib/use-strip-url-token.test.ts (4 tests)
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

- [ ] **Typecheck:** `npm run typecheck` → exits 0, no errors.
- [ ] **Commit:** `fix(analytics): add URL capability-token strip primitive (N-1)`

---

## Task 2 — Strip `?sale=` on `/koszyk` and `?preview=` on the PDP

Wire the mount hook into the two routes whose token is consumed server-side before the client renders. `CartView` is already a client component and reads the token from a server prop (`propSaleToken`), never from the URL — so stripping the client URL cannot break private-sale mode. The PDP `page.tsx` is a server component, so it needs the tiny `StripUrlToken` client host.

### 2a — `/koszyk` (CartView)

- [ ] Add the import to `src/components/shop/CartView.tsx`, immediately after `import { Link } from '@/i18n/navigation';` (line 17):

```ts
import { useStripUrlParams } from '@/lib/use-strip-url-token';
```

- [ ] Add the hook call inside `CartView`, immediately after `const saleToken = propSaleToken ?? null;` (line 148):

```ts
  // N-1: scrub the single-use ?sale= token from the URL now that the server has
  // handed it to us as a prop — keeps it out of gtag's ambient page_location,
  // browser history, and the Referer header. Private-sale mode is already seeded
  // from propSaleToken, so a later hard reload intentionally drops to the normal cart.
  useStripUrlParams(['sale']);
```

### 2b — PDP (`ProductPageScreen` + `PrintProductScreen` both live under one server `page.tsx`)

- [ ] Create `src/components/shop/StripUrlToken.tsx`:

```tsx
'use client';

import { useStripUrlParams } from '@/lib/use-strip-url-token';

/**
 * Renders nothing; strips the named capability-token params from the URL on
 * mount. A client host for server components (the PDP) that can't call the
 * useStripUrlParams hook directly. See the N-1 finding in
 * docs/audits/analytics-architecture-audit-2026-07-28.md.
 */
export function StripUrlToken({ names }: { names: readonly string[] }) {
  useStripUrlParams(names);
  return null;
}
```

- [ ] Add the import to `src/app/[locale]/(pdp)/[slug]/[id]/page.tsx`, immediately after `import { PrintProductScreen } from '@/components/shop/PrintProductScreen';` (line 13):

```ts
import { StripUrlToken } from '@/components/shop/StripUrlToken';
```

- [ ] In the print branch, insert `<StripUrlToken>` immediately after the opening `<main>` of the print return (before `<JsonLd>` at line 106):

```tsx
    return (
      <main>
        <StripUrlToken names={['preview']} />
        <JsonLd
          data={printProductSchema({
```

- [ ] In the ceramic branch, insert `<StripUrlToken>` immediately after the opening `<main>` of the final return (before `<JsonLd>` at line 141):

```tsx
  return (
    <main>
      <StripUrlToken names={['preview']} />
      <JsonLd
        data={productSchema({
```

- [ ] **Verify build + lint + types** (no unit test — this is wiring; Task 5's e2e is the behavioural gate):

```bash
npm run lint && npm run typecheck
```

Expected: both exit 0.

- [ ] **Manual smoke** (optional, before Task 5 exists): `npm run dev`, open `http://localhost:3000/koszyk?sale=SMOKE1` — the address bar should read `/koszyk` (no query) within a moment; open `http://localhost:3000/kubki/k01?preview=SMOKE2` — address bar should read `/kubki/k01`.

**Regression note (accepted behaviour change):** after arriving via a private-sale link, a *manual hard reload* of `/koszyk` now drops private-sale mode (the URL no longer carries `?sale=`, so the server re-renders the normal cart). This is inherent to the fix — the token is single-use and the whole point is to not persist it in the URL. Client-side interaction within the session is unaffected (the bundle is already in `CartView` state). If reload-resilience is later required, stash the token in `sessionStorage` before stripping and rehydrate — `sessionStorage` is not captured by gtag's ambient `page_location`. Not built now (YAGNI).

- [ ] **Commit:** `fix(analytics): strip ?sale=/?preview= from URL after consumption (N-1)`

---

## Task 3 — Strip Stripe params on `/koszyk/return` (deferred until after retrieve)

`src/app/[locale]/koszyk/return/page.tsx` is a client component. Its effect reads `payment_intent_client_secret` from `window.location.search` into a local (`secret`, line 29), then calls `stripe.retrievePaymentIntent(secret)`. The strip must run **after** that call settles — placed in a `.finally()` on the promise chain so it fires whether the retrieve resolves OR rejects (a reject would otherwise skip the strip and leave the secret in the URL). If the URL were stripped on mount and the user refreshed while the retrieve was still in flight, the reloaded page would have no secret to recover the intent (audit §6, "Regression risk: medium on /koszyk/return").

- [ ] Add the import to `src/app/[locale]/koszyk/return/page.tsx`, immediately after `import { buildEngagementEvent, pushDataLayer } from '@/lib/analytics';` (line 16):

```ts
import { stripUrlParams } from '@/lib/use-strip-url-token';
```

- [ ] Append a `.finally()` to the `stripePromise` chain — after the existing `.catch(...)` (`src/app/[locale]/koszyk/return/page.tsx:86-89`) — so the scrub fires once the chain settles, whether the retrieve resolved, rejected, or bailed at the early `!secret || !stripe` return. The success `switch` is untouched:

```ts
      .catch((err) => {
        Sentry.captureException(err, { level: 'warning', tags: { context: 'stripe_return_load' } });
        setStatus('fail');
      })
      .finally(() => {
        // N-1: the client secret has now been consumed — scrub
        // payment_intent[_client_secret] from the URL so a late gtag hit, browser
        // history, or the Referer header never carries it. In .finally so it fires
        // whether the retrieve resolved OR rejected (a reject skips the switch but
        // must still scrub); the chain has already settled, so a refresh during the
        // in-flight window could still have recovered the intent.
        stripUrlParams(['payment_intent', 'payment_intent_client_secret']);
      });
```

- [ ] **Verify build + lint + types:**

```bash
npm run lint && npm run typecheck
```

Expected: both exit 0.

- [ ] **Commit:** `fix(analytics): strip Stripe return params after retrievePaymentIntent (N-1)`

---

## Task 4 — Belt-and-braces: redact `page_location` at the GA4 layer (GTM container change)

Layer 1 removes the token from the URL, but GA4 auto-events `session_start`/`first_visit` fire at gtag load — potentially *before* React runs the `replaceState` effect. Seed a redacted `page_location` into the hand-written GA4 config so those pre-mount hits are clean too, and keep it fresh on SPA navigation via the GA4 bridge so later auto-events inherit the current page's redacted URL rather than a stale config value.

### 4a — Code edits to `scripts/gtm-api.mjs`

- [ ] Replace `ga4BaseHtml()` (currently `scripts/gtm-api.mjs:276-290`) with:

```js
function ga4BaseHtml(measurementId) {
  return `<script>
(function(w,d,s,id){
  w.dataLayer = w.dataLayer || [];
  w.gtag = w.gtag || function(){ w.dataLayer.push(arguments); };
  // N-1 belt-and-braces: gtag attaches page_location=document.location as a
  // default param on EVERY event, incl. GA4 auto-events (session_start/
  // first_visit) that fire before the app can history.replaceState the token
  // away. Seed a redacted page_location at config time so those never carry
  // ?order=/?payment_intent[_client_secret]=/?sale=/?preview=. Keep this key
  // list in sync with SENSITIVE_QUERY_PARAMS in src/lib/analytics.ts.
  function redactLocation(href){
    try {
      var u = new URL(href);
      var keys = ['order','payment_intent','payment_intent_client_secret','sale','preview'];
      var changed = false;
      for (var i=0;i<keys.length;i++){ if(u.searchParams.has(keys[i])){ u.searchParams.set(keys[i],'redacted'); changed = true; } }
      return changed ? u.toString() : href;
    } catch(e){ return d.location.origin + d.location.pathname; } // parse failed: drop query/hash, never re-leak the raw href
  }
  w.gtag('js', new Date());
  w.gtag('config', id, { send_page_view: false, page_location: redactLocation(d.location.href) });
  var firstScript = d.getElementsByTagName(s)[0];
  var tag = d.createElement(s);
  tag.async = true;
  tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
  firstScript.parentNode.insertBefore(tag, firstScript);
})(window, document, 'script', '${measurementId}');
</script>`;
}
```

- [ ] In `ga4BridgeHtml()` (currently `scripts/gtm-api.mjs:350-375`), insert a sticky-refresh block immediately after the `user_data` block and before `window.gtag('event', payload.event, params);` (line 372). The bridge already copies the app's already-redacted `page_location` into `params` for the `page_view` event; promote it to a default so subsequent auto-events inherit the *current* page's redacted URL instead of the stale config-time value:

```js
  if (payload.user_data && payload.user_data.em) {
    window.gtag('set', 'user_data', { sha256_email_address: payload.user_data.em });
  }
  // N-1: on SPA navigation the app fires page_view with an already-redacted
  // page_location; promote it to a gtag default so later GA4 auto-events on this
  // page inherit the current redacted URL, not the stale config-time seed.
  if (payload.event === 'page_view' && params.page_location) {
    window.gtag('set', { page_location: params.page_location });
  }
  window.gtag('event', payload.event, params);
```

- [ ] **Verify the snippet is syntactically valid** (the file is ESM; `node --check` parses it without executing the top-level `await`-driven auth):

```bash
node --check scripts/gtm-api.mjs && echo OK
```

Expected output: `OK`.

- [ ] **Commit the code edit** (separately from the export in 4c, but push the export in the same PR): `fix(analytics): redact page_location in GA4 base + bridge tags (N-1)`

### 4b — Publish the container (Container Change Checklist, `docs/analytics-stack.md:137-144`)

Requires the `gtm-api-deploy` service-account key (`.secrets/gtm-api-deploy.json`; `npm run gtm:key` mints it — it already has `tagmanager.publish`, `scripts/gtm-api.mjs:20`). The `NEXT_PUBLIC_*` and `GTM_*` env vars must be set (`.dev.vars`/shell).

- [ ] Read the container coordinates:

```bash
npm run gtm:list
```

Expected output includes a line like:

```
  <container name> | containerId=<id> | publicId=GTM-NPHLG9NR
```

Note the `containerId` and its `accountId` (printed on the parent `account …` line) — export them as `GTM_CONTAINER_ID` / `GTM_ACCOUNT_ID` for the setup step (`scripts/gtm-api.mjs:73-74`).

- [ ] **Preview first, then publish** (the setup script upserts all four `ACC - *` tags and only publishes with `--publish`, `scripts/gtm-api.mjs:131`):

```bash
npm run gtm:setup -- --publish
```

Expected output ends with (version number will be 14 if current live is 13):

```
Workspace ready: ACC analytics stack (accounts/.../workspaces/...)
Created/updated GTM tags: GA4 base, Meta base, GA4 bridge, Meta bridge.
GA4 base and Meta Pixel base now also fire on ACC - Consent Update (re-fire after mid-session Accept).
Published accounts/.../containers/.../versions/14.
```

### 4c — Re-export the container (checklist steps 1-4)

- [ ] In the GTM UI → Admin → Container → Export Container, export the newly published version (14).
- [ ] Save it as `docs/GTM-NPHLG9NR_v14.json`. **Do NOT delete** `docs/GTM-NPHLG9NR_v13.json` — the container-change checklist normally says "remove the previous export file", but v13 is the committed rollback reference for Plan 6 (`2026-07-28-gtm-native-tags-migration.md`), which ships after this plan, so v13 and v14 coexist in the repo until Plan 6 lands.
- [ ] Confirm in the export JSON that all consent-relevant tags still show `consentSettings.consentStatus: "needed"`, and that `ACC - GA4 base`, `ACC - Meta Pixel base`, and `Microsoft Clarity - Official` each fire on two triggers (their base trigger + `ACC - Consent Update`). Grep the export to spot-check the new redaction landed:

```bash
grep -c "redactLocation" docs/GTM-NPHLG9NR_v14.json
```

Expected output: `1` (the `ACC - GA4 base` tag HTML).

- [ ] **Update the doc pointer** in `docs/analytics-stack.md`: change the "current export is `docs/GTM-NPHLG9NR_v13.json`" reference (line 148) to `_v14.json`, and add a one-line note under the Container Change Checklist that v14 added the N-1 `page_location` redaction.
- [ ] **Commit** the export + doc together (checklist step 4 — "a stale export is worse than no export"): `chore(analytics): export GTM v14 (page_location redaction, N-1)`

**Verification limitation (be honest in the PR):** GTM Preview / Tag Assistant verification requires the Claude-in-Chrome extension, which prior sessions found unavailable (see `docs/analytics-stack.md:148`). If it is available, run the Verification Checklist (`docs/analytics-stack.md:123-135`) against `/koszyk?sale=TEST` and confirm GA4 DebugView shows `page_location` = `…?sale=redacted` on `session_start`. Otherwise rely on Task 5's hermetic e2e (which proves layer 1) and note Preview was not run.

---

## Task 5 — Playwright `@ci` regression guard

Assert the invariant across **all three token-bearing routes** (`?sale=` on `/koszyk`, `?preview=` on a PDP, `payment_intent[_client_secret]=` on `/koszyk/return`): a capability token in the URL never survives into `document.location`, `window.dataLayer`, or an outgoing *third-party* request — checked against the request URL, POST body, **and `Referer` header**. Hermetic `@ci` runs do not load GTM/GA4 (`NEXT_PUBLIC_GTM_ID` is unset in the webServer env, `playwright.config.ts`), so this validates the **app-layer defence** end-to-end in a real browser — which is exactly what starves gtag of the token. The first-party navigation, the `/api/private-sale` POST, and Stripe's own API on `/koszyk/return` (the client secret's intended destination — the webServer seeds a placeholder `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `playwright.config.ts:56`) legitimately carry the token, so the network check excludes localhost and `*.stripe.com`, flagging only genuine third-party requests. `Referrer-Policy: strict-origin-when-cross-origin` (`src/middleware.ts:66`) already strips path+query from cross-origin Referers, so the Referer arm is belt-and-braces that bites only if that policy regresses.

- [ ] Create `e2e/analytics-token-leak.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

// N-1 regression guard (docs/audits/analytics-architecture-audit-2026-07-28.md).
// A capability token in the URL must never survive into document.location (so
// gtag's ambient page_location can't capture it), the dataLayer, or a
// third-party request — checked against the request URL, POST body, AND Referer.
// Hermetic @ci run: GTM/GA4 don't load, so this asserts the app-layer defence —
// history.replaceState (layer 1) plus redactSensitiveUrl — which is what denies
// gtag the token in the first place.
const TOKEN = 'LEAKTEST123';

// One row per route that consumes a capability token, with the arrival URL.
const CASES = [
  { name: '?sale= on /koszyk', path: `/koszyk?sale=${TOKEN}` },
  { name: '?preview= on a PDP', path: `/kubki/k01?preview=${TOKEN}` },
  {
    name: 'Stripe params on /koszyk/return',
    path: `/koszyk/return?payment_intent=pi_${TOKEN}&payment_intent_client_secret=pi_${TOKEN}_secret_x`,
  },
];

test.describe('@ci analytics token redaction', () => {
  for (const { name, path } of CASES) {
    test(`${name}: token never reaches URL, dataLayer, or a third party`, async ({
      page,
    }) => {
      const externalLeaks: string[] = [];
      page.on('request', (req) => {
        const url = req.url();
        // Legitimate token destinations, excluded like a first-party host:
        //  - localhost: the initial navigation + the /api/private-sale POST.
        //  - *.stripe.com: the /koszyk/return retrieve — the client secret's
        //    intended home (Stripe.js loads via the placeholder key), not a
        //    third-party analytics sink.
        if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) return;
        if (/^https:\/\/([a-z0-9-]+\.)*stripe\.com\//i.test(url)) return;
        // Flag a leak via URL, POST body, OR Referer — a cross-origin request whose
        // URL and body are clean can still carry the token in its Referer header.
        const referer = req.headers()['referer'] ?? '';
        if (
          url.includes(TOKEN) ||
          (req.postData() ?? '').includes(TOKEN) ||
          referer.includes(TOKEN)
        ) {
          externalLeaks.push(url);
        }
      });

      await page.goto(path);

      // Wait until the analytics layer has run at least once. On localhost,
      // pushDataLayer mirrors event names onto this dataset (the acc_analytics_debug
      // QA hook, src/lib/analytics.ts:456) — its presence proves page_view fired.
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.accAnalyticsDebug ?? ''))
        .not.toBe('');

      // Layer 1: the strip removed the token from the address bar. Polled because
      // /koszyk/return defers the strip until stripe.retrievePaymentIntent settles.
      await expect
        .poll(() => page.evaluate(() => window.location.href), { timeout: 15_000 })
        .not.toContain(TOKEN);
      expect(await page.evaluate(() => window.location.search)).not.toContain(TOKEN);

      // Nothing in the dataLayer carries the raw token (app-layer redactSensitiveUrl).
      const dataLayerHasToken = await page.evaluate((t) => {
        const dl = (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? [];
        return JSON.stringify(dl).includes(t);
      }, TOKEN);
      expect(dataLayerHasToken).toBe(false);

      // No cross-origin request leaked it via URL, body, or Referer.
      expect(externalLeaks).toEqual([]);
    });
  }
});
```

- [ ] **Prove the guard bites** before trusting it green. Temporarily revert the Task 2a hook call (comment out `useStripUrlParams(['sale']);` in `CartView.tsx`), rebuild, and run — the `?sale=` case must fail (the token survives in the URL):

```bash
rm -rf .next && npx playwright test e2e/analytics-token-leak.spec.ts --grep @ci
```

Expected (with the hook reverted): the `?sale=` case **fails** — its polled `window.location.href` assertion times out because the token is never stripped (the `?preview=` and Stripe-return cases stay green, their strips untouched). Then restore the hook call.

> Note: the webServer only builds when `.next` is absent (`playwright.config.ts` webServer command is `test -d .next || npm run build; npm run start`). `rm -rf .next` before each run forces a rebuild so the app-under-test reflects the current source (see `docs/e2e-playwright-purchase-flow.md`).

- [ ] **Run it green** with the hook restored:

```bash
rm -rf .next && npx playwright test e2e/analytics-token-leak.spec.ts --grep @ci
```

Expected output:

```
Running 3 tests using 1 worker
  ✓  1 [chromium] › analytics-token-leak.spec.ts:… › ?sale= on /koszyk: token never reaches … (…s)
  ✓  2 [chromium] › analytics-token-leak.spec.ts:… › ?preview= on a PDP: token never reaches … (…s)
  ✓  3 [chromium] › analytics-token-leak.spec.ts:… › Stripe params on /koszyk/return: token never reaches … (…s)
  3 passed (…s)
```

- [ ] **Commit:** `test(analytics): @ci guard that capability tokens never leak to dataLayer/network (N-1)`

---

## Task 6 — Ops: rotate the CMS preview secret

Hygiene per audit §6 ("rotate the CMS preview secret as hygiene"). The exposed `?sale=` tokens are already expired (audit §6 "Exploitability" — verified against `private_sales`), so no private-sale/piece rotation is needed. `CMS_PREVIEW_SECRET` signs admin draft-preview tokens (`?preview=` on PDPs); rotating it invalidates any preview JWT that leaked to GA4. Preview links are admin-only and short-lived, so invalidating outstanding ones is acceptable — operators simply re-mint via `/api/admin/content/preview`.

- [ ] Rotate the production secret (Cloudflare Workers):

```bash
npx wrangler secret put CMS_PREVIEW_SECRET
```

Paste a fresh high-entropy value (e.g. from `openssl rand -base64 32`). Expected output: `✨ Success! Uploaded secret CMS_PREVIEW_SECRET`.

- [ ] Update the local `.dev.vars` `CMS_PREVIEW_SECRET` to match if local admin preview is used.
- [ ] Confirm the fail-closed behaviour is intact (unset ⇒ preview minting 500s; never reuse Stripe/Supabase secrets — `AGENTS.md`, CMS_PREVIEW_SECRET note). No code change; verify by minting a fresh preview link from `/admin/content` and loading it on a PDP.
- [ ] No commit (secret rotation is out-of-repo). Record the rotation date in the PR description / runbook.

---

## Final verification gate

- [ ] Full unit suite: `npm run test` → all pass (`--passWithNoTests`; includes the new `use-strip-url-token.test.ts`).
- [ ] `npm run lint && npm run typecheck` → both exit 0.
- [ ] `rm -rf .next && npx playwright test --grep @ci` → all `@ci` specs pass (adds `analytics-token-leak.spec.ts`; the existing `consent-banner`, `checkout-409`, etc. must stay green).
- [ ] GTM live container is v14 with the redacted `page_location`; `docs/GTM-NPHLG9NR_v14.json` committed, `_v13.json` **retained** (Plan 6's rollback reference — do not delete until Plan 6 lands), `docs/analytics-stack.md` pointer updated.
- [ ] `CMS_PREVIEW_SECRET` rotated in production.
- [ ] Post-deploy (follow-up, not a code step): re-run the audit's GA4 Data API `pageLocation` probe after ~24-48h and confirm new rows for `/koszyk`, PDP, and `/koszyk/return` show only `redacted` values (audit Appendix A tooling: `.secrets/gtm-api-deploy.json`, `analytics.readonly` scope).

---

## Rollout / risk

- **Sequence:** Tasks 1→2→3 (app-layer, ship together), then 4 (GTM — deploy the app first so the bridge's `page_location` refresh has app page_views to promote; the base-tag config seed is independent and safe either way), then 5 (already merged with 1-3), then 6 (ops).
- **Blast radius:** layer 1 is three localized client edits + two new small files; layer 2 is two hand-written GTM snippets. No server/checkout/payment logic changes. The one behavioural change is the private-sale reload note in Task 2b.
- **Rollback:** revert the app commits (URL simply keeps the token again — no data corruption); for GTM, re-publish from `docs/GTM-NPHLG9NR_v13.json` or re-run `npm run gtm:setup -- --publish` off the reverted `ga4BaseHtml`/`ga4BridgeHtml`.
