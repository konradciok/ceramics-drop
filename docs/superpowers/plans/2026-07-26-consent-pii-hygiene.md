# Consent & PII Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop secret capability tokens (`sale`, `preview`) and denied-consent ad identifiers (`fbp`/`fbc`/`ga_client_id`/`ga_session_id`) from leaking into GA4/Meta payloads, and verify the live GTM container actually enforces Consent Mode on all 4 tags.

**Architecture:** Two narrow fixes inside existing functions — extend the `SENSITIVE_QUERY_PARAMS` redaction list in `src/lib/analytics.ts`, and branch the `orders.marketing` capture in the checkout route on consent — plus a manual GTM-UI verification + re-export + a documented process rule so future container edits don't silently drift from the app-side consent config again. No new modules, no schema changes.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest, Google Tag Manager (Custom HTML tags managed via `scripts/gtm-api.mjs`, Tag Manager API v2).

## Global Constraints

- Source audit: `docs/audits/event-system-audit.md`, findings F-24 (Medium), F-10 (Medium), F-02 (High).
- Test runner is Vitest: `npx vitest run <path>` (never jest). `npm run test` runs the full suite (`vitest run --passWithNoTests`).
- No new npm dependencies for this plan.
- `MarketingContext` (`src/lib/marketing/context.ts`) stays structurally unchanged — every field remains present (typed `string | null`), only the *values* branch on consent. Do not widen or narrow the type.
- Commit after each task; each task's tests must pass in isolation (`npx vitest run <file>`) before moving to the next task.

---

### Task 1: Redact `sale` and `preview` tokens from analytics URLs (F-24)

**Files:**
- Modify: `src/lib/analytics.ts:370-375`
- Test: `src/lib/analytics.test.ts`

**Interfaces:**
- Consumes: nothing new — extends the existing `SENSITIVE_QUERY_PARAMS` array and `redactSensitiveUrl(value: string): string` function already used by `buildPageViewEvent` and the `time_on_page`/`scroll_depth` engagement events in `src/components/analytics/AnalyticsEvents.tsx`.
- Produces: no new exports. Behavior change only — `redactSensitiveUrl` now also redacts `sale` and `preview` query params.

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe('redactSensitiveUrl', ...)` block in `src/lib/analytics.test.ts` (alongside the existing `order`/`payment_intent` cases):

```ts
it('redacts the private-sale token from absolute and relative urls', () => {
  expect(redactSensitiveUrl('https://anna-ciok.studio/koszyk?sale=abc-123')).toBe(
    'https://anna-ciok.studio/koszyk?sale=redacted',
  );
  expect(redactSensitiveUrl('/koszyk?sale=abc-123')).toBe('/koszyk?sale=redacted');
});

