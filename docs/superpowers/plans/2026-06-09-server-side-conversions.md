# Server-side Conversions (Meta CAPI + GA4 MP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send a deduplicated, consent-gated, match-enriched `purchase` conversion to Meta CAPI and GA4 Measurement Protocol from the Stripe webhook, plus browser EMQ (`contents[]` + Advanced Matching) and consent gating of the Meta Pixel.

**Architecture:** Capture cookie/header marketing context at the checkout POST → persist in a new `orders.marketing` jsonb column → a `trackPurchase` webhook dep (fired only on a newly-paid order) loads it, gates on consent, SHA-256-hashes buyer data, and POSTs to both channels via plain `fetch`. Browser changes ride the existing dataLayer→GTM bridges.

**Tech Stack:** Next.js 16 (App Router) on Cloudflare Workers (OpenNext), Supabase (jsonb), Stripe webhooks, Web Crypto (`crypto.subtle`), Vitest, GTM API (`scripts/gtm-api.mjs`).

**Spec:** `docs/superpowers/specs/2026-06-09-server-side-conversions-design.md`

---

## File Structure

**New files:**
- `src/lib/marketing/hash.ts` — Meta-spec normalization + SHA-256 hex (Web Crypto). Pure.
- `src/lib/marketing/hash.test.ts`
- `src/lib/marketing/context.ts` — `MarketingContext` type + cookie parsers (`_ga`, `_ga_*`). Pure.
- `src/lib/marketing/context.test.ts`
- `src/lib/marketing/client-cookies.ts` — browser-side reader of `_fbp`/`_fbc`/`_ga`/`_ga_*`.
- `src/lib/marketing/client-cookies.test.ts`
- `src/lib/marketing/meta-capi.ts` — build + send Meta CAPI Purchase.
- `src/lib/marketing/meta-capi.test.ts`
- `src/lib/marketing/ga4-mp.ts` — build + send GA4 MP purchase.
- `src/lib/marketing/ga4-mp.test.ts`
- `src/lib/marketing/conversions.ts` — orchestrator (load → consent gate → hash → send both).
- `src/lib/marketing/conversions.test.ts`
- `supabase/migrations/<ts>_orders_marketing.sql` — add `orders.marketing jsonb`.

**Modified files:**
- `src/lib/analytics.ts` — add `contents[]` to Meta payload + a `user_data` passthrough type.
- `src/lib/analytics.test.ts` — cover `contents[]`.
- `src/components/shop/CartView.tsx` — forward marketing cookies in the checkout POST; push hashed `user_data` on begin_checkout.
- `src/app/api/checkout/route.ts` — assemble + persist `marketing`.
- `src/lib/webhook.ts` — add `trackPurchase` to `WebhookDeps` + call on `newSale`.
- `src/lib/webhook.test.ts` — cover `trackPurchase` gating.
- `src/app/api/stripe/webhook/route.ts` — implement `trackPurchase` via `conversions.ts`.
- `scripts/gtm-api.mjs` — `contents` + `user_data` in bridges; `consentSettings` on all four tags.
- `.env.example`, `cloudflare-env.d.ts`, `docs/analytics-stack.md` — new secrets + docs.

---

## Task 0: Commit the in-flight prerequisite fixes

The deterministic `event_id`, return-URL secret redaction, and stale-doc fixes are already in the working tree (this session). Land them first so the feature branch starts clean.

- [ ] **Step 1: Verify the analytics tests pass**

Run: `npx vitest run src/lib/analytics.test.ts src/lib/checkout-analytics.test.ts src/components/consent/consent-mode.test.ts`
Expected: PASS (all green).

- [ ] **Step 2: Commit**

```bash
git add src/lib/analytics.ts src/lib/analytics.test.ts docs/analytics-stack.md
git commit -m "fix(analytics): redact Stripe secret + deterministic purchase event_id

- redact payment_intent / payment_intent_client_secret from page_view
- make purchase event_id deterministic (purchase-<orderNo>) for browser/server dedup
- correct stale analytics-stack.md (PLN currency, consent mode already implemented)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 1: Hashing utility (`src/lib/marketing/hash.ts`)

**Files:**
- Create: `src/lib/marketing/hash.ts`
- Test: `src/lib/marketing/hash.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { sha256Hex, normalizeEmail, normalizePhonePl, normalizeText, hashUserField } from './hash';

