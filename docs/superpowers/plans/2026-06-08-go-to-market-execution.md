# Ceramics Drop — Go-to-Market Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement the 🤖 AGENT tasks task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 🧑 USER tasks are operational (dashboards, DNS, secrets, legal, contracts) and must be done by a human — an agent must STOP and hand off, never fabricate completion.

**Goal:** Close every gap and fix every issue in the 2026-06-07 go-to-market audit, in dependency-correct order, taking the storefront from "code-complete on test integrations" to "launched on live integrations."

**Architecture:** Land all code-only hardening first (behind a CI safety net) so the deployed Worker is correct *before* real money/traffic flows; then perform the external go-live flips (Stripe/InPost/Geowidget/Sentry/Resend) as human dashboard+secret operations; gate launch on a single live smoke test.

**Tech Stack:** Next.js 16 (App Router) · OpenNext · Cloudflare Workers · Stripe · InPost ShipX · Supabase (Postgres) · Resend · Sentry · next-intl (pl/en/es) · Playwright + Vitest.

---

## Legend & ground rules

| Badge | Meaning |
|-------|---------|
| 🤖 **AGENT** | Pure code/config change. Agent implements with TDD, commits by explicit path. |
| 🧑 **USER** | External action: dashboard config, DNS, `wrangler secret`, legal text, supplier contract. Agent cannot do this — it must hand off and wait. |
| 🤝 **USER→AGENT** | User supplies a value/decision; agent then writes the code. |

**Git safety (from project memory):** subagents have previously taken unauthorized git actions. Every 🤖 task commits **only by explicit path** (`git add <exact paths>`), never `git add -A`. Subagents are given no-git instructions; the controller commits.

**Verification discipline:** never mark a task done without running its verification command and seeing the expected output. For 🧑 tasks, "verification" is the dashboard/CLI check named in the task.

**Repo invariant to keep green throughout:**
```bash
npm test          # 169 unit tests (Vitest)
npm run build     # production build (OpenNext)
```

---

## Phase overview (execution order)

| Phase | Theme | Tasks | Path |
|------|-------|-------|------|
| 0 | CI safety net | 1 | 🤖 |
| 1 | Pricing truth | 2–3 | 🤝 |
| 2 | Content correctness | 4 | 🤖 |
| 3 | Legal identification | 5–6 | 🤝 |
| 4 | Security & runtime hardening | 7–10 | 🤖 |
| 5 | Cookie consent (CMP) | 11 | 🤖 |
| 6 | Returns customer flow | 12–13 | 🤖 |
| 7 | Operational tooling | 14–15 | 🤖 / 🧑 |
| 8 | Sentry runtime wiring | 16 | 🧑 |
| 9 | Go-live: flip integrations | 17–20 | 🧑 |
| 10 | Final validation | 21–22 | 🤖 / 🧑 |

**Why this order:** CI (0) protects everything after it. Pricing (1) is the source of truth the content fix (2) depends on. Legal (3), hardening (4), consent (5), returns (6), ops (7) are all code that must be deployed *before* go-live. Only then do the irreversible external flips (8–9) happen, gated by a single live smoke test (10).

---

## File Structure (what gets created / modified)

**Created**
- `.github/workflows/ci.yml` — unit + lint + typecheck + build gate (Task 1)
- `supabase/migrations/<ts>_reserve_pieces_search_path.sql` — search_path hardening (Task 10)
- `src/components/consent/ConsentBanner.tsx` — cookie consent UI (Task 11)
- `src/components/consent/consent-mode.ts` — Google Consent Mode v2 default/update helpers (Task 11)
- `src/app/[locale]/zwrot/page.tsx` — returns-initiation page calling `/api/returns` (Task 13)
- `src/components/shop/ReturnRequestForm.tsx` — returns form client component (Task 13)
- `src/proxy.ts` — renamed from `src/middleware.ts`, now also sets security headers (Tasks 7–8)

**Modified**
- `src/lib/pricing.ts` — confirmed shipping rates (Task 3)
- `messages/{pl,en,es}.json` — shipping copy (Task 4), legal seller ID (Task 6), consent strings (Task 11), returns strings (Task 13)
- `public/_headers` — add HSTS to static `/*` block (Task 7)
- `worker.ts` — early-404 for vuln-scanner probe paths (Task 9)
- `src/lib/email.ts` — order-id/returns link in shipping confirmation (Task 12); studio new-order email (Task 14)
- `src/app/api/stripe/webhook/route.ts` — trigger studio new-order email (Task 14)
- `src/app/[locale]/layout.tsx` + `src/components/analytics/GoogleTagManager.tsx` — consent-gated load (Task 11)
- `.env.example` / `cloudflare-env.d.ts` — any new env keys surfaced below

---

# PHASE 0 — CI safety net

## Task 1 — 🤖 AGENT · Add unit + lint + typecheck + build to CI

**Why first:** every later code change rides on this. Today CI runs only Playwright `@ci` against production (`.github/workflows/e2e.yml`); 169 unit tests, lint, and typecheck run only locally (audit "Medium — CI/CD gaps").

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Confirm the scripts exist**

Run: `npm run` (lists scripts) — confirm `test`, `lint`, `build` exist; find the typecheck script (likely `tsc --noEmit` or a `typecheck` script).
Expected: `test`, `lint`, `build` present.

- [ ] **Step 2: Write the workflow**

Create `.github/workflows/ci.yml`:
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  verify:
    name: Lint · Typecheck · Unit · Build
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - name: Install (locked)
        run: npm ci
      - name: Lint
        run: npm run lint
      - name: Typecheck
        run: npx tsc --noEmit
      - name: Unit tests
        run: npm test
      - name: Build
        run: npm run build
        env:
          # Build must not require live secrets; provide inert placeholders.
          NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: pk_test_placeholder
          NEXT_PUBLIC_GTM_ID: ''
          NEXT_PUBLIC_SENTRY_DSN: ''
