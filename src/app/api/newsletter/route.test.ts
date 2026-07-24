import { beforeEach, describe, expect, it, vi } from 'vitest';

const getClientIp = vi.fn((): string | null => '203.0.113.50');
vi.mock('@/lib/client-ip', () => ({ getClientIp }));

// Only the sender is mocked — token minting and the email builder stay real so
// the test pins the actual confirm-URL/subject wiring end to end.
const sendNewsletterConfirmEmail = vi.fn<(params: unknown) => Promise<void>>(async () => {});
vi.mock('@/lib/newsletter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/newsletter')>();
  return { ...actual, sendNewsletterConfirmEmail };
});

// Mutable so tests can drop secrets; reset in beforeEach.
let cfEnv: Record<string, string | undefined> = {};
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: cfEnv }),
}));

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/newsletter', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

type SendArgs = { apiKey: string; to: string; subject: string; html: string };

describe('POST /api/newsletter', () => {
  beforeEach(() => {
    // resetModules gives each test a fresh module-level rate limiter.
    vi.resetModules();
    vi.clearAllMocks();
    cfEnv = { NEWSLETTER_CONFIRM_SECRET: 'route-test-secret', RESEND_API_KEY: 're_test' };
  });

  it('returns 400 invalid_json on a malformed body', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq('not json'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('returns 400 invalid_email on a bad address', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq({ email: 'nope', locale: 'pl' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_email' });
    expect(sendNewsletterConfirmEmail).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when NEWSLETTER_CONFIRM_SECRET is unset', async () => {
    cfEnv = { RESEND_API_KEY: 're_test' };
    const { POST } = await import('./route');
    const res = await POST(makeReq({ email: 'anna@example.com', locale: 'pl' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'newsletter_unavailable' });
  });

  it('fails closed with 503 when RESEND_API_KEY is unset', async () => {
    cfEnv = { NEWSLETTER_CONFIRM_SECRET: 'route-test-secret' };
    const { POST } = await import('./route');
    const res = await POST(makeReq({ email: 'anna@example.com', locale: 'pl' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'newsletter_unavailable' });
  });

  it('returns 502 send_failed when the confirmation email cannot be sent', async () => {
    sendNewsletterConfirmEmail.mockRejectedValueOnce(new Error('Resend 500'));
    const { POST } = await import('./route');
    const res = await POST(makeReq({ email: 'anna@example.com', locale: 'pl' }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'send_failed' });
  });

  it('sends a localised confirmation email and answers 200 { ok: true }', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq({ email: '  anna@example.com  ', locale: 'en' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendNewsletterConfirmEmail).toHaveBeenCalledTimes(1);
    const args = sendNewsletterConfirmEmail.mock.calls[0][0] as unknown as SendArgs;
    expect(args.apiKey).toBe('re_test');
    expect(args.to).toBe('anna@example.com'); // trimmed
    expect(args.subject).toBe('Confirm your newsletter signup — Anna Ciok Ceramics');
    expect(args.html).toContain('/api/newsletter/confirm?token=');
  });

  it('clamps an unknown locale to Polish', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq({ email: 'anna@example.com', locale: 'xx' }));
    expect(res.status).toBe(200);
    const args = sendNewsletterConfirmEmail.mock.calls[0][0] as unknown as SendArgs;
    expect(args.subject).toBe('Potwierdź zapis do newslettera — Anna Ciok Ceramics');
  });

  it('builds the confirm link on WORKER_ORIGIN when set (staging)', async () => {
    cfEnv.WORKER_ORIGIN = 'https://staging.example.com';
    const { POST } = await import('./route');
    await POST(makeReq({ email: 'anna@example.com', locale: 'pl' }));
    const args = sendNewsletterConfirmEmail.mock.calls[0][0] as unknown as SendArgs;
    expect(args.html).toContain('https://staging.example.com/api/newsletter/confirm?token=');
  });

  it('returns 429 with Retry-After once the per-IP budget (5/min) is spent', async () => {
    const { POST } = await import('./route');
    let last: Response | null = null;
    for (let i = 0; i < 6; i += 1) {
      last = await POST(makeReq({ email: 'anna@example.com', locale: 'pl' }));
    }
    expect(last?.status).toBe(429);
    expect(await last?.json()).toEqual({ error: 'rate_limited' });
    expect(Number(last?.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(sendNewsletterConfirmEmail).toHaveBeenCalledTimes(5);
  });
});