describe('sha256Hex', () => {
  it('hashes the known Meta example for a normalized email', async () => {
    // Meta docs example: sha256("john_smith@gmail.com")
    expect(await sha256Hex('john_smith@gmail.com')).toBe(
      '62a14e44e7f72cd585f4f8e8e1d3e0c0f9b9f4d4e58e3f5b2c9c2f5a8a3d6c4e'.length === 64
        ? await sha256Hex('john_smith@gmail.com')
        : '',
    );
  });
  it('produces a 64-char lowercase hex digest', async () => {
    const h = await sha256Hex('abc');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // SHA-256("abc") well-known vector
    expect(h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  John@Example.COM ')).toBe('john@example.com');
  });
  it('returns null for blank', () => {
    expect(normalizeEmail('   ')).toBeNull();
  });
});

describe('normalizePhonePl', () => {
  it('strips non-digits and prefixes 48 for a 9-digit local number', () => {
    expect(normalizePhonePl('600 123 456')).toBe('48600123456');
  });
  it('keeps an already-prefixed number', () => {
    expect(normalizePhonePl('+48 600 123 456')).toBe('48600123456');
  });
  it('returns null for blank', () => {
    expect(normalizePhonePl('')).toBeNull();
  });
});

describe('normalizeText', () => {
  it('trims, lowercases, and removes internal whitespace for cities', () => {
    expect(normalizeText('  New York ', { stripSpaces: true })).toBe('newyork');
  });
  it('keeps internal spaces off by default', () => {
    expect(normalizeText('  Anna Maria ')).toBe('anna maria');
  });
});

describe('hashUserField', () => {
  it('returns a single-element array of the hash, or undefined for null', async () => {
    expect(await hashUserField('john@example.com', normalizeEmail)).toEqual([
      await sha256Hex('john@example.com'),
    ]);
    expect(await hashUserField(null, normalizeEmail)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/marketing/hash.test.ts`
Expected: FAIL — "Cannot find module './hash'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/marketing/hash.ts
// SHA-256 + Meta-spec normalization. Pure; runs on Workers via Web Crypto.

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function normalizeEmail(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  return v.length > 0 ? v : null;
}

/** PL phone → E.164 digits, no '+'. 9-digit local numbers get the 48 country code. */
export function normalizePhonePl(raw: string): string | null {
  let digits = raw.replace(/[^0-9]/g, '');
  if (digits.length === 0) return null;
  if (digits.length === 9) digits = `48${digits}`;
  return digits;
}

export function normalizeText(raw: string, opts: { stripSpaces?: boolean } = {}): string | null {
  let v = raw.trim().toLowerCase();
  if (opts.stripSpaces) v = v.replace(/\s+/g, '');
  return v.length > 0 ? v : null;
}

/** Hash one user field into Meta's `[hash]` array shape, or undefined if empty. */
export async function hashUserField(
  raw: string | null | undefined,
  normalize: (v: string) => string | null,
): Promise<string[] | undefined> {
  if (!raw) return undefined;
  const normalized = normalize(raw);
  if (!normalized) return undefined;
  return [await sha256Hex(normalized)];
}
```

- [ ] **Step 4: Fix the first test's tautology and run**

Replace the `john_smith@gmail.com` test body with a concrete vector:

```ts
  it('hashes a normalized email to a stable 64-char digest', async () => {
    const h = await sha256Hex('john@example.com');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(await sha256Hex('john@example.com')); // deterministic
  });
```

Run: `npx vitest run src/lib/marketing/hash.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/marketing/hash.ts src/lib/marketing/hash.test.ts
git commit -m "feat(marketing): SHA-256 + Meta-spec normalization helpers"
```

---

## Task 2: Marketing context type + cookie parsers (`src/lib/marketing/context.ts`)

**Files:**
- Create: `src/lib/marketing/context.ts`
- Test: `src/lib/marketing/context.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { parseGaClientId, parseGaSessionId } from './context';

describe('parseGaClientId', () => {
  it('extracts the client id from a _ga cookie', () => {
    expect(parseGaClientId('GA1.1.1234567890.1680000000')).toBe('1234567890.1680000000');
  });
  it('returns null for malformed or missing cookies', () => {
    expect(parseGaClientId(null)).toBeNull();
    expect(parseGaClientId('GA1.1')).toBeNull();
  });
});

describe('parseGaSessionId', () => {
  it('extracts the session id from a _ga_<id> cookie', () => {
    expect(parseGaSessionId('GS1.1.1680000300.1.1.1680000600.0.0.0')).toBe('1680000300');
  });
  it('returns null for malformed or missing cookies', () => {
    expect(parseGaSessionId(null)).toBeNull();
    expect(parseGaSessionId('GS1.1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/marketing/context.test.ts`
Expected: FAIL — "Cannot find module './context'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/marketing/context.ts
// Marketing context persisted on orders.marketing and consumed by the webhook.

export type MarketingConsent = 'granted' | 'denied';

export type MarketingContext = {
  consent: MarketingConsent;
  fbp: string | null;
  fbc: string | null;
  ga_client_id: string | null;
  ga_session_id: string | null;
  ip: string | null;
  user_agent: string | null;
  event_source_url: string | null;
  captured_at: string;
};

/** _ga = "GA1.1.<client_id_parts>"; client_id is the 3rd + 4th dot-segments. */
export function parseGaClientId(gaCookie: string | null): string | null {
  if (!gaCookie) return null;
  const parts = gaCookie.split('.');
  if (parts.length < 4) return null;
  return `${parts[2]}.${parts[3]}`;
}

/** _ga_<streamId> = "GS1.1.<session_id>.<...>"; session_id is the 3rd dot-segment. */
export function parseGaSessionId(gaSessionCookie: string | null): string | null {
  if (!gaSessionCookie) return null;
  const parts = gaSessionCookie.split('.');
  return parts.length >= 3 ? parts[2] : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/marketing/context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/marketing/context.ts src/lib/marketing/context.test.ts
git commit -m "feat(marketing): MarketingContext type + GA cookie parsers"
```

---

## Task 3: Client-side cookie collector (`src/lib/marketing/client-cookies.ts`)

**Files:**
- Create: `src/lib/marketing/client-cookies.ts`
- Test: `src/lib/marketing/client-cookies.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { collectMarketingCookies } from './client-cookies';

function fakeEnv(cookie: string, search = '') {
  return {
    doc: { cookie } as Document,
    loc: { search } as Location,
    nowMs: 1_680_000_000_000,
  };
}

describe('collectMarketingCookies', () => {
  it('reads _fbp, _fbc, _ga, and a _ga_<id> cookie', () => {
    const { doc, loc, nowMs } = fakeEnv(
      '_fbp=fb.1.1.AAA; _fbc=fb.1.2.BBB; _ga=GA1.1.111.222; _ga_ABC123=GS1.1.999.1',
    );
    expect(collectMarketingCookies(doc, loc, nowMs)).toEqual({
      fbp: 'fb.1.1.AAA',
      fbc: 'fb.1.2.BBB',
      ga_client_id: '111.222',
      ga_session_id: '999',
    });
  });

  it('derives _fbc from an fbclid query param when the cookie is absent', () => {
    const { doc, loc, nowMs } = fakeEnv('_ga=GA1.1.111.222', '?fbclid=XYZ');
    const out = collectMarketingCookies(doc, loc, nowMs);
    expect(out.fbc).toBe('fb.1.1680000000000.XYZ');
  });

  it('returns nulls when nothing is present', () => {
    const { doc, loc, nowMs } = fakeEnv('');
    expect(collectMarketingCookies(doc, loc, nowMs)).toEqual({
      fbp: null,
      fbc: null,
      ga_client_id: null,
      ga_session_id: null,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/marketing/client-cookies.test.ts`
Expected: FAIL — "Cannot find module './client-cookies'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/marketing/client-cookies.ts
// Browser-only: read the JS-readable marketing cookies to forward in the checkout POST.
import { parseGaClientId, parseGaSessionId } from './context';

export type MarketingCookies = {
  fbp: string | null;
  fbc: string | null;
  ga_client_id: string | null;
  ga_session_id: string | null;
};

function readCookie(cookieString: string, name: string): string | null {
  const match = cookieString.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function readGaSessionCookie(cookieString: string): string | null {
  // The _ga_<streamId> name carries a per-stream suffix we don't know at build time.
  const match = cookieString.match(/(?:^|;\s*)_ga_[A-Z0-9]+=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function collectMarketingCookies(
  doc: Pick<Document, 'cookie'> = document,
  loc: Pick<Location, 'search'> = window.location,
  nowMs: number = Date.now(),
): MarketingCookies {
  const cookies = doc.cookie ?? '';
  let fbc = readCookie(cookies, '_fbc');
  if (!fbc) {
    const fbclid = new URLSearchParams(loc.search).get('fbclid');
    if (fbclid) fbc = `fb.1.${nowMs}.${fbclid}`; // Meta's documented _fbc format
  }
  return {
    fbp: readCookie(cookies, '_fbp'),
    fbc,
    ga_client_id: parseGaClientId(readCookie(cookies, '_ga')),
    ga_session_id: parseGaSessionId(readGaSessionCookie(cookies)),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/marketing/client-cookies.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/marketing/client-cookies.ts src/lib/marketing/client-cookies.test.ts
git commit -m "feat(marketing): browser collector for _fbp/_fbc/_ga cookies"
```

---

## Task 4: Meta CAPI sender (`src/lib/marketing/meta-capi.ts`)

**Files:**
- Create: `src/lib/marketing/meta-capi.ts`
- Test: `src/lib/marketing/meta-capi.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { buildMetaPurchasePayload, sendMetaPurchase, type MetaPurchaseInput } from './meta-capi';

const input = (): MetaPurchaseInput => ({
  eventId: 'purchase-pi_1',
  eventTimeSecs: 1_680_000_000,
  eventSourceUrl: 'https://anna-ciok.studio/koszyk/return',
  userData: { em: ['HASH_EM'], client_ip_address: '1.2.3.4', client_user_agent: 'UA', fbp: 'fb.1.1.A', fbc: null },
  value: 318,
  currency: 'PLN',
  contentIds: ['k01', 'v01'],
  contents: [{ id: 'k01', quantity: 1, item_price: 90 }, { id: 'v01', quantity: 1, item_price: 210 }],
  numItems: 2,
  orderId: 'pi_1',
});

describe('buildMetaPurchasePayload', () => {
  it('builds a single Purchase event with dedup id and no null fbc key', () => {
    const payload = buildMetaPurchasePayload(input());
    expect(payload.data).toHaveLength(1);
    const e = payload.data[0];
    expect(e.event_name).toBe('Purchase');
    expect(e.event_id).toBe('purchase-pi_1');
    expect(e.action_source).toBe('website');
    expect(e.user_data.fbc).toBeUndefined(); // null pruned
    expect(e.user_data.fbp).toBe('fb.1.1.A');
    expect(e.custom_data).toMatchObject({ currency: 'PLN', value: 318, num_items: 2, order_id: 'pi_1' });
    expect(e.custom_data.contents).toHaveLength(2);
  });
});

describe('sendMetaPurchase', () => {
  it('POSTs to the graph endpoint and reports ok', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
    const res = await sendMetaPurchase(
      { pixelId: 'PIX', accessToken: 'TOK' },
      input(),
      fetchImpl,
    );
    expect(res.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('https://graph.facebook.com/');
    expect(url).toContain('/PIX/events');
    expect(url).toContain('access_token=TOK');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).not.toHaveProperty('test_event_code');
  });

  it('includes test_event_code when configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{}' });
    await sendMetaPurchase({ pixelId: 'PIX', accessToken: 'TOK', testEventCode: 'TEST123' }, input(), fetchImpl);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).test_event_code).toBe('TEST123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/marketing/meta-capi.test.ts`
Expected: FAIL — "Cannot find module './meta-capi'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/marketing/meta-capi.ts
// Meta Conversions API — Purchase event. Raw fetch (no SDK) for the Workers runtime.

const GRAPH_API_VERSION = 'v21.0';

export type MetaUserData = {
  em?: string[]; ph?: string[]; fn?: string[]; ln?: string[];
  ct?: string[]; zp?: string[]; country?: string[];
  client_ip_address?: string | null;
  client_user_agent?: string | null;
  fbp?: string | null;
  fbc?: string | null;
};

export type MetaContent = { id: string; quantity: number; item_price: number };

export type MetaPurchaseInput = {
  eventId: string;
  eventTimeSecs: number;
  eventSourceUrl: string | null;
  userData: MetaUserData;
  value: number;       // major units (PLN)
  currency: string;    // 'PLN'
  contentIds: string[];
  contents: MetaContent[];
  numItems: number;
  orderId: string;
};

export type MetaCapiConfig = {
  pixelId: string;
  accessToken: string;
  testEventCode?: string;
};

/** Drop null/undefined keys so Meta doesn't reject empty identifiers. */
function pruneUserData(u: MetaUserData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(u)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

export function buildMetaPurchasePayload(input: MetaPurchaseInput) {
  return {
    data: [
      {
        event_name: 'Purchase',
        event_time: input.eventTimeSecs,
        event_id: input.eventId,
        action_source: 'website',
        ...(input.eventSourceUrl ? { event_source_url: input.eventSourceUrl } : {}),
        user_data: pruneUserData(input.userData),
        custom_data: {
          currency: input.currency,
          value: input.value,
          content_type: 'product',
          content_ids: input.contentIds,
          contents: input.contents,
          num_items: input.numItems,
          order_id: input.orderId,
        },
      },
    ],
  };
}

export async function sendMetaPurchase(
  config: MetaCapiConfig,
  input: MetaPurchaseInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${config.pixelId}/events` +
    `?access_token=${encodeURIComponent(config.accessToken)}`;
  const body = {
    ...buildMetaPurchasePayload(input),
    ...(config.testEventCode ? { test_event_code: config.testEventCode } : {}),
  };
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/marketing/meta-capi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/marketing/meta-capi.ts src/lib/marketing/meta-capi.test.ts
git commit -m "feat(marketing): Meta CAPI Purchase sender"
```

---

## Task 5: GA4 Measurement Protocol sender (`src/lib/marketing/ga4-mp.ts`)

**Files:**
- Create: `src/lib/marketing/ga4-mp.ts`
- Test: `src/lib/marketing/ga4-mp.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { buildGa4PurchasePayload, sendGa4Purchase, type Ga4PurchaseInput } from './ga4-mp';

const input = (over: Partial<Ga4PurchaseInput> = {}): Ga4PurchaseInput => ({
  clientId: '111.222',
  sessionId: '999',
  transactionId: 'pi_1',
  value: 300,
  shipping: 18,
  currency: 'PLN',
  items: [{ item_id: 'k01', item_name: 'Kubek Nº 1', price: 90, quantity: 1, item_category: 'kubki', item_brand: 'Anna Ciok Ceramics' }],
  userData: { sha256_email_address: 'HASH_EM' },
  ...over,
});

describe('buildGa4PurchasePayload', () => {
  it('builds a purchase event keyed by transaction_id with session stitching', () => {
    const p = buildGa4PurchasePayload(input());
    expect(p.client_id).toBe('111.222');
    expect(p.events[0].name).toBe('purchase');
    expect(p.events[0].params).toMatchObject({
      transaction_id: 'pi_1', value: 300, shipping: 18, currency: 'PLN', session_id: '999',
    });
    expect(p.user_data).toEqual({ sha256_email_address: 'HASH_EM' });
  });
});

describe('sendGa4Purchase', () => {
  it('skips (returns skipped) when clientId is missing', async () => {
    const fetchImpl = vi.fn();
    const res = await sendGa4Purchase({ measurementId: 'G-X', apiSecret: 'S' }, input({ clientId: null as unknown as string }), fetchImpl);
    expect(res).toEqual({ ok: false, skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs to /mp/collect with measurement_id + api_secret', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' });
    const res = await sendGa4Purchase({ measurementId: 'G-X', apiSecret: 'S' }, input(), fetchImpl);
    expect(res.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('https://www.google-analytics.com/mp/collect');
    expect(url).toContain('measurement_id=G-X');
    expect(url).toContain('api_secret=S');
    expect(init.method).toBe('POST');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/marketing/ga4-mp.test.ts`
Expected: FAIL — "Cannot find module './ga4-mp'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/marketing/ga4-mp.ts
// GA4 Measurement Protocol — purchase event. Raw fetch.

export type Ga4Item = {
  item_id: string;
  item_name: string;
  price: number;
  quantity: number;
  item_category: string;
  item_brand: string;
};

export type Ga4PurchaseInput = {
  clientId: string | null;
  sessionId?: string | null;
  transactionId: string;
  value: number;     // major units (PLN), item subtotal
  shipping: number;  // major units (PLN)
  currency: string;
  items: Ga4Item[];
  userData?: { sha256_email_address?: string };
};

export type Ga4Config = { measurementId: string; apiSecret: string };

export function buildGa4PurchasePayload(input: Ga4PurchaseInput) {
  return {
    client_id: input.clientId,
    ...(input.userData ? { user_data: input.userData } : {}),
    events: [
      {
        name: 'purchase',
        params: {
          transaction_id: input.transactionId,
          currency: input.currency,
          value: input.value,
          shipping: input.shipping,
          items: input.items,
          ...(input.sessionId ? { session_id: input.sessionId } : {}),
          engagement_time_msec: 1,
        },
      },
    ],
  };
}

export async function sendGa4Purchase(
  config: Ga4Config,
  input: Ga4PurchaseInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status?: number; skipped?: boolean }> {
  if (!input.clientId) return { ok: false, skipped: true };
  const url =
    `https://www.google-analytics.com/mp/collect` +
    `?measurement_id=${encodeURIComponent(config.measurementId)}` +
    `&api_secret=${encodeURIComponent(config.apiSecret)}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildGa4PurchasePayload(input)),
  });
  return { ok: res.ok, status: res.status };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/marketing/ga4-mp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/marketing/ga4-mp.ts src/lib/marketing/ga4-mp.test.ts
git commit -m "feat(marketing): GA4 Measurement Protocol purchase sender"
```

---

## Task 6: Conversions orchestrator (`src/lib/marketing/conversions.ts`)

**Files:**
- Create: `src/lib/marketing/conversions.ts`
- Test: `src/lib/marketing/conversions.test.ts`

Note: uses `resolveKnownProducts` from `src/lib/products.ts` (already used by `checkout-analytics.ts`) and `toAnalyticsItem` for category/name; uses `hash.ts` for PII.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { sendPurchaseConversions, type ConversionOrder } from './conversions';

const baseOrder = (over: Partial<ConversionOrder> = {}): ConversionOrder => ({
  payment_intent_id: 'pi_1',
  subtotal: 30000, // grosze
  shipping: 1800,
  total: 31800,
  currency: 'pln',
  email: 'buyer@example.com',
  receiver_first_name: 'Anna',
  receiver_last_name: 'Nowak',
  receiver_phone: '600123456',
  shipping_address: { street: 'X', building_number: '1', city: 'Kraków', post_code: '30-001', country_code: 'PL' },
  marketing: {
    consent: 'granted', fbp: 'fb.1.1.A', fbc: null, ga_client_id: '111.222',
    ga_session_id: '999', ip: '1.2.3.4', user_agent: 'UA',
    event_source_url: 'https://anna-ciok.studio/koszyk/return', captured_at: '2026-06-09T00:00:00Z',
  },
  items: [{ product_id: 'k01', unit_price: 9000 }],
  ...over,
});

function deps(over = {}) {
  return {
    loadOrder: vi.fn().mockResolvedValue(baseOrder()),
    metaConfig: { pixelId: 'PIX', accessToken: 'TOK' },
    ga4Config: { measurementId: 'G-X', apiSecret: 'S' },
    eventTimeSecs: 1_680_000_000,
    sendMeta: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    sendGa4: vi.fn().mockResolvedValue({ ok: true, status: 204 }),
    ...over,
  };
}

describe('sendPurchaseConversions', () => {
  it('does nothing when consent is not granted', async () => {
    const d = deps({ loadOrder: vi.fn().mockResolvedValue(baseOrder({ marketing: { ...baseOrder().marketing!, consent: 'denied' } })) });
    await sendPurchaseConversions('pi_1', d);
    expect(d.sendMeta).not.toHaveBeenCalled();
    expect(d.sendGa4).not.toHaveBeenCalled();
  });

  it('does nothing when the order or marketing context is missing', async () => {
    const d = deps({ loadOrder: vi.fn().mockResolvedValue(null) });
    await sendPurchaseConversions('pi_1', d);
    expect(d.sendMeta).not.toHaveBeenCalled();
  });

  it('sends Meta (value=total/100) and GA4 (value=subtotal/100) with the dedup id', async () => {
    const d = deps();
    await sendPurchaseConversions('pi_1', d);
    const metaInput = d.sendMeta.mock.calls[0][1];
    expect(metaInput.eventId).toBe('purchase-pi_1');
    expect(metaInput.value).toBe(318);          // total grosze → PLN
    expect(metaInput.userData.em).toBeDefined(); // hashed email present
    expect(metaInput.userData.em[0]).toMatch(/^[0-9a-f]{64}$/);
    const ga4Input = d.sendGa4.mock.calls[0][1];
    expect(ga4Input.transactionId).toBe('pi_1');
    expect(ga4Input.value).toBe(300);            // subtotal grosze → PLN
    expect(ga4Input.shipping).toBe(18);
  });

  it('swallows a Meta failure and still attempts GA4', async () => {
    const d = deps({ sendMeta: vi.fn().mockRejectedValue(new Error('graph 500')) });
    await expect(sendPurchaseConversions('pi_1', d)).resolves.toBeUndefined();
    expect(d.sendGa4).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/marketing/conversions.test.ts`
Expected: FAIL — "Cannot find module './conversions'".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/marketing/conversions.ts
// Orchestrates the server-side purchase conversion: load → consent gate → hash → send both.
import * as Sentry from '@sentry/nextjs';
import { resolveKnownProducts } from '../products';
import { toAnalyticsItem } from '../analytics';
import { hashUserField, normalizeEmail, normalizePhonePl, normalizeText, sha256Hex } from './hash';
import { sendMetaPurchase, type MetaCapiConfig, type MetaPurchaseInput } from './meta-capi';
import { sendGa4Purchase, type Ga4Config, type Ga4PurchaseInput } from './ga4-mp';
import type { MarketingContext } from './context';
import type { DeliveryAddress } from '../shipx';

export type ConversionOrder = {
  payment_intent_id: string;
  subtotal: number; // grosze
  shipping: number; // grosze
  total: number;    // grosze
  currency: string;
  email: string | null;
  receiver_first_name: string | null;
  receiver_last_name: string | null;
  receiver_phone: string | null;
  shipping_address: DeliveryAddress | null;
  marketing: MarketingContext | null;
  items: Array<{ product_id: string; unit_price: number }>;
};

export type ConversionsDeps = {
  loadOrder: (paymentIntentId: string) => Promise<ConversionOrder | null>;
  metaConfig: MetaCapiConfig;
  ga4Config: Ga4Config;
  eventTimeSecs: number;
  sendMeta?: typeof sendMetaPurchase;
  sendGa4?: typeof sendGa4Purchase;
};

export async function sendPurchaseConversions(
  paymentIntentId: string,
  deps: ConversionsDeps,
): Promise<void> {
  const order = await deps.loadOrder(paymentIntentId);
  if (!order || !order.marketing || order.marketing.consent !== 'granted') return;

  const m = order.marketing;
  const ids = order.items.map((i) => i.product_id);
  const products = resolveKnownProducts(ids);
  const analyticsItems = products.map((p) => toAnalyticsItem(p));

  const emailHash = await hashUserField(order.email, normalizeEmail);

  const metaInput: MetaPurchaseInput = {
    eventId: `purchase-${order.payment_intent_id}`,
    eventTimeSecs: deps.eventTimeSecs,
    eventSourceUrl: m.event_source_url,
    userData: {
      em: emailHash,
      ph: await hashUserField(order.receiver_phone, normalizePhonePl),
      fn: await hashUserField(order.receiver_first_name, (v) => normalizeText(v)),
      ln: await hashUserField(order.receiver_last_name, (v) => normalizeText(v)),
      ct: await hashUserField(order.shipping_address?.city ?? null, (v) => normalizeText(v, { stripSpaces: true })),
      zp: await hashUserField(order.shipping_address?.post_code ?? null, (v) => normalizeText(v, { stripSpaces: true })),
      country: await hashUserField(order.shipping_address?.country_code ?? null, (v) => normalizeText(v, { stripSpaces: true })),
      client_ip_address: m.ip,
      client_user_agent: m.user_agent,
      fbp: m.fbp,
      fbc: m.fbc,
    },
    value: order.total / 100,
    currency: order.currency.toUpperCase(),
    contentIds: ids,
    contents: analyticsItems.map((it) => ({ id: it.item_id, quantity: 1, item_price: it.price })),
    numItems: ids.length,
    orderId: order.payment_intent_id,
  };

  const ga4Input: Ga4PurchaseInput = {
    clientId: m.ga_client_id,
    sessionId: m.ga_session_id,
    transactionId: order.payment_intent_id,
    value: order.subtotal / 100,
    shipping: order.shipping / 100,
    currency: order.currency.toUpperCase(),
    items: analyticsItems.map((it) => ({
      item_id: it.item_id,
      item_name: it.item_name,
      price: it.price,
      quantity: 1,
      item_category: it.item_category,
      item_brand: it.item_brand,
    })),
    ...(emailHash ? { userData: { sha256_email_address: emailHash[0] } } : {}),
  };

  const sendMeta = deps.sendMeta ?? sendMetaPurchase;
  const sendGa4 = deps.sendGa4 ?? sendGa4Purchase;

  try {
    await sendMeta(deps.metaConfig, metaInput);
  } catch (err) {
    console.error('meta capi purchase failed for', paymentIntentId, err);
    Sentry.captureException(err);
  }
  try {
    await sendGa4(deps.ga4Config, ga4Input);
  } catch (err) {
    console.error('ga4 mp purchase failed for', paymentIntentId, err);
    Sentry.captureException(err);
  }
}

// Re-export for callers that build the time argument.
export { sha256Hex };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/marketing/conversions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/marketing/conversions.ts src/lib/marketing/conversions.test.ts
git commit -m "feat(marketing): purchase conversions orchestrator (consent-gated)"
```

---

## Task 7: Database migration — `orders.marketing`

**Files:**
- Create: `supabase/migrations/20260609120000_orders_marketing.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- Add marketing context captured at checkout, consumed by the Stripe webhook to
-- send consent-gated server-side conversions (Meta CAPI + GA4 MP).
alter table public.orders
  add column if not exists marketing jsonb;

comment on column public.orders.marketing is
  'Marketing context captured at checkout: {consent, fbp, fbc, ga_client_id, ga_session_id, ip, user_agent, event_source_url, captured_at}. Consumed by the Stripe webhook for server-side conversions.';
```

- [ ] **Step 2: Apply to the dev Supabase first**

Apply the migration to the separate dev project (local CLI or the dev project ref). Verify the column exists:

Run (dev): `select column_name from information_schema.columns where table_name='orders' and column_name='marketing';`
Expected: one row, `marketing`.

- [ ] **Step 3: Apply to prod via Supabase MCP**

Use the Supabase MCP `apply_migration` against project `wnlysejenowymjdxlnaq` with name `orders_marketing` and the SQL above. **Confirm with the user before applying to prod.**
Then verify with `execute_sql`:
`select column_name from information_schema.columns where table_name='orders' and column_name='marketing';`
Expected: one row.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260609120000_orders_marketing.sql
git commit -m "feat(db): add orders.marketing jsonb for server-side conversions"
```

---

## Task 8: Capture marketing context at checkout

**Files:**
- Modify: `src/components/shop/CartView.tsx` (forward cookies in POST body)
- Modify: `src/app/api/checkout/route.ts` (assemble + persist `marketing`)

- [ ] **Step 1: Forward cookies from CartView**

In `CartView.tsx`, import the collector and include its output in the existing checkout `fetch` body. Add near the other marketing imports:

```ts
import { collectMarketingCookies } from '@/lib/marketing/client-cookies';
```

In the `handlePay` flow, find the `fetch('/api/checkout', { ... body: JSON.stringify({ ... }) })` call and add a `marketing_cookies` field to the posted object:

```ts
        body: JSON.stringify({
          ids: products.map((p) => p.id),
          locale,
          delivery_method: ship,
          contact,
          target_point: targetPoint,
          address,
          marketing_cookies: collectMarketingCookies(),
        }),
```

(Preserve whatever fields the existing body already sends; only add `marketing_cookies`.)

- [ ] **Step 2: Assemble + persist marketing in the checkout route**

In `src/app/api/checkout/route.ts`, add imports:

```ts
import { readConsent } from '@/components/consent/consent-mode';
import type { MarketingContext } from '@/lib/marketing/context';
```

After `const clientIp = ...` (it already exists) and before the `orders` insert, build the context:

```ts
  const cookieHeader = req.headers.get('cookie') ?? '';
  const consent = readConsent(cookieHeader) === 'granted' ? 'granted' : 'denied';
  const mc = (body.marketing_cookies ?? {}) as Record<string, unknown>;
  const str2 = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
  const marketing: MarketingContext = {
    consent,
    fbp: str2(mc.fbp),
    fbc: str2(mc.fbc),
    ga_client_id: str2(mc.ga_client_id),
    ga_session_id: str2(mc.ga_session_id),
    ip: clientIp,
    user_agent: req.headers.get('user-agent'),
    event_source_url: req.headers.get('referer'),
    captured_at: new Date().toISOString(),
  };
```

Then add `marketing` to the `orders` insert object:

```ts
    locale,
    marketing,
```

- [ ] **Step 3: Typecheck + build the affected route**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the checkout-related unit tests**

Run: `npx vitest run src/lib/checkout.test.ts src/lib/shipx.test.ts`
Expected: PASS (no regressions; these don't assert on `marketing`).

- [ ] **Step 5: Commit**

```bash
git add src/components/shop/CartView.tsx src/app/api/checkout/route.ts
git commit -m "feat(checkout): capture marketing context (cookies, ip, ua, consent)"
```

---

## Task 9: Wire `trackPurchase` into the webhook

**Files:**
- Modify: `src/lib/webhook.ts` (add dep + call on newSale)
- Modify: `src/lib/webhook.test.ts` (gating tests)
- Modify: `src/app/api/stripe/webhook/route.ts` (implement dep)

- [ ] **Step 1: Add the failing webhook tests**

In `src/lib/webhook.test.ts`, add `trackPurchase: vi.fn().mockResolvedValue(undefined)` to the `deps()` defaults object, then add:

```ts
  it('on a new sale: fires trackPurchase', async () => {
    const d = deps();
    await handleStripeEvent({ type: 'payment_intent.succeeded', data: { object: pi() } } as unknown as Stripe.Event, d);
    expect(d.trackPurchase).toHaveBeenCalledWith('pi_1');
  });

  it('already processed (not a new sale): does NOT fire trackPurchase', async () => {
    const d = deps({ markPaid: vi.fn().mockResolvedValue(false) });
    await handleStripeEvent({ type: 'payment_intent.succeeded', data: { object: pi() } } as unknown as Stripe.Event, d);
    expect(d.trackPurchase).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/webhook.test.ts`
Expected: FAIL — `trackPurchase` is not a function / not called.

- [ ] **Step 3: Add the dep to `webhook.ts`**

In `WebhookDeps` add:

```ts
  /** Fire server-side purchase conversions (Meta CAPI + GA4 MP). Best-effort: errors swallowed by the impl. */
  trackPurchase: (paymentIntentId: string) => Promise<void>;
```

In the `payment_intent.succeeded` case, after `if (newlySold) deps.revalidate('inventory');` add:

```ts
      if (newlySold) await deps.trackPurchase(pi.id);
```

(Keep `ensureInvoiced` / `createShipment` calls below unchanged.)

- [ ] **Step 4: Run to verify the webhook unit tests pass**

Run: `npx vitest run src/lib/webhook.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the dep in the route**

In `src/app/api/stripe/webhook/route.ts` add imports:

```ts
import { sendPurchaseConversions, type ConversionOrder } from '@/lib/marketing/conversions';
```

Add the `trackPurchase` dep to the `handleStripeEvent(event, { ... })` object (best-effort — swallow so Stripe still gets 200):

```ts
    trackPurchase: async (pi) => {
      try {
        const metaToken = env.META_CAPI_ACCESS_TOKEN;
        const ga4Secret = env.GA4_API_SECRET;
        const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
        const measurementId = process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
        if (!metaToken || !ga4Secret || !pixelId || !measurementId) return;
        await sendPurchaseConversions(pi, {
          loadOrder: async (paymentIntentId) => {
            const { data } = await supabase
              .from('orders')
              .select(
                'payment_intent_id, subtotal, shipping, total, currency, email, ' +
                  'receiver_first_name, receiver_last_name, receiver_phone, shipping_address, marketing',
              )
              .eq('payment_intent_id', paymentIntentId)
              .single();
            if (!data) return null;
            const { data: itemRows } = await supabase
              .from('order_items')
              .select('product_id, unit_price')
              .eq('payment_intent_id', paymentIntentId);
            return {
              ...(data as Omit<ConversionOrder, 'items'>),
              items: (itemRows as ConversionOrder['items'] | null) ?? [],
            };
          },
          metaConfig: {
            pixelId,
            accessToken: metaToken,
            ...(env.META_TEST_EVENT_CODE ? { testEventCode: env.META_TEST_EVENT_CODE } : {}),
          },
          ga4Config: { measurementId, apiSecret: ga4Secret },
          eventTimeSecs: Math.floor(Date.now() / 1000),
        });
      } catch (err) {
        console.error('trackPurchase failed for', pi, err);
      }
    },
```

Note: `order_items` has no `payment_intent_id` column — join via `order_id`. Adjust the items query to first resolve `order_id`. Replace the items query with:

```ts
            const { data: itemRows } = await supabase
              .from('order_items')
              .select('product_id, unit_price')
              .eq('order_id', (data as { id?: string }).id ?? '');
```

and add `id` to the orders `.select(...)` list. (Verify `orders.id` is selected.)

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (If `env.META_CAPI_ACCESS_TOKEN` etc. are untyped, Task 12 adds them to `cloudflare-env.d.ts` — do Task 12 before this typecheck if needed.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/webhook.ts src/lib/webhook.test.ts src/app/api/stripe/webhook/route.ts
git commit -m "feat(webhook): fire server-side purchase conversions on new sale"
```

---

## Task 10: Browser EMQ — `contents[]` on Meta events

**Files:**
- Modify: `src/lib/analytics.ts` (add `contents` to `MetaPayload` + `withMeta`)
- Modify: `src/lib/analytics.test.ts`
- Modify: `scripts/gtm-api.mjs` (pass `contents` through the Meta bridge)

- [ ] **Step 1: Write the failing test**

In `src/lib/analytics.test.ts`, inside the `analytics ecommerce payloads` describe, add:

```ts
  it('includes a Meta contents[] array with per-item price/quantity', () => {
    const event = buildAddToCartEvent(product('k01'), { eventId: 'evt-atc-k01' });
    expect(event.meta?.contents).toEqual([{ id: 'k01', quantity: 1, item_price: 90 }]);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/analytics.test.ts`
Expected: FAIL — `meta.contents` is undefined.

- [ ] **Step 3: Add `contents` to the Meta payload**

In `src/lib/analytics.ts`, extend `MetaPayload`:

```ts
export type MetaContent = { id: string; quantity: 1; item_price: number };

export type MetaPayload = {
  event_name: MetaStandardEvent;
  content_ids: string[];
  content_type: 'product';
  contents: MetaContent[];
  currency: typeof ANALYTICS_CURRENCY;
  value: number;
  num_items: number;
  event_id: string;
  order_id?: string;
};
```

In `withMeta`, populate `contents` from the items:

```ts
  const items = event.ecommerce?.items ?? [];
  return {
    ...event,
    meta: {
      event_name: eventName,
      content_ids: items.map((item) => item.item_id),
      content_type: 'product',
      contents: items.map((item) => ({ id: item.item_id, quantity: 1, item_price: item.price })),
      currency: ANALYTICS_CURRENCY,
      value: metaValue,
      num_items: items.length,
      event_id: eventId,
      ...(orderId ? { order_id: orderId } : {}),
    },
  };
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/analytics.test.ts`
Expected: PASS.

- [ ] **Step 5: Pass `contents` through the Meta bridge**

In `scripts/gtm-api.mjs`, in `metaBridgeHtml`, add `contents` to the `params` object built from `meta`:

```js
    var params = {
      content_ids: meta.content_ids,
      content_type: meta.content_type,
      contents: meta.contents,
      currency: meta.currency,
      value: meta.value,
      num_items: meta.num_items
    };
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/analytics.ts src/lib/analytics.test.ts scripts/gtm-api.mjs
git commit -m "feat(analytics): add Meta contents[] for richer EMQ/DPA signal"
```

---

## Task 11: Browser Advanced Matching at `begin_checkout`

**Files:**
- Modify: `src/lib/analytics.ts` (carry an optional `user_data` on the event)
- Modify: `src/components/shop/CartView.tsx` (hash email client-side, pass to begin_checkout)
- Modify: `src/lib/checkout-analytics.ts` (thread `userData` into begin_checkout)
- Modify: `scripts/gtm-api.mjs` (bridges apply `user_data`)

- [ ] **Step 1: Add `user_data` to the begin_checkout builder (test-first)**

In `src/lib/analytics.test.ts`, extend the begin_checkout test (or add one):

```ts
  it('attaches hashed user_data to begin_checkout when provided', () => {
    const e = buildBeginCheckoutEvent([product('k01')], {
      shippingCost: 18, shippingMethod: 'kurier', eventId: 'evt-bc',
      userData: { em: 'HASH_EM' },
    });
    expect(e.user_data).toEqual({ em: 'HASH_EM' });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/analytics.test.ts`
Expected: FAIL — `user_data` undefined / type error.

- [ ] **Step 3: Implement**

In `analytics.ts`, extend `CheckoutOptions`:

```ts
type CheckoutOptions = EventOptions & {
  shippingCost: number;
  shippingMethod: string;
  userData?: { em?: string };
};
```

In `buildBeginCheckoutEvent`, spread `user_data` onto the returned event when present:

```ts
  const base = withMeta(
    {
      event: 'begin_checkout',
      event_id: eventId,
      shipping_tier: options.shippingMethod,
      checkout_total: orderTotal,
      ...(options.userData ? { user_data: options.userData } : {}),
      ecommerce: ecommerce(items),
    },
    'InitiateCheckout',
    eventId,
    orderTotal,
  );
  return base;
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/analytics.test.ts`
Expected: PASS.

- [ ] **Step 5: Hash email client-side in CartView and thread it through**

In `CartView.tsx`, before `pushCheckoutStarted(...)`, compute the hash (reuse `sha256Hex` from `@/lib/marketing/hash`) and pass it. Since `sha256Hex` is async, compute it just before the push:

```ts
import { sha256Hex } from '@/lib/marketing/hash';
// ...
    const emailNorm = contact.email.trim().toLowerCase();
    const em = emailNorm ? await sha256Hex(emailNorm) : undefined;
    pushCheckoutStarted(products, { shippingCost: shipCost, shippingMethod: ship, userData: em ? { em } : undefined });
```

In `src/lib/checkout-analytics.ts`, extend `CheckoutStartOptions` with `userData?: { em?: string }` and pass it into `buildBeginCheckoutEvent`:

```ts
type CheckoutStartOptions = {
  shippingCost: number;
  shippingMethod: string;
  userData?: { em?: string };
  push?: (event: DataLayerEvent) => void;
};
// ...
export function pushCheckoutStarted(
  products: Product[],
  { shippingCost, shippingMethod, userData, push = pushDataLayer }: CheckoutStartOptions,
): void {
  push(buildBeginCheckoutEvent(products, { shippingCost, shippingMethod, userData }));
}
```

- [ ] **Step 6: Apply `user_data` in the GTM bridges**

In `scripts/gtm-api.mjs`:

Meta bridge — before the `fbq('track', ...)` call, apply Advanced Matching:

```js
  if (payload.user_data && payload.user_data.em) {
    window.fbq('set', 'userData', { em: payload.user_data.em });
  }
```

GA4 bridge — set user-provided data for Enhanced Conversions, and exclude `user_data` from the spread params:

```js
  for (var key in payload) {
    if (Object.prototype.hasOwnProperty.call(payload, key) && key !== 'event' && key !== 'meta' && key !== 'ecommerce' && key !== 'acc_origin' && key !== 'user_data') {
      params[key] = payload[key];
    }
  }
  if (payload.user_data && payload.user_data.em) {
    window.gtag('set', 'user_data', { sha256_email_address: payload.user_data.em });
  }
```

- [ ] **Step 7: Run analytics tests + typecheck**

Run: `npx vitest run src/lib/analytics.test.ts src/lib/checkout-analytics.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/analytics.ts src/lib/analytics.test.ts src/lib/checkout-analytics.ts src/components/shop/CartView.tsx scripts/gtm-api.mjs
git commit -m "feat(analytics): browser Advanced Matching (hashed email) at begin_checkout"
```

---

## Task 12: GTM consent gating + env/secrets/types/docs

**Files:**
- Modify: `scripts/gtm-api.mjs` (consentSettings on the four tags)
- Modify: `.env.example`, `cloudflare-env.d.ts`, `docs/analytics-stack.md`

- [ ] **Step 1: Add consent gating to the GTM tags**

In `scripts/gtm-api.mjs`, extend `customHtmlTag(...)` to accept a `consentTypes` option and emit `consentSettings`:

```js
function customHtmlTag(name, html, firingTriggerId, options = {}) {
  return {
    name,
    type: 'html',
    parameter: [
      templateParam('html', html),
      { key: 'supportDocumentWrite', type: 'boolean', value: 'false' },
    ],
    firingTriggerId,
    tagFiringOption: options.oncePerLoad ? 'oncePerLoad' : 'oncePerEvent',
    ...(options.priority
      ? { priority: { key: 'priority', type: 'integer', value: String(options.priority) } }
      : {}),
    ...(options.consentTypes
      ? {
          consentSettings: {
            consentStatus: 'needed',
            consentType: options.consentTypes.map((t) => templateParam('', t)).map((p) => ({ type: 'template', value: p.value })),
          },
        }
      : {}),
  };
}
```

Then pass `consentTypes` at each call site:
- `ACC - GA4 base` and `ACC - GA4 dataLayer bridge`: `{ ..., consentTypes: ['analytics_storage'] }`
- `ACC - Meta Pixel base` and `ACC - Meta dataLayer bridge`: `{ ..., consentTypes: ['ad_storage'] }`

(For the GA4 base, merge with the existing `{ oncePerLoad: true, priority: 20 }` options; for the Meta base, merge with `{ oncePerLoad: true, priority: 10 }`.)

- [ ] **Step 2: Add new env vars to `.env.example`**

Append under the runtime-secrets section:

```bash
# Server-side conversions (Meta Conversions API + GA4 Measurement Protocol)
META_CAPI_ACCESS_TOKEN=        # Meta system-user token with ads_management/CAPI scope
META_TEST_EVENT_CODE=          # optional: Events Manager → Test Events code (leave empty in prod)
GA4_API_SECRET=                # GA4 Admin → Data Streams → Measurement Protocol API secrets
```

- [ ] **Step 3: Type the new secrets in `cloudflare-env.d.ts`**

Add to the env interface (match the existing style in that file):

```ts
  META_CAPI_ACCESS_TOKEN?: string;
  META_TEST_EVENT_CODE?: string;
  GA4_API_SECRET?: string;
```

- [ ] **Step 4: Document in `docs/analytics-stack.md`**

Add a "Server-side conversions" section noting: the webhook sends `Purchase` (Meta CAPI) + `purchase` (GA4 MP) on a newly-paid order, deduplicated by `event_id`/`transaction_id` = PaymentIntent id; gated on `orders.marketing.consent === 'granted'`; secrets `META_CAPI_ACCESS_TOKEN`, `GA4_API_SECRET`, optional `META_TEST_EVENT_CODE`.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/gtm-api.mjs .env.example cloudflare-env.d.ts docs/analytics-stack.md
git commit -m "feat(analytics): GTM consent gating + server-conversion secrets/docs"
```

---

## Task 13: Full verification pass

- [ ] **Step 1: Run the whole unit suite**

Run: `npm run test`
Expected: PASS (including all new `src/lib/marketing/*.test.ts`).

- [ ] **Step 2: Lint + typecheck**

Run: `npm run lint && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Set prod secrets**

```bash
npx wrangler secret put META_CAPI_ACCESS_TOKEN
npx wrangler secret put GA4_API_SECRET
# META_TEST_EVENT_CODE only while validating; remove before go-live
```

- [ ] **Step 4: Re-publish GTM with consent gating**

Run: `npm run gtm:setup -- --publish`
Then confirm in GTM Preview that the Meta tags are blocked until consent is granted.

- [ ] **Step 5: Validate live**

- Meta Events Manager → Test Events (set `META_TEST_EVENT_CODE`): complete a test-mode purchase, confirm one `Purchase` "received from both Browser and Server" (deduped) and an improved Event Match Quality.
- GA4 DebugView: confirm a single `purchase` with the correct `transaction_id`, value, and items.
- Remove `META_TEST_EVENT_CODE` from prod once validated.

---

## Self-Review

- **Spec coverage:** §1 data model → Task 7; §2 capture → Task 8; §3 modules → Tasks 1,4,5,6; §5 dedup keys → Tasks 4/5/6 (ids = `pi`); §6 consent → server (Task 6) + browser GTM (Task 12); §7 EMQ → Tasks 10 (contents) + 11 (Advanced Matching); §8 error handling → Task 6 (swallow + Sentry) + Task 9 (route swallow); §9 secrets → Task 12; §10 testing → every task + Task 13; §11 rollout → Task 13. Prerequisite event_id → Task 0.
- **Placeholder scan:** none — every code step has full code; the one tautological test vector in Task 1 is corrected in Task 1 Step 4.
- **Type consistency:** `MarketingContext` (context.ts) is the single source used by client-cookies, checkout route, conversions, and the orders column. `sendMetaPurchase`/`sendGa4Purchase` signatures match how `conversions.ts` and its test inject them. `MetaPayload.contents` (analytics.ts) and `MetaContent` in meta-capi.ts are distinct types by design (browser dataLayer vs server payload) — not shared, no drift risk.
- **Known integration check to confirm during execution:** `order_items` is joined by `order_id` (no `payment_intent_id` column) — handled explicitly in Task 9 Step 5.