```

- [ ] **Step 3: Verify the build step needs no real secrets**

Run locally with a clean env: `npm run build`
Expected: PASS. If the build fails for a missing public env var, add an inert placeholder to the `env:` block above (never a real secret) and re-run.

> **Note (npm lockfile):** project memory records CI uses npm 10 while local is npm 11 — lockfile drift broke Workers Build before. Validate the lock with `npx npm@10.9.2 ci` locally before pushing so `npm ci` won't fail in Actions.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add lint, typecheck, unit-test, build gate"
```

- [ ] **Step 5: Verify on a PR**

Push to a branch, open a PR, confirm the `verify` job runs and goes green in GitHub Actions.

---

# PHASE 1 — Pricing truth (blocks content fix)

## Task 2 — 🧑 USER · Confirm real InPost shipping rates

**Why:** `src/lib/pricing.ts:17-19` literally says *"Placeholder figures — confirm against the studio's InPost rates before launch."* Checkout charges these exact amounts (`CartView.tsx:134` `SHIPPING_PLN[ship]`). Wrong numbers = under/over-charging real customers.

- [ ] Open the InPost / Manager Paczek contract and read the real per-parcel rates for: **Paczkomat**, **Kurier**, **Odbiór osobisty** (free).
- [ ] Decide the customer-facing price for each (may include a margin/handling fee — business decision).
- [ ] **Hand the three confirmed PLN figures to the agent** for Task 3. Current placeholders: Paczkomat **15 zł**, Kurier **75 zł**, Odbiór **0 zł**.

**Verification:** the three numbers are written down and match the contract (or the deliberate retail markup).

## Task 3 — 🤝 USER→AGENT · Apply confirmed rates to `pricing.ts`

**Files:**
- Modify: `src/lib/pricing.ts:21-25`
- Test: locate the existing pricing test (search `SHIPPING_PLN` under the test dirs); if none, create `src/lib/pricing.test.ts`.

