import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Stripe: only constructEventAsync matters for the payment_failed path ---
const constructEventAsync = vi.fn();
vi.mock('@/lib/stripe', () => ({
  getStripe: () => ({ webhooks: { constructEventAsync }, refunds: { create: vi.fn() } }),
}));

// --- Cloudflare env (webhook secret + no conversion creds so trackPurchase no-ops) ---
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: { STRIPE_WEBHOOK_SECRET: 'whsec_test' } }),
}));

vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }));

// --- Supabase: swapped per test ---
let supabaseImpl: unknown;
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => supabaseImpl }));

// --- Heavy collaborators unused on the failed path: neutralise to keep imports clean ---
vi.mock('@/lib/inpost', () => ({ getInPost: () => ({}) }));
vi.mock('@/lib/invoice', () => ({ createOrderInvoice: vi.fn() }));
vi.mock('@/lib/shipment', () => ({ createOrderShipment: vi.fn() }));
vi.mock('@/lib/email', () => ({ emailNewOrderToStudio: vi.fn(), emailOrderConfirmationToCustomer: vi.fn() }));
vi.mock('@/lib/resend-events', () => ({ sendPurchasedEvent: vi.fn() }));
vi.mock('@/lib/marketing/conversions', () => ({ sendPurchaseConversions: vi.fn() }));

import { POST } from './route';

type Result = { data: unknown; error: unknown };

/** A chainable query stub whose `.eq()` returns itself and whose terminal method resolves `result`. */
function chain(terminal: 'select' | 'maybeSingle', result: Result) {
  const b: Record<string, unknown> = { eq: () => b };
  b[terminal] = async () => result;
  return b;
}

/**
 * Supabase fake for releaseHold. `ordersUpdate` is the `pending→failed` transition
 * result; `ordersSelect` is the retry-path fallback fetch; `pieceUpdate` is the
 * piece_state release. Records the piece_state update payload so tests can assert
 * the release actually ran (and with the right target status).
 */
function makeSupabase(plan: { ordersUpdate: Result; ordersSelect: Result; pieceUpdate: Result }) {
  const calls = { pieceUpdatePayload: undefined as unknown, pieceUpdated: false };
  const supabase = {
    from(table: string) {
      if (table === 'orders') {
        return {
          update: () => chain('select', plan.ordersUpdate),
          select: () => chain('maybeSingle', plan.ordersSelect),
        };
      }
      if (table === 'piece_state') {
        return {
          update: (payload: unknown) => {
            calls.pieceUpdatePayload = payload;
            calls.pieceUpdated = true;
            return chain('select', plan.pieceUpdate);
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { supabase, calls };
}

function failedEventRequest() {
  constructEventAsync.mockResolvedValue({
    type: 'payment_intent.payment_failed',
    data: { object: { id: 'pi_1' } },
  });
  return new Request('http://localhost/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'sig_test' },
    body: '{}',
  });
}

describe('webhook releaseHold', () => {
  beforeEach(() => {
    constructEventAsync.mockReset();
  });

  it('first delivery: transitions pending→failed and relists the reserved pieces', async () => {
    const { supabase, calls } = makeSupabase({
      ordersUpdate: { data: [{ id: 'o1', private_sale_id: null }], error: null },
      ordersSelect: { data: null, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(failedEventRequest());

    expect(res.status).toBe(200);
    expect(calls.pieceUpdated).toBe(true);
    expect(calls.pieceUpdatePayload).toEqual({ status: 'available', reserved_until: null, order_id: null });
  });

  it('retry after the order is already failed: still re-attempts the release (no stuck reserved pieces)', async () => {
    const { supabase, calls } = makeSupabase({
      // pending→failed update matches nothing on the retry (already failed)
      ordersUpdate: { data: [], error: null },
      // fallback fetch finds the already-failed order
      ordersSelect: { data: { id: 'o1', private_sale_id: null }, error: null },
      pieceUpdate: { data: [{ product_id: 'k01' }], error: null },
    });
    supabaseImpl = supabase;

    const res = await POST(failedEventRequest());

    expect(res.status).toBe(200);
    // Without the retry-safe fallback the release would be skipped and pieces stay reserved.
    expect(calls.pieceUpdated).toBe(true);
  });
});
