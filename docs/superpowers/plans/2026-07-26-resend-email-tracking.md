# Resend Email Tracking & Bounce Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a customer's order-confirmation email bounces or is marked spam, someone finds out — today the Resend delivery-status webhook only logs a bare `email_id` that can't be traced back to any order, so a bounced confirmation (e.g. a typo'd address) is invisible.

**Architecture:** Capture the Resend-assigned email id when the order-confirmation email is sent and persist it on the order (mirroring the existing `confirmation_email_sent_at`/`studio_email_sent_at` claim columns). The inbound Resend webhook then looks up that id on `bounced`/`complained` events and fires a Sentry alert carrying the order id, so deliverability failures are correlated and surfaced instead of buried in Workers logs.

**Tech Stack:** Next.js 16 App Router (Cloudflare Workers), TypeScript, Supabase, Resend, Vitest.

## Global Constraints

- Source audit: `docs/audits/event-system-audit.md`, finding F-13 (Medium).
- Scope is the **order-confirmation email only** — the highest-priority customer-facing send per the audit (a bounced confirmation means the buyer never learns their order was received). The same pattern (persist `resend_id`, correlate on webhook) can be extended to shipping-confirmation, print-shipping-confirmation, and return-label emails later; that is explicitly out of scope here to keep this plan reviewable.
- One new migration: `orders.confirmation_email_resend_id TEXT`, nullable, no default.
- Test runner is Vitest: `npx vitest run <path>`.
- Commit after each task.

---

### Task 1: Capture and persist the Resend email id for order-confirmation sends (F-13, part 1)

**Files:**
- Create: `supabase/migrations/20260726130000_orders_confirmation_email_resend_id.sql`
- Modify: `src/lib/email.ts`
- Test: `src/lib/email.test.ts`
- Modify: `src/app/api/stripe/webhook/route.ts`

**Interfaces:**
- Produces: `emailOrderConfirmationToCustomer(params): Promise<{ resendId?: string }>` (was `Promise<void>`). `sendEmailOnceWithClaim`'s `send` parameter widens to `() => Promise<{ resendId?: string } | void>` (its existing studio-email caller returns `void`, still compatible).
- Consumes: nothing new.

- [ ] **Step 1: Create the migration**

```sql
-- supabase/migrations/20260726130000_orders_confirmation_email_resend_id.sql
-- Persist the Resend email id returned when the order-confirmation email is
-- sent, so a later delivered/bounced/complained webhook (matched by this id)
-- can be correlated back to the order it belongs to. Closes F-13: today a
-- bounce is only visible as a bare, uncorrelated email_id in Workers logs.
-- The partial unique index keeps the webhook's equality lookup (Task 2) fast
-- and guarantees a resend id never ambiguously matches more than one order.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_email_resend_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS orders_confirmation_email_resend_id_idx
  ON orders (confirmation_email_resend_id)
  WHERE confirmation_email_resend_id IS NOT NULL;
```

- [ ] **Step 2: Write the failing test**

Add `emailOrderConfirmationToCustomer` to the existing import in `src/lib/email.test.ts`:

Replace:

```ts
import {
  buildLabelToStudioEmail,
  buildNewOrderToStudioEmail,
  buildOrderConfirmationEmail,
  buildPrintShippingConfirmation,
  buildReturnLabelEmail,
  buildShippingConfirmation,
  buildShowroomInterestEmail,
  type CustomerShippingOrder,
  type LabelEmailOrder,
  type OrderConfirmationOrder,
  type ReturnLabelOrder,
} from './email';
```

with:

```ts
import {
  buildLabelToStudioEmail,
  buildNewOrderToStudioEmail,
  buildOrderConfirmationEmail,
  buildPrintShippingConfirmation,
  buildReturnLabelEmail,
  buildShippingConfirmation,
  buildShowroomInterestEmail,
  emailOrderConfirmationToCustomer,
  type CustomerShippingOrder,
  type LabelEmailOrder,
  type OrderConfirmationOrder,
  type ReturnLabelOrder,
} from './email';
```

