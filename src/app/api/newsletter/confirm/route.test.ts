import { beforeEach, describe, expect, it, vi } from 'vitest';
// Resolves to the mocked module below — mintConfirmToken stays real (importOriginal
// spread), so tests mint genuine tokens with a test secret and no crypto mocking.
import { mintConfirmToken, NEWSLETTER_CONFIRM_TTL_SECS } from '@/lib/newsletter';

// vi.hoisted: the top-level import above triggers the mock factory before
// ordinary consts initialise, so the spy must be hoisted alongside vi.mock.
const { subscribeNewsletterContact, sendNewsletterWelcomeEmail, getActiveNewsletterPromo } = vi.hoisted(() => ({
  subscribeNewsletterContact: vi.fn<(params: unknown) => Promise<void>>(async () => {}),
  sendNewsletterWelcomeEmail: vi.fn<(params: unknown) => Promise<void>>(async () => {}),
  getActiveNewsletterPromo: vi.fn<(supabase: unknown) => Promise<unknown>>(async () => null),
}));
vi.mock('@/lib/newsletter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/newsletter')>();
  return { ...actual, subscribeNewsletterContact, sendNewsletterWelcomeEmail };
});
vi.mock('@/lib/promo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/promo')>();
  return { ...actual, getActiveNewsletterPromo };
});
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({}) }));

const getClientIp = vi.fn((): string | null => '203.0.113.60');
vi.mock('@/lib/client-ip', () => ({ getClientIp }));

let cfEnv: Record<string, string | undefined> = {};
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: cfEnv }),
}));

const SECRET = 'confirm-route-test-secret';

function reqWithToken(token: string | null): Request {
  const url =
    token === null
      ? 'http://localhost/api/newsletter/confirm'
      : `http://localhost/api/newsletter/confirm?token=${encodeURIComponent(token)}`;
  return new Request(url);
}

type SubscribeArgs = { apiKey: string; email: string; audienceId?: string };

