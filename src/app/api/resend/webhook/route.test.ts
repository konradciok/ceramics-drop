import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Cloudflare env: mutable per-test so the fail-closed path can be exercised ---
let cfEnv: Record<string, string | undefined> = { RESEND_WEBHOOK_SECRET: 'whsec_x' };
vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext: () => ({ env: cfEnv }) }));

// --- Signature + event parsing: stubbed so the test drives the event shape ---
// vi.hoisted: the vi.mock factory returns these refs directly (evaluated at
// hoist time), so they must be initialised before the hoisted mock runs.
const { verifyResendSignature, parseResendEvent } = vi.hoisted(() => ({
  verifyResendSignature: vi.fn(async () => true),
  parseResendEvent: vi.fn(),
}));
vi.mock('@/lib/resend-webhook', () => ({ verifyResendSignature, parseResendEvent }));

// --- Supabase: resend_email_id → order lookup (dynamic import in the route) ---
const ordersMaybeSingle = vi.fn(async () => ({ data: { id: 'ord_1' } }));
vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: ordersMaybeSingle }) }) }),
  }),
}));

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }));

import { POST } from './route';
import * as Sentry from '@sentry/nextjs';

const SVIX = { 'svix-id': 'msg_1', 'svix-timestamp': '1', 'svix-signature': 'v1,sig' };
function req(body: string, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/resend/webhook', { method: 'POST', headers, body });
}

describe('resend webhook route (F-13)', () => {
  beforeEach(() => {
    cfEnv = { RESEND_WEBHOOK_SECRET: 'whsec_x' };
    verifyResendSignature.mockResolvedValue(true);
    parseResendEvent.mockReset();
    ordersMaybeSingle.mockResolvedValue({ data: { id: 'ord_1' } });
    vi.mocked(Sentry.captureMessage).mockClear();
  });

  it('fails closed (500) when RESEND_WEBHOOK_SECRET is unset', async () => {
    cfEnv = {};
    const res = await POST(req('{}', SVIX));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'not_configured' });
  });

  it('rejects (400) when the svix-* headers are missing', async () => {
    const res = await POST(req('{}'));
    expect(res.status).toBe(400);
    expect(parseResendEvent).not.toHaveBeenCalled();
  });

  it('email.bounced with a matching email_id → 200 + Sentry alert names the order', async () => {
    parseResendEvent.mockReturnValue({
      type: 'email.bounced',
      data: { email_id: 'em_1', bounce: { type: 'hard' } },
      created_at: '2026-07-28T00:00:00Z',
    });

    const res = await POST(req(JSON.stringify({ any: 'payload' }), SVIX));

    expect(res.status).toBe(200);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'resend email.bounced',
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({ type: 'email.bounced', email_id: 'em_1', order_id: 'ord_1' }),
      }),
    );
  });

  it('a DB blip on the order lookup still 200s and alerts (degrades to order_id: null)', async () => {
    ordersMaybeSingle.mockRejectedValueOnce(new Error('db down'));
    parseResendEvent.mockReturnValue({
      type: 'email.complained',
      data: { email_id: 'em_2' },
      created_at: '2026-07-28T00:00:00Z',
    });

    const res = await POST(req(JSON.stringify({ any: 'payload' }), SVIX));

    // The webhook must not 5xx (Svix retry + lost alert); the alert still fires.
    expect(res.status).toBe(200);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'resend email.complained',
      expect.objectContaining({ extra: expect.objectContaining({ type: 'email.complained', order_id: null }) }),
    );
  });
});