- [ ] **Step 1: Write/extend the failing test** with the confirmed numbers (example assumes confirmed = 15/75/0; substitute Task 2's real values):

```ts
import { describe, it, expect } from 'vitest';
import { SHIPPING_PLN } from './pricing';

describe('SHIPPING_PLN (confirmed against InPost contract 2026-06-08)', () => {
  it('charges the confirmed paczkomat/kurier/odbior rates', () => {
    expect(SHIPPING_PLN.paczkomat).toBe(15); // <-- replace with Task 2 value
    expect(SHIPPING_PLN.kurier).toBe(75);    // <-- replace with Task 2 value
    expect(SHIPPING_PLN.odbior).toBe(0);
  });
});
```

- [ ] **Step 2: Run it** — `npx vitest run src/lib/pricing.test.ts` — Expected: FAIL only if the current code differs from confirmed values (if identical, it passes and this task is a no-op other than locking the values with a test).

- [ ] **Step 3: Update the constant** in `src/lib/pricing.ts:21-25` to the confirmed values and update the placeholder comment at lines 17-19 to: `Confirmed against the studio's InPost rates 2026-06-08.`

- [ ] **Step 4: Run** — `npx vitest run src/lib/pricing.test.ts` — Expected: PASS. Then full `npm test` — Expected: 169 (or 170) pass.

- [ ] **Step 5: Commit**
```bash
git add src/lib/pricing.ts src/lib/pricing.test.ts
git commit -m "fix(pricing): confirm shipping rates against InPost contract"
```

---

# PHASE 2 — Content correctness

## Task 4 — 🤖 AGENT · Make "Dostawa i zwroty" copy match checkout (add Paczkomat)

**Why (audit "High — content doesn't match checkout"):** checkout offers Paczkomat (15 zł), Kurier (75 zł), Odbiór (free), but the info page prose (`shipping.s1P` / `s1Li1-3` in `messages/{pl,en,es}.json:332-363`, rendered by `src/app/[locale]/dostawa-i-zwroty/page.tsx`) only mentions Kurier + Odbiór. Customers see different options/prices in cart vs info page → trust/support risk.

**Files:**
- Modify: `messages/pl.json` (`shipping.s1P`, `shipping.s1Li1`, add `s1Li1b`), `messages/en.json`, `messages/es.json` (same keys, lines ~332-363)
- Modify (if list is hardcoded to 3 items): `src/app/[locale]/dostawa-i-zwroty/page.tsx`
- Test: `src/app/[locale]/dostawa-i-zwroty/page.test.tsx` (or extend an existing messages-consistency test)

- [ ] **Step 1: Write the failing test** — assert the PL shipping copy now contains a Paczkomat line and its price matches `SHIPPING_PLN.paczkomat`:

```ts
import { describe, it, expect } from 'vitest';
import pl from '../../../../messages/pl.json';
import { SHIPPING_PLN } from '@/lib/pricing';

describe('dostawa-i-zwroty copy matches checkout', () => {
  it('mentions Paczkomat with the charged price', () => {
    const joined = JSON.stringify(pl.shipping);
    expect(joined.toLowerCase()).toContain('paczkomat');
    expect(joined).toContain(String(SHIPPING_PLN.paczkomat)); // e.g. "15"
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run src/app/[locale]/dostawa-i-zwroty/page.test.tsx` — Expected: FAIL (`paczkomat` absent from `shipping`).

- [ ] **Step 3: Edit the three message files.** Add a Paczkomat bullet and fold it into the prose. Example for `messages/pl.json` `shipping`:
  - `s1Li1`: `"Paczkomat InPost, cała Polska — 15 zł"`
  - add `s1Li1b`: `"Kurier InPost, cała Polska — 75 zł"`
  - keep `s1Li2`: `"Odbiór osobisty w pracowni — gratis"`
  - `s1P`: change "wysyłam kurierem" → "wysyłam **Paczkomatem InPost (15 zł)** lub **kurierem (75 zł)** na terenie całej Polski…"
  - Mirror in `en.json` (`"InPost Parcel Locker, all of Poland — 15 zł"`, etc.) and `es.json` (`"Paczkomat InPost, toda Polonia — 15 zł"`, etc.).
  - If `s1Li1b` is a new key, render it in `dostawa-i-zwroty/page.tsx` next to `s1Li1`.

> Use the **confirmed Task 3 numbers**, not the placeholders, if they changed.

- [ ] **Step 4: Run** — `npx vitest run` for the new test — Expected: PASS. Then `npm test` — Expected: all pass.

- [ ] **Step 5: Commit**
```bash
git add messages/pl.json messages/en.json messages/es.json src/app/[locale]/dostawa-i-zwroty/page.tsx src/app/[locale]/dostawa-i-zwroty/page.test.tsx
git commit -m "fix(content): list Paczkomat in delivery info to match checkout"
```

---

# PHASE 3 — Legal identification

## Task 5 — 🧑 USER · Provide seller identification data + legal sign-off

**Why (audit "Medium — legal / regulamin"):** Regulamin & Polityka prywatności (`messages/pl.json:378` and `:408`) name Anna Ciok / Warsaw / hej@ciok.art but carry **no NIP, REGON, or registered address** — Polish B2C e-commerce requires clear seller identification.

- [ ] Gather: **NIP**, **REGON** (if registered), **registered business address**, legal form (e.g. działalność nierejestrowana vs JDG — this changes what's required).
- [ ] Confirm with an accountant whether the Stripe no-VAT invoice document (`createOrderInvoice`) is correct for the business form.
- [ ] (Recommended) brief legal review of regulamin + privacy policy.
- [ ] **Hand the confirmed identification block to the agent** for Task 6. If the business is legitimately exempt from showing NIP/REGON (e.g. działalność nierejestrowana), state that explicitly so the agent documents it instead of inventing fields.

**Verification:** identification details confirmed by the user/accountant.

## Task 6 — 🤝 USER→AGENT · Insert seller identification into legal pages

**Files:**
- Modify: `messages/pl.json` (`§1` general provisions ~line 378; privacy administrator ~line 408), `messages/en.json`, `messages/es.json` (same keys)

- [ ] **Step 1: Write the failing test** — assert the PL regulamin text contains the NIP once provided:

```ts
import pl from '../../messages/pl.json';
it('regulamin states seller NIP', () => {
  expect(JSON.stringify(pl)).toMatch(/NIP\s*[:\s]/i);
});
```
(If the user confirmed a legal exemption in Task 5, skip this test and instead add the exemption wording — do not fabricate a NIP.)

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Edit the three message files** — extend the seller-identification sentence in regulamin §1 and the privacy "Administrator danych" block with the confirmed NIP / REGON / registered address, in all three locales (translate the labels: PL `NIP`, EN `Tax ID (NIP)`, ES `NIF (NIP)`).

- [ ] **Step 4: Run** the test + `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add messages/pl.json messages/en.json messages/es.json src/**/legal*.test.* 
git commit -m "legal: add seller identification (NIP/REGON/address) to terms & privacy"
```

---

# PHASE 4 — Security & runtime hardening

## Task 7 — 🤖 AGENT · Security headers on HTML responses (+ HSTS)

**Why (audit "New issues — security headers missing on HTML pages"):** `public/_headers` security headers reach **static assets only** on OpenNext/CF (verified live); HTML pages get none, and there is no HSTS anywhere. `next.config.ts` `headers()` only sets Cache-Control. The reliable place to set headers on every HTML response is the next-intl middleware (it already runs on all non-API, non-static routes).

> Done together with Task 8 (the rename), because both edit the same file. Implement Task 8's rename first, then add headers here.

**Files:**
- Modify: `src/proxy.ts` (post-rename; see Task 8)
- Modify: `public/_headers` (add HSTS to the static `/*` block so assets get it too)
- Test: `src/proxy.test.ts`

- [ ] **Step 1: Write the failing test** — the middleware response carries security headers:

```ts
import { describe, it, expect } from 'vitest';
import proxy from './proxy';
import { NextRequest } from 'next/server';

describe('proxy security headers', () => {
  it('sets HSTS and the hardening headers on HTML responses', () => {
    const res = proxy(new NextRequest('https://anna-ciok.studio/pl'));
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=');
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Content-Security-Policy-Report-Only')).toContain("default-src 'self'");
  });
});
```

- [ ] **Step 2: Run** — `npx vitest run src/proxy.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** `src/proxy.ts` (wrapping the existing next-intl middleware):

```ts
import createMiddleware from 'next-intl/middleware';
import type { NextRequest } from 'next/server';
import { routing } from './i18n/routing';

const handleI18n = createMiddleware(routing);

const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  // Report-only first so it can't break Stripe/GTM/GA/Meta/InPost; tighten + enforce after observing reports.
  'Content-Security-Policy-Report-Only': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://js.stripe.com https://*.googletagmanager.com https://*.google-analytics.com https://connect.facebook.net https://geowidget.inpost.pl",
    "style-src 'self' 'unsafe-inline' https://geowidget.inpost.pl",
    "img-src 'self' data: https://*.google-analytics.com https://*.googletagmanager.com https://www.facebook.com",
    "connect-src 'self' https://api.stripe.com https://*.google-analytics.com https://*.googletagmanager.com https://api-shipx-pl.easypack24.net https://*.supabase.co",
    "frame-src https://js.stripe.com https://geowidget.inpost.pl",
    "font-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};

export default function proxy(request: NextRequest) {
  const response = handleI18n(request);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|sentry-tunnel|.*\\..*).*)'],
};
```

- [ ] **Step 4: Add HSTS to static assets** — in `public/_headers`, append to the existing `/*` block:
```
  Strict-Transport-Security: max-age=63072000; includeSubDomains
```

- [ ] **Step 5: Run** — `npx vitest run src/proxy.test.ts` then `npm test` — Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add src/proxy.ts src/proxy.test.ts public/_headers
git commit -m "security: add HSTS + hardening headers (CSP report-only) to HTML responses"
```

> **Follow-up (post-launch, separate task):** review CSP-Report-Only violations in browser/Sentry, tighten the policy, then promote `Content-Security-Policy-Report-Only` → `Content-Security-Policy`.

## Task 8 — 🤖 AGENT · Rename `middleware.ts` → `proxy.ts` (Next.js 16)

**Why (audit "Low — minor debt"):** Next.js 16 deprecates `middleware.ts` in favour of `proxy.ts` (build legend already shows "Proxy (Middleware)"). `proxy` is nodejs-runtime only / no edge — fine for the next-intl middleware here.

> Do this **before** Task 7's header code (Task 7 writes the final `src/proxy.ts`). This task is the mechanical move + import/build verification.

**Files:**
- Rename: `src/middleware.ts` → `src/proxy.ts`

- [ ] **Step 1:** `git mv src/middleware.ts src/proxy.ts`
- [ ] **Step 2:** Confirm no code imports `./middleware` — Run: Grep for `middleware` across `src/`. Expected: only the file itself / config references.
- [ ] **Step 3:** `npm run build` — Expected: build succeeds and the legend shows the proxy entry, no deprecation warning.
- [ ] **Step 4: Commit**
```bash
git add src/proxy.ts
git commit -m "chore: rename middleware.ts to proxy.ts for Next.js 16"
```

## Task 9 — 🤖 AGENT · Quiet vuln-scanner 404 log noise

**Why (audit "New issues — observability drowning in bot noise"):** ~3,300 error logs over 3 days are vuln-scanner probes (`/.env*`, `/wp-login.php`, `/credentials.js`, …) hitting 404, which OpenNext's `StaticAssetsIncrementalCache` logs as errors — burying real errors and (once Task 16 lands) would inflate Sentry. These paths contain dots, so the middleware matcher excludes them; intercept them earlier in `worker.ts` before delegating to the OpenNext handler.

**Files:**
- Modify: `worker.ts` (custom fetch handler that wraps `.open-next/worker.js`)
- Test: `worker.test.ts`

- [ ] **Step 1: Read `worker.ts`** to confirm the exported `fetch(request, env, ctx)` shape and where it delegates to the OpenNext handler.

- [ ] **Step 2: Write the failing test** — known probe paths short-circuit to 404 without touching OpenNext:

```ts
import { describe, it, expect } from 'vitest';
import { isProbePath } from './worker';

describe('vuln-scanner probe filter', () => {
  it('flags common probe paths', () => {
    for (const p of ['/.env', '/.env.local', '/wp-login.php', '/credentials.js', '/sysinfo.cgi', '/.git/config']) {
      expect(isProbePath(p)).toBe(true);
    }
  });
  it('passes real paths through', () => {
    for (const p of ['/pl', '/api/checkout', '/uploads/x.webp', '/koszyk']) {
      expect(isProbePath(p)).toBe(false);
    }
  });
});
```

- [ ] **Step 3: Implement** in `worker.ts` — export the predicate and guard at the top of `fetch`:

```ts
const PROBE_PATH = /(^\/\.(env|git|aws|ssh))|(\/wp-(login|admin|content))|(\/(credentials|sysinfo|phpinfo|config|backup)\.)|(\.(php|cgi|asp|aspx)$)/i;

export function isProbePath(pathname: string): boolean {
  return PROBE_PATH.test(pathname);
}

// inside fetch(request, env, ctx), before delegating to the OpenNext handler:
const url = new URL(request.url);
if (isProbePath(url.pathname)) {
  return new Response('Not found', { status: 404 });
}
```

- [ ] **Step 4: Run** — `npx vitest run worker.test.ts` then `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add worker.ts worker.test.ts
git commit -m "observability: short-circuit vuln-scanner probes to reduce 404 error-log noise"
```

> **Cheaper 🧑 alternative (optional, not a replacement):** add a Cloudflare WAF custom rule blocking the same probe patterns at the edge so they never reach the Worker at all. Code guard above is sufficient on its own.

## Task 10 — 🤝 AGENT writes / USER-or-AGENT applies · Set `search_path` on `reserve_pieces`

**Why (audit + connector check):** Supabase security advisor flags `reserve_pieces` with a **mutable `search_path`** — a function-hijacking hardening gap. Fix by pinning the search_path.

**Files:**
- Create: `supabase/migrations/<timestamp>_reserve_pieces_search_path.sql`

- [ ] **Step 1: Find the function's current definition** — Read the migration that creates `reserve_pieces` (search `supabase/migrations` for `reserve_pieces`) to confirm its signature and whether it references unqualified objects.

- [ ] **Step 2: Write the migration** (pin to an empty search_path and fully-qualify, or pin to `public` if the body uses unqualified `public` objects — choose based on Step 1):

```sql
-- Harden reserve_pieces against search_path hijacking (Supabase security advisor).
alter function public.reserve_pieces set search_path = public, pg_temp;
```
> If `reserve_pieces` is overloaded, include the full argument signature: `alter function public.reserve_pieces(<arg types>) set search_path = public, pg_temp;`

- [ ] **Step 3: Apply.** Two options:
  - 🤖 via Supabase MCP `apply_migration` (project `ceramics`) — agent may do this if authorized.
  - 🧑 or the user applies via Supabase SQL editor / `supabase db push`.

- [ ] **Step 4: Verify** — re-run Supabase advisors (`get_advisors` security) — Expected: the `reserve_pieces` mutable-search_path finding is gone.

- [ ] **Step 5: Commit the migration**
```bash
git add supabase/migrations/*_reserve_pieces_search_path.sql
git commit -m "db: pin search_path on reserve_pieces (security advisor)"
```

---

# PHASE 5 — Cookie consent (CMP)

## Task 11 — 🤖 AGENT · Consent-gate GTM/GA4/Meta (Google Consent Mode v2)

**Why (audit "High — EU cookie/consent gap"):** `GoogleTagManager` loads unconditionally in `layout.tsx:75`; there is no CMP. GA4/Meta fire before consent — an EU/RODO problem. Implement Consent Mode v2: default **denied** before GTM loads, a banner to accept/reject, and an update on accept. This keeps GTM present (so tags still configure) but blocks storage/pixels until consent.

**Files:**
- Create: `src/components/consent/consent-mode.ts`
- Create: `src/components/consent/ConsentBanner.tsx`
- Modify: `src/app/[locale]/layout.tsx` (inject default-consent script *before* GTM; render `<ConsentBanner/>`)
- Modify: `src/components/analytics/GoogleTagManager.tsx` (optional: keep, but ensure default-deny runs first)
- Modify: `messages/{pl,en,es}.json` (add a `consent` block)
- Test: `src/components/consent/consent-mode.test.ts`

- [ ] **Step 1: Write the failing test** for the consent helpers:

```ts
import { describe, it, expect, vi } from 'vitest';
import { defaultConsentSnippet, COOKIE_NAME, readConsent } from './consent-mode';

describe('consent mode', () => {
  it('default snippet denies analytics/ad storage', () => {
    const s = defaultConsentSnippet();
    expect(s).toContain("'analytics_storage': 'denied'");
    expect(s).toContain("'ad_storage': 'denied'");
  });
  it('reads stored consent from cookie string', () => {
    expect(readConsent(`${COOKIE_NAME}=granted`)).toBe('granted');
    expect(readConsent('')).toBe(null);
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement `src/components/consent/consent-mode.ts`:**

```ts
export const COOKIE_NAME = 'ciok_consent';
export type ConsentValue = 'granted' | 'denied';

/** Inline script string: must run BEFORE GTM so defaults register first. */
export function defaultConsentSnippet(): string {
  return `
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('consent', 'default', {
      'ad_storage': 'denied',
      'ad_user_data': 'denied',
      'ad_personalization': 'denied',
      'analytics_storage': 'denied',
      'wait_for_update': 500
    });
  `;
}