describe('GET /api/newsletter/confirm', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    cfEnv = { NEWSLETTER_CONFIRM_SECRET: SECRET, RESEND_API_KEY: 're_test' };
  });

  it('subscribes and redirects to the localised confirmed page for a valid token', async () => {
    const { GET } = await import('./route');
    const token = await mintConfirmToken({ email: 'anna@example.com', locale: 'en', secret: SECRET });
    const res = await GET(reqWithToken(token));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost/en/newsletter?status=confirmed');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(subscribeNewsletterContact).toHaveBeenCalledTimes(1);
    const args = subscribeNewsletterContact.mock.calls[0][0] as unknown as SubscribeArgs;
    expect(args).toEqual({ apiKey: 're_test', email: 'anna@example.com', audienceId: undefined });
  });

  it('keeps the default Polish locale unprefixed in the redirect', async () => {
    const { GET } = await import('./route');
    const token = await mintConfirmToken({ email: 'anna@example.com', locale: 'pl', secret: SECRET });
    const res = await GET(reqWithToken(token));
    expect(res.headers.get('location')).toBe('http://localhost/newsletter?status=confirmed');
  });

  it('passes RESEND_NEWSLETTER_AUDIENCE_ID through when configured', async () => {
    cfEnv.RESEND_NEWSLETTER_AUDIENCE_ID = 'aud-1';
    const { GET } = await import('./route');
    const token = await mintConfirmToken({ email: 'anna@example.com', locale: 'pl', secret: SECRET });
    await GET(reqWithToken(token));
    const args = subscribeNewsletterContact.mock.calls[0][0] as unknown as SubscribeArgs;
    expect(args.audienceId).toBe('aud-1');
  });

  it('redirects an expired token to the locale-aware expired page without subscribing', async () => {
    const { GET } = await import('./route');
    const stale = Date.now() - (NEWSLETTER_CONFIRM_TTL_SECS + 10) * 1000;
    const token = await mintConfirmToken({ email: 'anna@example.com', locale: 'de', secret: SECRET, nowMs: stale });
    const res = await GET(reqWithToken(token));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost/de/newsletter?status=expired');
    expect(subscribeNewsletterContact).not.toHaveBeenCalled();
  });

  it('redirects a tampered token to the default-locale invalid page', async () => {
    const { GET } = await import('./route');
    const token = await mintConfirmToken({ email: 'anna@example.com', locale: 'en', secret: SECRET });
    const [body, sig] = token.split('.');
    const flipped = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
    const res = await GET(reqWithToken(`${flipped}.${sig}`));
    expect(res.headers.get('location')).toBe('http://localhost/newsletter?status=invalid');
    expect(subscribeNewsletterContact).not.toHaveBeenCalled();
  });

  it('redirects a missing token to the invalid page', async () => {
    const { GET } = await import('./route');
    const res = await GET(reqWithToken(null));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost/newsletter?status=invalid');
  });

  it('rejects an oversized token without verifying it', async () => {
    const { GET } = await import('./route');
    const res = await GET(reqWithToken('A'.repeat(1025)));
    expect(res.headers.get('location')).toBe('http://localhost/newsletter?status=invalid');
  });

  it('redirects to the error page when contact creation fails (token stays reusable)', async () => {
    subscribeNewsletterContact.mockRejectedValueOnce(new Error('Resend 500'));
    const { GET } = await import('./route');
    const token = await mintConfirmToken({ email: 'anna@example.com', locale: 'en', secret: SECRET });
    const res = await GET(reqWithToken(token));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost/en/newsletter?status=error');
  });

  it('fails closed with 503 when NEWSLETTER_CONFIRM_SECRET is unset', async () => {
    cfEnv = { RESEND_API_KEY: 're_test' };
    const { GET } = await import('./route');
    const res = await GET(reqWithToken('anything'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'newsletter_unavailable' });
  });

  const NEWSLETTER_PROMO = {
    id: '11111111-2222-4333-8444-555555555555',
    code: 'WELCOME10',
    kind: 'percent',
    percent: 10,
    amount_pln: null,
    amount_eur: null,
    amount_gbp: null,
    applies_to: 'all',
    active: true,
    starts_at: null,
    expires_at: null,
    max_redemptions: null,
    newsletter_welcome: true,
    campaign: null,
  };

  it('sends the welcome email with the flagged promo after a successful subscribe', async () => {
    getActiveNewsletterPromo.mockResolvedValueOnce(NEWSLETTER_PROMO);
    const { GET } = await import('./route');
    const token = await mintConfirmToken({ email: 'anna@example.com', locale: 'en', secret: SECRET });
    const res = await GET(reqWithToken(token));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost/en/newsletter?status=confirmed');
    expect(sendNewsletterWelcomeEmail).toHaveBeenCalledTimes(1);
    const args = sendNewsletterWelcomeEmail.mock.calls[0][0] as { to: string; html: string; apiKey: string };
    expect(args.to).toBe('anna@example.com');
    expect(args.apiKey).toBe('re_test');
    expect(args.html).toContain('WELCOME10');
  });

  it('regression: with no flagged promo the flow is exactly the legacy one (no second email)', async () => {
    getActiveNewsletterPromo.mockResolvedValueOnce(null);
    const { GET } = await import('./route');
    const token = await mintConfirmToken({ email: 'anna@example.com', locale: 'pl', secret: SECRET });
    const res = await GET(reqWithToken(token));
    expect(res.headers.get('location')).toBe('http://localhost/newsletter?status=confirmed');
    expect(sendNewsletterWelcomeEmail).not.toHaveBeenCalled();
  });

  it('a failing welcome send is logged but the confirmed redirect still goes out (best-effort)', async () => {
    getActiveNewsletterPromo.mockResolvedValueOnce(NEWSLETTER_PROMO);
    sendNewsletterWelcomeEmail.mockRejectedValueOnce(new Error('Resend 500'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GET } = await import('./route');
    const token = await mintConfirmToken({ email: 'anna@example.com', locale: 'en', secret: SECRET });
    const res = await GET(reqWithToken(token));
    errSpy.mockRestore();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost/en/newsletter?status=confirmed');
  });

  it('a promo-lookup DB error degrades to "no promo" — flow unaffected', async () => {
    getActiveNewsletterPromo.mockRejectedValueOnce(new Error('db down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GET } = await import('./route');
    const token = await mintConfirmToken({ email: 'anna@example.com', locale: 'en', secret: SECRET });
    const res = await GET(reqWithToken(token));
    errSpy.mockRestore();
    expect(res.headers.get('location')).toBe('http://localhost/en/newsletter?status=confirmed');
    expect(sendNewsletterWelcomeEmail).not.toHaveBeenCalled();
  });

  it('returns 429 once the per-IP budget (20/min) is spent', async () => {
    const { GET } = await import('./route');
    let last: Response | null = null;
    for (let i = 0; i < 21; i += 1) {
      last = await GET(reqWithToken(null));
    }
    expect(last?.status).toBe(429);
    expect(await last?.json()).toEqual({ error: 'rate_limited' });
  });
});