Also change the `vitest` import to add `vi`/`afterEach`, and add a Sentry mock (this file doesn't currently import `@sentry/nextjs` — Step 5 adds that import to `email.ts`, so the test file needs the same mock convention used elsewhere in this repo, e.g. `src/app/api/stripe/webhook/route.test.ts`):

Replace:

```ts
import { describe, it, expect } from 'vitest';
```

with:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as Sentry from '@sentry/nextjs';

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
```

Add a new describe block:

```ts
describe('emailOrderConfirmationToCustomer — Resend email id', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(Sentry.captureMessage).mockClear();
  });

  const order: OrderConfirmationOrder = {
    id: 'ord-1',
    email: 'buyer@example.com',
    receiver_first_name: 'Anna',
  };

  it('returns the Resend email id from the send response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'em_abc123' }) }));

    const result = await emailOrderConfirmationToCustomer({
      order,
      locale: 'pl',
      env: { RESEND_API_KEY: 'test_key' } as unknown as CloudflareEnv,
    });

    expect(result).toEqual({ resendId: 'em_abc123' });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('returns an undefined resendId and alerts via Sentry when the Resend response has no id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

    const result = await emailOrderConfirmationToCustomer({
      order,
      locale: 'pl',
      env: { RESEND_API_KEY: 'test_key' } as unknown as CloudflareEnv,
    });

    expect(result).toEqual({ resendId: undefined });
    expect(Sentry.captureMessage).toHaveBeenCalledWith('resend_confirmation_missing_id', {
      level: 'warning',
      extra: { order_id: 'ord-1' },
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/email.test.ts -t "Resend email id"`
Expected: FAIL — `emailOrderConfirmationToCustomer` currently returns `Promise<void>`, so `result` is `undefined`, not `{ resendId: ... }`.

- [ ] **Step 4: Make `sendResendTemplate` return the parsed id**

In `src/lib/email.ts`, replace:

```ts
/** Send via a published Resend template (variables pre-escaped by callers). */
async function sendResendTemplate(params: {
  apiKey: string;
  from: string;
  to: string[];
  subject: string;
  templateId: string;
  variables: Record<string, string>;
  attachments?: Array<{ filename: string; content: string }>;
  signal?: AbortSignal;
}): Promise<void> {
  const body: ResendSendBody = {
    from: params.from,
    to: params.to,
    reply_to: EMAIL.contact,
    subject: params.subject,
    template: {
      id: params.templateId,
      variables: params.variables,
    },
  };
  if (params.attachments?.length) {
    body.attachments = params.attachments;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    ...(params.signal ? { signal: params.signal } : {}),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
  }
}
```

with:

```ts
/** Send via a published Resend template (variables pre-escaped by callers). */
async function sendResendTemplate(params: {
  apiKey: string;
  from: string;
  to: string[];
  subject: string;
  templateId: string;
  variables: Record<string, string>;
  attachments?: Array<{ filename: string; content: string }>;
  signal?: AbortSignal;
}): Promise<{ id?: string }> {
  const body: ResendSendBody = {
    from: params.from,
    to: params.to,
    reply_to: EMAIL.contact,
    subject: params.subject,
    template: {
      id: params.templateId,
      variables: params.variables,
    },
  };
  if (params.attachments?.length) {
    body.attachments = params.attachments;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    ...(params.signal ? { signal: params.signal } : {}),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => ({}) as { id?: string });
  return { id: typeof data.id === 'string' ? data.id : undefined };
}
```

- [ ] **Step 5: Make `emailOrderConfirmationToCustomer` return the id, and alert if Resend omits it**

Add the Sentry import to `src/lib/email.ts` (not previously imported in this file):

Replace:

```ts
import { getCloudflareContext } from '@opennextjs/cloudflare';
```

with:

```ts
import { getCloudflareContext } from '@opennextjs/cloudflare';
import * as Sentry from '@sentry/nextjs';
```

Replace:

```ts
export async function emailOrderConfirmationToCustomer(params: {
  order: OrderConfirmationOrder;
  locale: string;
  kind?: OrderEmailKind;
  /** Explicit env (e.g. from the orders CLI) — defaults to the current Workers env. */
  env?: CloudflareEnv;
}): Promise<void> {
  const env = params.env ?? getCloudflareContext().env;
  const { order } = params;

  if (!env.RESEND_API_KEY) {
    throw new Error('Resend not configured: RESEND_API_KEY missing');
  }
  if (!order.email) return;

  const { subject, mainContent } = buildOrderConfirmationEmail(params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    await sendResendTemplate({
      apiKey: env.RESEND_API_KEY,
      from: EMAIL_FROM,
      to: [order.email],
      subject,
      templateId: RESEND_TEMPLATE_ALIASES.shippingConfirmation,
      variables: { MAIN_CONTENT: mainContent },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
```

with:

```ts
export async function emailOrderConfirmationToCustomer(params: {
  order: OrderConfirmationOrder;
  locale: string;
  kind?: OrderEmailKind;
  /** Explicit env (e.g. from the orders CLI) — defaults to the current Workers env. */
  env?: CloudflareEnv;
}): Promise<{ resendId?: string }> {
  const env = params.env ?? getCloudflareContext().env;
  const { order } = params;

  if (!env.RESEND_API_KEY) {
    throw new Error('Resend not configured: RESEND_API_KEY missing');
  }
  if (!order.email) return {};

  const { subject, mainContent } = buildOrderConfirmationEmail(params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const { id } = await sendResendTemplate({
      apiKey: env.RESEND_API_KEY,
      from: EMAIL_FROM,
      to: [order.email],
      subject,
      templateId: RESEND_TEMPLATE_ALIASES.shippingConfirmation,
      variables: { MAIN_CONTENT: mainContent },
      signal: controller.signal,
    });
    if (!id) {
      // The send succeeded (res.ok was true) but Resend's response didn't
      // include an id — unexpected per its API contract. The email itself
      // was still sent, so this must not throw/retry (that would double-send
      // the customer); alert instead, since a later bounce for this order
      // can no longer be correlated (Task 2).
      console.error('emailOrderConfirmationToCustomer: Resend response had no id for order', order.id);
      Sentry.captureMessage('resend_confirmation_missing_id', {
        level: 'warning',
        extra: { order_id: order.id },
      });
    }
    return { resendId: id };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 6: Run the test file to verify it passes**

Run: `npx vitest run src/lib/email.test.ts`
Expected: PASS — all cases, including the pre-existing `build*Email` suites (untouched).

- [ ] **Step 7: Persist the id in `sendEmailOnceWithClaim`**

In `src/app/api/stripe/webhook/route.ts`, replace:

```ts
async function sendEmailOnceWithClaim(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orderId: string,
  column: 'studio_email_sent_at' | 'confirmation_email_sent_at',
  send: () => Promise<unknown>,
): Promise<void> {
  const claimAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from('orders')
    .update({ [column]: claimAt })
    .eq('id', orderId)
    .is(column, null)
    .select('id');
  if (claimErr) {
    console.error(`${column} claim failed for`, orderId, claimErr);
    return;
  }
  if (!claimed || claimed.length === 0) return;

  let sent = false;
  for (let attempt = 0; attempt < 3 && !sent; attempt++) {
    try {
      await send();
      sent = true;
    } catch (err) {
      if (attempt === 2) {
        console.error(`${column} email send failed for`, orderId, err);
        Sentry.captureException(err);
      } else {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }
  if (!sent) {
    const { error: releaseErr } = await supabase
      .from('orders')
      .update({ [column]: null })
      .eq('id', orderId)
      .eq(column, claimAt);
    if (releaseErr) {
      console.error(`${column} claim release failed for`, orderId, releaseErr);
    }
  }
}
```

with:

```ts
async function sendEmailOnceWithClaim(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orderId: string,
  column: 'studio_email_sent_at' | 'confirmation_email_sent_at',
  send: () => Promise<{ resendId?: string } | void>,
): Promise<void> {
  const claimAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from('orders')
    .update({ [column]: claimAt })
    .eq('id', orderId)
    .is(column, null)
    .select('id');
  if (claimErr) {
    console.error(`${column} claim failed for`, orderId, claimErr);
    return;
  }
  if (!claimed || claimed.length === 0) return;

  let sent = false;
  let resendId: string | undefined;
  for (let attempt = 0; attempt < 3 && !sent; attempt++) {
    try {
      const result = await send();
      resendId = result?.resendId;
      sent = true;
    } catch (err) {
      if (attempt === 2) {
        console.error(`${column} email send failed for`, orderId, err);
        Sentry.captureException(err);
      } else {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }
  if (sent && resendId) {
    // Correlates a later delivered/bounced/complained webhook back to this
    // order (see /api/resend/webhook) — only the confirmation-email caller
    // ever returns a resendId, so this is a no-op for the studio email.
    const { error: idErr } = await supabase
      .from('orders')
      .update({ confirmation_email_resend_id: resendId })
      .eq('id', orderId);
    if (idErr) {
      // The email was already sent — retrying would double-send, so this is
      // alert-and-recover, not retry. Recovery is a manual column backfill
      // (`UPDATE orders SET confirmation_email_resend_id = '<resendId>' WHERE
      // id = '<orderId>'`), same manual-reset shape already accepted for a
      // stuck claim release failure below.
      console.error('confirmation_email_resend_id write failed for', orderId, idErr);
      Sentry.captureMessage('confirmation_email_resend_id_write_failed', {
        level: 'warning',
        extra: { order_id: orderId, resend_id: resendId },
      });
    }
  }
  if (!sent) {
    const { error: releaseErr } = await supabase
      .from('orders')
      .update({ [column]: null })
      .eq('id', orderId)
      .eq(column, claimAt);
    if (releaseErr) {
      console.error(`${column} claim release failed for`, orderId, releaseErr);
    }
  }
}
```

No call-site changes needed: both existing `sendEmailOnceWithClaim(...)` calls (studio email, confirmation email) already type-check against the widened `send` signature — the studio email's `() => emailNewOrderToStudio(notifyOrder)` still returns `Promise<void>`.

- [ ] **Step 8: Run the full route test file to verify nothing regressed**

Run: `npx vitest run src/app/api/stripe/webhook/route.test.ts`
Expected: PASS — all cases (this task adds no new route-level test; Task 2 does).

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/20260726130000_orders_confirmation_email_resend_id.sql src/lib/email.ts src/lib/email.test.ts src/app/api/stripe/webhook/route.ts
git commit -m "feat(email): capture and persist the Resend email id for order confirmations"
```

---

### Task 2: Correlate bounce/complaint webhooks to the order and alert (F-13, part 2 — closes the F-19 gap for this route)

**Files:**
- Modify: `src/app/api/resend/webhook/route.ts`
- Create: `src/app/api/resend/webhook/route.test.ts`

**Interfaces:**
- Consumes: `orders.confirmation_email_resend_id` (Task 1), `getSupabaseAdmin` from `@/lib/supabase`, `Sentry.captureMessage` from `@sentry/nextjs`.
- Produces: no new exports — the route now looks up the order by `confirmation_email_resend_id` on `email.bounced`/`email.complained` and fires `Sentry.captureMessage('resend_bounce' | 'resend_complaint', { level: 'warning', extra: { email_id, order_id } })`.

- [ ] **Step 1: Write the failing tests (new file)**

Create `src/app/api/resend/webhook/route.test.ts`. All state a `vi.mock(...)` factory closes over is created inside a single `vi.hoisted(...)` block — `vi.mock` factories are hoisted above ordinary top-level `const`/`let` declarations by Vitest's transform, so a factory referencing a plain module-scope variable declared with `const`/`let` risks a temporal-dead-zone error; `vi.hoisted()` is the documented, unambiguous way to share mutable mock state with a factory:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Sentry from '@sentry/nextjs';

const hoisted = vi.hoisted(() => ({
  verifyResendSignature: vi.fn(),
  parseResendEvent: vi.fn(),
  cfEnv: { RESEND_WEBHOOK_SECRET: 'whsec_test' } as Record<string, string | undefined>,
  ordersSelectResult: { data: null as unknown, error: null as unknown },
}));

vi.mock('@/lib/resend-webhook', () => ({
  verifyResendSignature: hoisted.verifyResendSignature,
  parseResendEvent: hoisted.parseResendEvent,
}));

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: hoisted.cfEnv }),
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'orders') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => hoisted.ordersSelectResult }) }) };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  }),
}));

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import { POST } from './route';

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/resend/webhook', {
    method: 'POST',
    headers: {
      'svix-id': 'msg_1',
      'svix-timestamp': '1700000000',
      'svix-signature': 'v1,sig',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/resend/webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.cfEnv = { RESEND_WEBHOOK_SECRET: 'whsec_test' };
    hoisted.verifyResendSignature.mockResolvedValue(true);
    hoisted.ordersSelectResult = { data: null, error: null };
  });

  it('alerts and correlates the order id when a confirmation email bounces', async () => {
    hoisted.parseResendEvent.mockReturnValue({ type: 'email.bounced', data: { email_id: 'em_123' } });
    hoisted.ordersSelectResult = { data: { id: 'order-1' }, error: null };

    const res = await POST(makeRequest({ type: 'email.bounced', data: { email_id: 'em_123' } }));

    expect(res.status).toBe(200);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('resend_bounce', {
      level: 'warning',
      extra: { email_id: 'em_123', order_id: 'order-1' },
    });
  });

  it('alerts with a null order_id when the bounced email is not a tracked confirmation', async () => {
    hoisted.parseResendEvent.mockReturnValue({ type: 'email.complained', data: { email_id: 'em_999' } });
    hoisted.ordersSelectResult = { data: null, error: null };

    const res = await POST(makeRequest({ type: 'email.complained', data: { email_id: 'em_999' } }));

    expect(res.status).toBe(200);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('resend_complaint', {
      level: 'warning',
      extra: { email_id: 'em_999', order_id: null },
    });
  });

  it('does not alert on a delivered event', async () => {
    hoisted.parseResendEvent.mockReturnValue({ type: 'email.delivered', data: { email_id: 'em_555' } });

    const res = await POST(makeRequest({ type: 'email.delivered', data: { email_id: 'em_555' } }));

    expect(res.status).toBe(200);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('fails closed (500) when RESEND_WEBHOOK_SECRET is not configured', async () => {
    hoisted.cfEnv = {};

    const res = await POST(makeRequest({ type: 'email.bounced', data: { email_id: 'em_1' } }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'not_configured' });
  });

  it('rejects when svix headers are missing', async () => {
    const res = await POST(
      new Request('http://localhost/api/resend/webhook', { method: 'POST', body: '{}' }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_signature' });
  });

  it('rejects when the signature is invalid', async () => {
    hoisted.verifyResendSignature.mockResolvedValue(false);
    hoisted.parseResendEvent.mockReturnValue({ type: 'email.bounced', data: { email_id: 'em_1' } });

    const res = await POST(makeRequest({ type: 'email.bounced', data: { email_id: 'em_1' } }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_signature' });
  });

  it('rejects malformed JSON after a valid signature', async () => {
    const res = await POST(
      new Request('http://localhost/api/resend/webhook', {
        method: 'POST',
        headers: { 'svix-id': 'msg_1', 'svix-timestamp': '1700000000', 'svix-signature': 'v1,sig' },
        body: 'not json',
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request' });
  });
});
```

- [ ] **Step 2: Run the test to verify the new assertions fail**

Run: `npx vitest run src/app/api/resend/webhook/route.test.ts`
Expected: the 4 pre-existing-behavior tests (missing secret/headers/signature/bad JSON) PASS immediately (today's route already handles those correctly). The 2 new bounce/complaint alert tests FAIL — today the route only `console.log`s, it never queries `orders` or calls `Sentry.captureMessage`.

- [ ] **Step 3: Add the correlation lookup and alert**

In `src/app/api/resend/webhook/route.ts`, add imports:

Replace:

```ts
import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { verifyResendSignature, parseResendEvent } from '@/lib/resend-webhook';
```

with:

```ts
import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import * as Sentry from '@sentry/nextjs';
import { verifyResendSignature, parseResendEvent } from '@/lib/resend-webhook';
import { getSupabaseAdmin } from '@/lib/supabase';
```

Replace the final block before the function's closing brace:

```ts
  if (LOGGED_EVENT_TYPES.has(evt.type)) {
    const bounce =
      evt.data.bounce && typeof evt.data.bounce === 'object'
        ? (evt.data.bounce as Record<string, unknown>)
        : null;
    console.log(
      JSON.stringify({
        event: 'resend_webhook',
        type: evt.type,
        email_id: evt.data.email_id ?? null,
        created_at: evt.created_at ?? null,
        ...(bounce ? { bounce_type: bounce.type ?? null } : {}),
      }),
    );
  }

  return NextResponse.json({ received: true });
}
```

with:

```ts
  if (LOGGED_EVENT_TYPES.has(evt.type)) {
    const bounce =
      evt.data.bounce && typeof evt.data.bounce === 'object'
        ? (evt.data.bounce as Record<string, unknown>)
        : null;
    console.log(
      JSON.stringify({
        event: 'resend_webhook',
        type: evt.type,
        email_id: evt.data.email_id ?? null,
        created_at: evt.created_at ?? null,
        ...(bounce ? { bounce_type: bounce.type ?? null } : {}),
      }),
    );
  }

  if ((evt.type === 'email.bounced' || evt.type === 'email.complained') && evt.data.email_id) {
    // Only the order-confirmation email is tracked today (see F-13 plan Task
    // 1) — studio/shipping/print-shipping/return-label sends aren't
    // correlated yet, so an unmatched email_id is expected, not an error.
    const supabase = getSupabaseAdmin();
    const { data: order, error } = await supabase
      .from('orders')
      .select('id')
      .eq('confirmation_email_resend_id', evt.data.email_id)
      .maybeSingle();
    if (error) {
      console.error('resend webhook: order lookup failed for', evt.data.email_id, error);
    }
    Sentry.captureMessage(evt.type === 'email.bounced' ? 'resend_bounce' : 'resend_complaint', {
      level: 'warning',
      extra: { email_id: evt.data.email_id, order_id: (order as { id: string } | null)?.id ?? null },
    });
  }

  return NextResponse.json({ received: true });
}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/app/api/resend/webhook/route.test.ts`
Expected: PASS — all 7 cases.

- [ ] **Step 5: Run the pure-function test file to confirm it's unaffected**

Run: `npx vitest run src/lib/resend-webhook.test.ts`
Expected: PASS — unchanged (this task never touches `src/lib/resend-webhook.ts`).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/resend/webhook/route.ts src/app/api/resend/webhook/route.test.ts
git commit -m "feat(email): alert and correlate order id on a bounced or complained confirmation email"
```

---

## Self-Review Notes

- **Coverage:** F-13's core ask (capture id, persist, correlate, alert) → Tasks 1-2, scoped to the order-confirmation email (the audit's own stated priority example). The F-19 sub-item "no test of the Resend webhook route" → Task 2's new test file, which also covers the route's pre-existing (previously untested) signature/payload-validation behavior as a natural side effect of writing the file from scratch.
- **Placeholder scan:** no TBD/TODO; every step shows exact before/after code and exact commands/expected output.
- **Type consistency:** `{ resendId?: string }` is the return shape threaded consistently through `sendResendTemplate`'s `{ id }`, `emailOrderConfirmationToCustomer`'s `{ resendId }`, and `sendEmailOnceWithClaim`'s `send` parameter type.
- **Out of scope (tracked in the audit but not this plan):** extending the same `resend_id` capture + correlation pattern to `emailShippingConfirmationToCustomer`, `emailPrintShippingConfirmationToCustomer`, and `emailReturnLabelToCustomer` — same pattern, follow-up work once this lands.