it('redacts the CMS draft-preview token from absolute and relative urls', () => {
  expect(
    redactSensitiveUrl('https://anna-ciok.studio/kubki/k01?preview=eyJhbGciOiJIUzI1NiJ9'),
  ).toBe('https://anna-ciok.studio/kubki/k01?preview=redacted');
  expect(redactSensitiveUrl('/kubki/k01?preview=eyJhbGciOiJIUzI1NiJ9')).toBe(
    '/kubki/k01?preview=redacted',
  );
});
```

Add to the existing `describe('buildPageViewEvent redaction', ...)` block:

```ts
it('strips the sale token from page_location and page_path', () => {
  const e = buildPageViewEvent({
    pageLocation: 'https://anna-ciok.studio/koszyk?sale=abc-123',
    pagePath: '/koszyk?sale=abc-123',
  });
  expect(e.page_location).toBe('https://anna-ciok.studio/koszyk?sale=redacted');
  expect(e.page_path).toBe('/koszyk?sale=redacted');
  expect(JSON.stringify(e)).not.toContain('abc-123');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/analytics.test.ts -t "redacts the private-sale token"`
Expected: FAIL — `redactSensitiveUrl` returns the URL unchanged today (`sale=abc-123`, not `sale=redacted`) because `'sale'` isn't in `SENSITIVE_QUERY_PARAMS`.

- [ ] **Step 3: Add `sale` and `preview` to the sensitive-params list**

In `src/lib/analytics.ts`, replace:

```ts
/** Query params that carry a capability token / secret and must never reach the
 *  dataLayer (and thus GA4 / Meta). `order` is the return capability token used by
 *  /zwrot?order=<uuid> → POST /api/returns. `payment_intent` /
 *  `payment_intent_client_secret` are appended by Stripe to the /koszyk/return URL
 *  and must not be logged or exposed to third parties. */
const SENSITIVE_QUERY_PARAMS = ['order', 'payment_intent', 'payment_intent_client_secret'];
```

with:

```ts
/** Query params that carry a capability token / secret and must never reach the
 *  dataLayer (and thus GA4 / Meta). `order` is the return capability token used by
 *  /zwrot?order=<uuid> → POST /api/returns. `payment_intent` /
 *  `payment_intent_client_secret` are appended by Stripe to the /koszyk/return URL
 *  and must not be logged or exposed to third parties. `sale` is the single-use
 *  private-sale re-offer token (/koszyk?sale=<token>). `preview` is the admin
 *  CMS draft-preview token minted for unpublished product notes. */
const SENSITIVE_QUERY_PARAMS = [
  'order',
  'payment_intent',
  'payment_intent_client_secret',
  'sale',
  'preview',
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/analytics.test.ts`
Expected: PASS (all cases in `redactSensitiveUrl` and `buildPageViewEvent redaction` describe blocks, including the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/lib/analytics.ts src/lib/analytics.test.ts
git commit -m "fix(analytics): redact private-sale and CMS preview tokens from dataLayer URLs"
```

---

### Task 2: Stop persisting ad identifiers when consent is denied (F-10, closes part of F-19)

**Files:**
- Modify: `src/app/api/checkout/route.ts` (marketing-context construction, ~lines 345-366)
- Test: `src/app/api/checkout/route.test.ts`

**Interfaces:**
- Consumes: `MarketingContext` type (unchanged) from `src/lib/marketing/context.ts`; `readConsent(cookieHeader: string): 'granted' | 'denied' | null` from `src/components/consent/consent-mode.ts` (already imported in the route, not modified by this task).
- Produces: no new exports. Behavior change only — when `consent === 'denied'`, every field of `orders.marketing` except `consent` and `captured_at` is written as `null` instead of the real cookie/IP/UA values.

- [ ] **Step 1: Write the failing tests**

Add to `src/app/api/checkout/route.test.ts`, in the main `describe('POST /api/checkout', ...)` block, right after the existing `'uses a valid supplied attemptId...'` test (~line 369) — reuses the file's existing `makeCheckoutBody`/`VALID_ATTEMPT_ID` helpers and the `insertOrders` mock already declared at the top of the file:

```ts
it('captures full marketing context (including ad identifiers) when consent is granted', async () => {
  const { POST } = await import('./route');
  const req = new Request('http://localhost/api/checkout', {
    method: 'POST',
    headers: { Cookie: 'ciok_consent=granted' },
    body: JSON.stringify(
      makeCheckoutBody({
        attemptId: VALID_ATTEMPT_ID,
        marketing_cookies: {
          fbp: 'fb.1.111.222',
          fbc: 'fb.1.111.333',
          ga_client_id: 'GA1.1.111.222',
          ga_session_id: '999',
        },
      }),
    ),
  });

  const res = await POST(req);
  expect(res.status).toBe(200);
  expect(insertOrders).toHaveBeenCalledWith(
    expect.objectContaining({
      marketing: expect.objectContaining({
        consent: 'granted',
        fbp: 'fb.1.111.222',
        fbc: 'fb.1.111.333',
        ga_client_id: 'GA1.1.111.222',
        ga_session_id: '999',
        ip: '203.0.113.50',
      }),
    }),
  );
});

it('drops ad identifiers from marketing context when consent is denied', async () => {
  const { POST } = await import('./route');
  const req = new Request('http://localhost/api/checkout', {
    method: 'POST',
    headers: { Cookie: 'ciok_consent=denied' },
    body: JSON.stringify(
      makeCheckoutBody({
        attemptId: VALID_ATTEMPT_ID,
        marketing_cookies: {
          fbp: 'fb.1.111.222',
          fbc: 'fb.1.111.333',
          ga_client_id: 'GA1.1.111.222',
          ga_session_id: '999',
        },
      }),
    ),
  });

  const res = await POST(req);
  expect(res.status).toBe(200);
  expect(insertOrders).toHaveBeenCalledWith(
    expect.objectContaining({
      marketing: {
        consent: 'denied',
        fbp: null,
        fbc: null,
        ga_client_id: null,
        ga_session_id: null,
        ip: null,
        user_agent: null,
        event_source_url: null,
        captured_at: expect.any(String),
      },
    }),
  );
});
```

- [ ] **Step 2: Run tests to verify the denied-consent case fails**

Run: `npx vitest run src/app/api/checkout/route.test.ts -t "marketing context"`
Expected: the `'captures full marketing context ... consent is granted'` test PASSES (documents today's already-correct granted-consent behavior). The `'drops ad identifiers ... consent is denied'` test FAILS — today's code writes the real `fbp`/`fbc`/`ga_client_id`/`ga_session_id`/`ip`/`user_agent`/`event_source_url` values into `marketing` regardless of consent.

- [ ] **Step 3: Branch the marketing-context construction on consent**

In `src/app/api/checkout/route.ts`, replace the existing construction:

```ts
const marketing: MarketingContext = {
  consent,
  fbp: str2(mc.fbp),
  fbc: str2(mc.fbc),
  ga_client_id: str2(mc.ga_client_id),
  ga_session_id: str2(mc.ga_session_id),
  ip: clientIp,
  user_agent: req.headers.get('user-agent'),
  event_source_url: eventSourceUrl,
  captured_at: new Date().toISOString(),
};
```

with:

```ts
// consent === 'denied' → only consent + captured_at are legitimate to keep; ad
// identifiers (fbp/fbc/ga_*) and IP/UA have no purpose once the visitor has
// declined tracking, so they're dropped rather than merely flagged.
const marketing: MarketingContext =
  consent === 'granted'
    ? {
        consent,
        fbp: str2(mc.fbp),
        fbc: str2(mc.fbc),
        ga_client_id: str2(mc.ga_client_id),
        ga_session_id: str2(mc.ga_session_id),
        ip: clientIp,
        user_agent: req.headers.get('user-agent'),
        event_source_url: eventSourceUrl,
        captured_at: new Date().toISOString(),
      }
    : {
        consent,
        fbp: null,
        fbc: null,
        ga_client_id: null,
        ga_session_id: null,
        ip: null,
        user_agent: null,
        event_source_url: null,
        captured_at: new Date().toISOString(),
      };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/api/checkout/route.test.ts`
Expected: PASS (full file — this task must not break any of the existing ~40 cases in this file, including the private-sale, print-delivery, and currency-cookie tests that also assert on `insertOrders` calls).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/checkout/route.ts src/app/api/checkout/route.test.ts
git commit -m "fix(checkout): stop persisting ad identifiers in orders.marketing when consent is denied"
```

---

### Task 3: Verify live GTM container consent gating, re-export, and add a container-change checklist (F-02)

**This task requires interactive access to the GTM UI** (a Google account with edit rights on container `GTM-NPHLG9NR`) — Steps 1-4 cannot be run by an autonomous coding agent alone. Steps 5-7 are normal repo edits.

**Files:**
- Verify (external): GTM UI, container `GTM-NPHLG9NR`
- Replace: `docs/GTM-NPHLG9NR_v3.json` → `docs/GTM-NPHLG9NR_v<N>.json`
- Modify: `docs/analytics-stack.md` (insert a new "Container Change Checklist" section after line 123)

**Interfaces:**
- Consumes: the `consentTypes` config already defined in `scripts/gtm-api.mjs:96-121` (`['analytics_storage']` for the two GA4 tags, `['ad_storage']` for the two Meta tags) as the "expected" configuration to check the live container against.
- Produces: nothing code-facing — a fresh container export committed to `docs/`, and a documented process rule.

- [ ] **Step 1: Confirm the live published version**

Open the GTM UI for container `GTM-NPHLG9NR` → Versions (left nav). Note the version number marked **Live**.
Expected: a version number ≥ 6 — the dedupe-guard fix for the ~998-events-per-`page_view` incident (`docs/gtm-hotfix.md`) was published at v6. If the live version is below 6, stop and escalate before continuing; the event-loop bug may still be live.

- [ ] **Step 2: Confirm consent gating on all 4 tags**

In the live version, open each of these 4 tags and check Advanced Settings → Consent Settings:
- `ACC - GA4 base` — "Require additional consent for tag to fire" checked, with `analytics_storage` listed.
- `ACC - Meta Pixel base` — checked, with `ad_storage` listed.
- `ACC - GA4 dataLayer bridge` — checked, with `analytics_storage` listed.
- `ACC - Meta dataLayer bridge` — checked, with `ad_storage` listed.

Expected: all 4 match. (The committed `docs/GTM-NPHLG9NR_v3.json` export shows `consentSettings: NOT_SET` on all 4 tags — that export predates this config and must not be treated as authoritative.)

- [ ] **Step 3: Fix and republish if any tag is missing its consent gate**

If any tag from Step 2 is missing its consent check: either fix it directly in the GTM UI to match Step 2's expected config and publish a new version (description: "add missing consent gate — event-system-audit F-02"), or re-run `npm run gtm:setup -- --publish` from a checkout of this repo (idempotent — reasserts the tag config from `scripts/gtm-api.mjs`). Re-run Step 1 afterward to confirm the new live version number.

- [ ] **Step 4: Export the live container**

GTM UI → Admin → Container → Export Container → select the live version (from Step 1 or Step 3) → download the JSON file.

- [ ] **Step 5: Replace the stale export in the repo**

```bash
git mv docs/GTM-NPHLG9NR_v3.json docs/GTM-NPHLG9NR_v<N>.json
```

Replace `<N>` with the live version number from Step 1/3, then overwrite the moved file's contents with the JSON downloaded in Step 4.

- [ ] **Step 6: Add the container-change checklist to `docs/analytics-stack.md`**

Insert this new section immediately after line 123 (`11. Check Meta Events Manager...`) and before line 125 (`## Current storefront status`):

```markdown

## Container Change Checklist

Whenever the GTM container (`GTM-NPHLG9NR`) tags/triggers change — via `npm run gtm:setup -- --publish` or a manual edit in the GTM UI:

1. In GTM UI → Admin → Container → Export Container, export the newly published version.
2. Save it as `docs/GTM-NPHLG9NR_v<N>.json` (N = the published version number) and remove the previous export file.
3. Confirm all 4 Custom HTML tags (`ACC - GA4 base`, `ACC - Meta Pixel base`, `ACC - GA4 dataLayer bridge`, `ACC - Meta dataLayer bridge`) still show `consentSettings.consentStatus: "needed"` in the export, gated on `analytics_storage` (GA4 tags) or `ad_storage` (Meta tags) — these come from `consentTypes` in `scripts/gtm-api.mjs`.
4. Commit the new export in the same change as the container edit — a stale export is worse than no export.
```

- [ ] **Step 7: Commit**

```bash
git add docs/GTM-NPHLG9NR_v*.json docs/analytics-stack.md
git commit -m "docs(analytics): verify GTM consent gating, re-export live container, add change checklist"
```

---

## Self-Review Notes

- **Coverage:** F-24 → Task 1. F-10 → Task 2 (also closes the F-19 sub-item "zero assertions on `orders.marketing`" for the checkout route test, since Task 2 adds the first assertions on that field). F-02 → Task 3.
- **Placeholder scan:** no TBD/TODO; every step shows the exact before/after code or exact UI navigation with a pass/fail expectation.
- **Type consistency:** `MarketingContext` fields (`consent`, `fbp`, `fbc`, `ga_client_id`, `ga_session_id`, `ip`, `user_agent`, `event_source_url`, `captured_at`) are used identically in Task 2's Step 1 test assertions and Step 3 implementation.
- **Out of scope (tracked in the audit but not this plan):** F-03/F-04 (native GTM tag migration, replacing the Custom HTML bridges) — large, GTM-UI-heavy refactor, not part of the "Critical + High-ROI" slice. F-20 (docs/analytics-stack.md sync beyond this plan's one addition) — low priority, separate cleanup.