export function readConsent(cookieString: string): ConsentValue | null {
  const match = cookieString.split('; ').find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!match) return null;
  const v = match.split('=')[1];
  return v === 'granted' || v === 'denied' ? v : null;
}

/** Client-only: persist choice + push the consent update to GTM. */
export function setConsent(value: ConsentValue): void {
  document.cookie = `${COOKIE_NAME}=${value}; path=/; max-age=${60 * 60 * 24 * 180}; SameSite=Lax`;
  const state = value === 'granted' ? 'granted' : 'denied';
  // @ts-expect-error gtag is injected by the default snippet
  window.gtag?.('consent', 'update', {
    ad_storage: state, ad_user_data: state, ad_personalization: state, analytics_storage: state,
  });
}
```

- [ ] **Step 4: Implement `src/components/consent/ConsentBanner.tsx`** (client component, hidden once a choice exists):

```tsx
'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { COOKIE_NAME, readConsent, setConsent } from './consent-mode';

export function ConsentBanner() {
  const t = useTranslations('consent');
  const [show, setShow] = useState(false);
  useEffect(() => { setShow(readConsent(document.cookie) === null); }, []);
  if (!show) return null;
  const choose = (v: 'granted' | 'denied') => { setConsent(v); setShow(false); };
  return (
    <div role="dialog" aria-label={t('title')} className="fixed inset-x-0 bottom-0 z-50 m-4 rounded-lg border bg-white p-4 shadow-lg md:max-w-md">
      <p className="text-sm">{t('body')}</p>
      <div className="mt-3 flex gap-2">
        <button onClick={() => choose('granted')} className="rounded bg-black px-4 py-2 text-sm text-white">{t('accept')}</button>
        <button onClick={() => choose('denied')} className="rounded border px-4 py-2 text-sm">{t('reject')}</button>
        <a href="/polityka-prywatnosci" className="self-center text-sm underline">{t('more')}</a>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire into `layout.tsx`** — render the default-consent script **before** `<GoogleTagManager>` and render the banner:

```tsx
import Script from 'next/script';
import { defaultConsentSnippet } from '@/components/consent/consent-mode';
import { ConsentBanner } from '@/components/consent/ConsentBanner';
// ...in <head> or top of <body>, BEFORE GoogleTagManager:
<Script id="consent-default" strategy="beforeInteractive">{defaultConsentSnippet()}</Script>
// ...existing <GoogleTagManager containerId={process.env.NEXT_PUBLIC_GTM_ID} />
// ...near the end of <body>:
<ConsentBanner />
```

- [ ] **Step 6: Add `consent` strings** to `messages/{pl,en,es}.json`. Example PL:
```json
"consent": {
  "title": "Pliki cookie",
  "body": "Używam plików cookie do analityki i marketingu. Możesz zaakceptować lub odrzucić — odrzucenie nie blokuje zakupów.",
  "accept": "Akceptuję",
  "reject": "Odrzucam",
  "more": "Polityka prywatności"
}
```
(EN: "Cookies" / "I use cookies for analytics and marketing…"; ES: "Cookies" / "Uso cookies para analítica y marketing…")

- [ ] **Step 7: Run** — `npx vitest run src/components/consent/consent-mode.test.ts` then `npm test` then `npm run build` — Expected: PASS.

- [ ] **Step 8: Verify behavior** — `npm run dev`, open the site: banner shows; with DevTools → Application, before accepting there is no `_ga`/Meta cookie; after "Akceptuję" the consent update fires and analytics cookies appear; reload → banner stays hidden.

- [ ] **Step 9: Commit**
```bash
git add src/components/consent/ src/app/[locale]/layout.tsx src/components/analytics/GoogleTagManager.tsx messages/pl.json messages/en.json messages/es.json
git commit -m "feat(consent): Google Consent Mode v2 banner gating GA4/Meta before consent"
```

---

# PHASE 6 — Returns customer flow

## Task 12 — 🤖 AGENT · Surface order ID + returns link in shipping confirmation email

**Why (audit "High — returns backend exists, customer flow doesn't"):** `POST /api/returns` uses the order UUID as a capability token, but **customers never see it** — `buildShippingConfirmation()` (`src/lib/email.ts:219-265`) includes tracking + paczkomat code but no order id / return link. Without this, Task 13's page has nothing to act on.

**Files:**
- Modify: `src/lib/email.ts` (`buildShippingConfirmation`, ~219-265; its caller `emailShippingConfirmationToCustomer` ~377-401)
- Test: `src/lib/email.test.ts` (extend existing email tests)

- [ ] **Step 1: Read** `buildShippingConfirmation` to see how it receives the order (confirm it has `order_id` / order object in scope).

- [ ] **Step 2: Write the failing test:**

```ts
it('shipping confirmation includes a returns link with the order id', () => {
  const html = buildShippingConfirmation({ /* minimal fixture incl. order_id: 'abc-123', locale: 'pl', ... */ });
  expect(html).toContain('/zwrot?order=abc-123');
});
```

- [ ] **Step 3: Implement** — add a returns paragraph to the email body built in `buildShippingConfirmation`, e.g.:
```ts
const returnUrl = `https://anna-ciok.studio/${locale === 'pl' ? '' : locale + '/'}zwrot?order=${order_id}`;
// append to the HTML: localized "Chcesz zwrócić? Rozpocznij tutaj: <a href="${returnUrl}">${returnUrl}</a>"
```
Add the localized sentence to the email copy source the template uses (mirror however other email strings are localized in `email.ts` / `email-layout.ts`).

- [ ] **Step 4: Run** — `npx vitest run src/lib/email.test.ts` then `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/email.ts src/lib/email.test.ts
git commit -m "feat(returns): include order id + returns link in shipping confirmation email"
```

## Task 13 — 🤖 AGENT · Returns-initiation page calling `/api/returns`

**Why:** Backend is fully wired but there is **no storefront UI** to start a return (the existing `/koszyk/return` is the Stripe payment-confirmation page, not returns). Build a page that takes the order id (from the email link's `?order=` param or manual entry) and POSTs to `/api/returns`.

**Decision already made (per audit's open question):** implement the **order-id + return-page** path (not "manual email"), since the backend supports it and Task 12 now exposes the id.

**Files:**
- Create: `src/app/[locale]/zwrot/page.tsx`
- Create: `src/components/shop/ReturnRequestForm.tsx`
- Modify: `messages/{pl,en,es}.json` (add `returns` UI strings)
- Test: `src/components/shop/ReturnRequestForm.test.tsx`

- [ ] **Step 1: Confirm the API contract** — re-read `src/app/api/returns/route.ts`: body `{ order_id }`; responses: 200 (accepted), 404 (unknown/ineligible — show generic "not eligible"), 503 (`STUDIO_RETURN_*` unset — show "temporarily unavailable").

- [ ] **Step 2: Write the failing test** (component renders, submits, maps status → message):

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReturnRequestForm } from './ReturnRequestForm';
// mock next-intl + fetch
it('shows success on 200', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  render(<ReturnRequestForm initialOrderId="abc-123" />);
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(screen.getByText(/.+/)).toBeTruthy());
});
```

- [ ] **Step 3: Implement `ReturnRequestForm.tsx`** (client): controlled `order_id` input prefilled from prop, submit → `fetch('/api/returns', { method:'POST', body: JSON.stringify({ order_id }) })`, branch on `res.status` into localized messages (200/404/503/other).

- [ ] **Step 4: Implement `zwrot/page.tsx`** — server component reading `searchParams.order`, rendering `<ReturnRequestForm initialOrderId={order} />` with localized heading/intro and a link to `/dostawa-i-zwroty`.

- [ ] **Step 5: Add `returns` strings** to all three message files (heading, intro, label, button, success/ineligible/unavailable messages).

- [ ] **Step 6: Update `/dostawa-i-zwroty` copy** — replace the "email hej@ciok.art and I'll send next steps" wording with a link to `/zwrot` (the automated flow), keeping email as fallback.

- [ ] **Step 7: Run** — component test + `npm test` + `npm run build` — Expected: PASS.

- [ ] **Step 8: Verify** — `npm run dev`, open `/zwrot?order=<a real paid order uuid from Supabase>`; submit; confirm a 200/404/503 path renders the right message. (A real return shipment requires the `STUDIO_RETURN_*` secrets — see Task 9 of go-live; until set, expect 503, which the UI should handle gracefully.)

- [ ] **Step 9: Commit**
```bash
git add src/app/[locale]/zwrot/ src/components/shop/ReturnRequestForm.tsx src/app/[locale]/dostawa-i-zwroty/page.tsx messages/pl.json messages/en.json messages/es.json
git commit -m "feat(returns): customer-facing returns page calling /api/returns"
```

---

# PHASE 7 — Operational tooling

## Task 14 — 🤖 AGENT · Studio "new order" email on payment

**Why (audit "Medium — operations"):** there is no automated "new order" email to the studio on payment — only the label email fires later (after InPost webhook). Anna has no immediate notification of a paid order.

**Files:**
- Modify: `src/lib/email.ts` (add `emailNewOrderToStudio()` mirroring the existing studio-label sender ~338-401)
- Modify: `src/app/api/stripe/webhook/route.ts` (call it in the payment-success fulfillment path, after pieces are sold)
- Test: `src/lib/email.test.ts`

- [ ] **Step 1: Read** the Stripe webhook handler to find the payment-success branch (where it sells pieces / creates invoice / creates InPost shipment) and confirm `STUDIO_NOTIFY_EMAIL` is available.

- [ ] **Step 2: Write the failing test** — `emailNewOrderToStudio` builds a body containing the order id, customer, items, delivery method, and total.

- [ ] **Step 3: Implement** `emailNewOrderToStudio()` using the same Resend client + FROM (`Anna Ciok Studio <sklep@ciok.art>`) and `STUDIO_NOTIFY_EMAIL` recipient as the existing studio label email. Plain transactional body (no template needed, or a 4th Resend template if you prefer consistency — keep it inline to avoid a dashboard dependency at launch).

- [ ] **Step 4: Call it** in the webhook success path, wrapped so a send failure does **not** fail fulfillment (log + continue; reuse the retry-safe pattern already used for label/confirmation emails).

- [ ] **Step 5: Run** — email test + `npm test` — Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add src/lib/email.ts src/app/api/stripe/webhook/route.ts src/lib/email.test.ts
git commit -m "feat(ops): email studio on new paid order"
```

## Task 15 — 🧑 USER (primary) / 🤖 AGENT (optional) · Rate-limit `/api/checkout` and `/api/returns`

**Why (audit "Medium — operations"):** no rate limiting on `/api/checkout` or `/api/returns`. `/api/returns` is an unauthenticated capability-token endpoint (enumeration risk); `/api/checkout` mutates inventory reservations.

- [ ] **🧑 Primary — Cloudflare Rate Limiting rule** (no code, no new bindings): in the Cloudflare dashboard for `anna-ciok.studio`, add WAF Rate Limiting rules:
  - `/api/returns` — e.g. 10 requests / 10 min / IP → block.
  - `/api/checkout` — e.g. 30 requests / min / IP → managed challenge.
  - Verify with a quick loop that the Nth request is challenged/blocked.
- [ ] **🤖 Optional — in-route guard** (only if a KV/DO binding is added): a lightweight per-IP counter. Skip unless the WAF rule is insufficient; it adds a binding + state the project doesn't currently have.

**Verification:** rate-limit rule active in Cloudflare; burst test shows throttling.

---

# PHASE 8 — Sentry runtime wiring

## Task 16 — 🧑 USER · Wire the Sentry DSN into the Worker

**Why (audit connector check):** build-time Sentry is healthy (releases + source maps upload), but **runtime capture is silent** — only 9 events/14d vs ~3,300 CF error logs. `isSentryEnabled()` (`src/lib/sentry-options.ts:21-23`) returns false because the Worker has no runtime DSN, so `Sentry.init` is skipped. Do this **after** Task 9 (probe filter) so Sentry isn't immediately flooded with scanner noise.

- [ ] Set the server DSN as a Worker secret:
```bash
npx wrangler secret put SENTRY_DSN
# paste: https://5851217de490361cbd86c39e3a012b06@o4510201389907968.ingest.de.sentry.io/4511507404161104
```
- [ ] Ensure `NEXT_PUBLIC_SENTRY_DSN` is set as a **build variable** in the Workers Build config (it's inlined at build time; currently set in `.env.local` only).
- [ ] Redeploy (push to main / trigger Workers Build).
- [ ] **Verify** — trigger a deliberate test error (or watch real traffic) and confirm a new issue appears in Sentry `ceramics-drop` (EU `de.sentry.io`) within minutes. Confirm source maps resolve to original frames.
- [ ] Add Stripe Dashboard alerts for failed webhooks/payments (separate from Sentry).

**Verification:** a runtime error event lands in Sentry post-deploy.

---

# PHASE 9 — Go-live: flip integrations (all 🧑 USER)

> **Irreversible / money-touching. Do these only after Phases 0–8 are deployed and green.** Each flips a sandbox/test integration to live via secrets + dashboard. The audit's "Critical — flip sandbox/test to live" section is the authority; env var names below come from `.env.example` / `cloudflare-env.d.ts`.

## Task 17 — 🧑 USER · Stripe → live

- [ ] Set live secrets on the Worker:
```bash
npx wrangler secret put STRIPE_SECRET_KEY            # sk_live_...
npx wrangler secret put STRIPE_WEBHOOK_SECRET        # from live webhook endpoint
npx wrangler secret put STRIPE_WEBHOOK_THIN_SECRET   # from live thin endpoint
```
- [ ] Set `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...` as a **build var** and redeploy (it's inlined at build).
- [ ] In the Stripe **live** dashboard:
  - Register webhook → `https://anna-ciok.studio/api/stripe/webhook` (fulfillment) and `https://anna-ciok.studio/api/stripe/webhook-thin` (ACK shadow).
  - Enable Payment Element methods in **live**: **BLIK, P24, cards**.
- [ ] **Verify (audit: "not readable via MCP — check manually"):** confirm the live webhook endpoints are listed and the live payment methods are enabled in the dashboard.

> ⚠️ The destructive E2E (`@destructive`) expects `pk_test_` on anna-ciok.studio. After flipping to live, that suite must be run against a separate test deploy, not prod.

## Task 18 — 🧑 USER · InPost ShipX → live

- [ ] Set the production base URL + credentials:
```bash
# INPOST_API_URL default is sandbox; production is:
#   https://api-shipx-pl.easypack24.net   (set as a Worker var/secret)
npx wrangler secret put INPOST_API_TOKEN          # production token
npx wrangler secret put INPOST_ORGANIZATION_ID    # production org id
npx wrangler secret put INPOST_WEBHOOK_TOKEN      # webhook guard token
```
- [ ] Set `INPOST_API_URL=https://api-shipx-pl.easypack24.net` for the Worker (var) and redeploy.
- [ ] In InPost **Manager Paczek**: register webhook → `https://anna-ciok.studio/api/inpost/webhook?token=<INPOST_WEBHOOK_TOKEN>`.
- [ ] Ensure the org has **courier dispatch** enabled (audit: `missing_trucker_id` blocks kurier orders).
- [ ] Set the studio return-address secrets (also unblocks the Task 13 returns flow):
```bash
npx wrangler secret put STUDIO_RETURN_FIRST_NAME
npx wrangler secret put STUDIO_RETURN_LAST_NAME
npx wrangler secret put STUDIO_RETURN_PHONE
npx wrangler secret put STUDIO_RETURN_ADDRESS_STREET
npx wrangler secret put STUDIO_RETURN_ADDRESS_BUILDING
npx wrangler secret put STUDIO_RETURN_ADDRESS_CITY
npx wrangler secret put STUDIO_RETURN_ADDRESS_POSTAL
npx wrangler secret put STUDIO_RETURN_POINT        # paczkomat code, e.g. WAW20A
# STUDIO_RETURN_EMAIL optional; defaults to STUDIO_NOTIFY_EMAIL
```
- [ ] **Verify:** create one real shipment end-to-end (covered by Task 22 smoke test); confirm the InPost webhook hits the endpoint.

## Task 19 — 🧑 USER · Geowidget → production

- [ ] Set production geowidget config:
```bash
# NEXT_PUBLIC_* are inlined at build → set as BUILD VARS, then redeploy:
NEXT_PUBLIC_INPOST_GEOWIDGET_TOKEN=<production browser JWT>
NEXT_PUBLIC_INPOST_GEOWIDGET_ENV=production
```
- [ ] **Verify:** on prod checkout, the paczkomat map loads and point selection works. (Project memory notes a prior geowidget **403 referrer** issue — confirm the production token's allowed referrers include `anna-ciok.studio`.)

## Task 20 — 🧑 USER · Harden Resend

**Why (audit connector check + launch checklist):** Resend config is done (`ciok.art` verified, single FROM `sklep@ciok.art`), but the live chain is **unproven** (only 3 manual test emails, 0 automated sends), there are **0 webhooks**, **no `_dmarc`**, and stale API keys.

- [ ] Add a **DMARC** record at the **OVH DNS** level (Resend manages DKIM+SPF only): `_dmarc.ciok.art TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@ciok.art"` (start at `p=none` to monitor if preferred).
- [ ] Register a Resend **delivery/bounce/complaint webhook** so bounces are tracked.
- [ ] Prune the stale API keys (`docker`, `react`, `Onboarding`); keep only `ceramics`.
- [ ] **Verify:** `dig TXT _dmarc.ciok.art` returns the policy; webhook shows in Resend; a test send shows a delivered event.

---

# PHASE 10 — Final validation (launch gate)

## Task 21 — 🤖 AGENT · Investigate the live InPost `validation_failed`

**Why (audit "Real errors under the noise"):** one InPost `validation_failed` (400) occurred creating a shipment for a paid order — a real fulfillment failure worth root-causing before relying on live shipping.

- [ ] Pull the failing request context from Cloudflare logs (Worker `ceramics-drop`) and/or the order row in Supabase (the order with the failed shipment).
- [ ] Compare the shipment payload our code builds against InPost ShipX required fields (likely a missing/short address, phone format, or `target_point` for paczkomat). Use systematic-debugging: find the exact field InPost rejected before changing code.
- [ ] If a code fix is needed (validation/normalization before the ShipX call), implement it TDD against the offending payload as a fixture; commit by explicit path.
- [ ] **Verify:** re-running the same payload shape no longer 400s (covered live by Task 22).

## Task 22 — 🧑 USER (agent assists) · Live smoke test — full chain

**Why:** no automated label/shipping-confirmation email has *ever* fired; the live chain is unproven end-to-end. This is the **launch gate**.

- [ ] With everything live (Phases 9 done), buy one **real, low-value item** through prod checkout, paying with a real method (BLIK/card).
- [ ] Confirm the full chain:
  1. Stripe live payment succeeds → webhook fulfills.
  2. Inventory piece marked sold in Supabase.
  3. Invoice created (Stripe) — non-zero amount.
  4. InPost shipment created (no `validation_failed`).
  5. **Studio new-order email** received (Task 14).
  6. Studio **label PDF** email received.
  7. Customer **shipping confirmation** email received — containing the **returns link** (Task 12).
  8. (Optional) start a return via `/zwrot?order=<id>` → return label email arrives (Task 13 + Task 18 secrets).
- [ ] Refund the test order in Stripe; confirm the webhook **relists** the inventory piece.
- [ ] **Verify:** every step above observed. Any failure → STOP launch, file the gap, return to the owning task.

**Release-gate command (mutates inventory — staging/controlled only):**
```bash
E2E_DESTRUCTIVE=1 npx playwright test --grep @destructive
```

---

## Consolidated launch checklist (mirrors the Notion audit)

- [ ] (T17–19) Switch Stripe + InPost + Geowidget to **live** in Worker secrets/build vars
- [ ] (T10) Apply Supabase migration; verify `piece_state` reflects real sold inventory
- [x] Configure Resend — **done 2026-06-07** (verified `ciok.art`, single FROM, notify/return emails)
- [ ] (T20) Harden Resend — live smoke send, `_dmarc` at OVH, delivery webhook, prune stale keys
- [ ] (T17–18) Register webhooks in Stripe + InPost Manager Paczek
- [ ] (T2–3) Confirm shipping prices in `pricing.ts` vs real InPost rates
- [ ] (T4) Fix **Dostawa i zwroty** copy (add Paczkomat)
- [ ] (T11) Add **cookie consent** before GTM/ads fire
- [ ] (T5–6) **Legal review** — NIP/address in regulamin
- [ ] (T12–13) Returns UX — order id + return page calling `/api/returns`
- [ ] (T22) Run one **manual live smoke test** (small item, full email chain)
- [ ] (T16) **Wire the Sentry DSN into the Worker** + Stripe alerts
- [ ] (T7) Add **security headers** (HSTS/CSP/…) to HTML responses
- [ ] (T10) Set `search_path` on `reserve_pieces`
- [ ] (T17) Verify **live Stripe webhooks + payment methods** in the Dashboard
- [ ] (T21) Investigate the live InPost `validation_failed`; (T9) quiet scanner-probe noise
- [ ] (T1) CI runs unit + lint + typecheck + build
- [ ] (T15) Rate-limit `/api/checkout` + `/api/returns`
- [ ] (T8) Rename `middleware.ts` → `proxy.ts`

---

## Verification commands

```bash
npm test                    # unit tests (Vitest) — keep green every task
npm run lint                # ESLint
npx tsc --noEmit            # typecheck
npm run build               # production build (OpenNext)
npm run test:e2e            # @ci specs (mocked, against anna-ciok.studio)
# Release gate only (real payment, mutates inventory):
E2E_DESTRUCTIVE=1 npx playwright test --grep @destructive
```

---

## Self-review notes (spec coverage)

Every audit item maps to a task: Stripe/InPost/Geowidget live → T17–19; shipping prices → T2–3; content mismatch → T4; returns flow → T12–13; consent gap → T11; legal/NIP → T5–6; ops/monitoring (new-order email, rate limiting) → T14–15; CI/CD gaps → T1; security headers → T7; bot-noise → T9; Sentry DSN → T16; reserve_pieces search_path → T10; InPost validation_failed → T21; webhook-thin/README/middleware-rename/inventory-seed minor debt → T8 (rename) + noted (webhook-thin and README remain low-priority debt, intentionally deferred — call out if you want them as tasks); Resend hardening → T20; live smoke test → T22.

**Deferred by design (not launch-blocking):** `/api/stripe/webhook-thin` thin-destination migration completion; `README.md` URL/route refresh; inventory-seed drift (informational only — real DB already drifted as expected). Promote any of these to a task on request.
