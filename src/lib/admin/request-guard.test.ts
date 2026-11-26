import { describe, expect, it } from 'vitest';
import { checkAdminMutation, withAdminSecurityHeaders } from './request-guard';

const BASE = 'https://anna-ciok.studio';

function req(
  path: string,
  method: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${BASE}${path}`, { method, headers });
}

const JSON_CT = { 'content-type': 'application/json' };

// ---------------------------------------------------------------------------
// checkAdminMutation — CSRF gate (audit AD-1)
// ---------------------------------------------------------------------------

describe('checkAdminMutation — safe methods', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('always allows %s, even cross-site', (method) => {
    const r = req('/api/admin/label?orderId=x', method, {
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
      'content-type': 'text/plain',
    });
    expect(checkAdminMutation(r)).toEqual({ ok: true });
  });
});

describe('checkAdminMutation — origin matrix', () => {
  const methods = ['POST', 'PATCH', 'PUT', 'DELETE'];

  describe.each(methods)('%s', (method) => {
    it('allows same-origin (Origin matches + Sec-Fetch-Site same-origin)', () => {
      const r = req('/api/admin/end-drop', method, {
        ...JSON_CT,
        origin: BASE,
        'sec-fetch-site': 'same-origin',
      });
      expect(checkAdminMutation(r)).toEqual({ ok: true });
    });

    it('allows when Origin and Sec-Fetch-Site are both absent (non-browser client)', () => {
      const r = req('/api/admin/end-drop', method, JSON_CT);
      expect(checkAdminMutation(r)).toEqual({ ok: true });
    });

    it('allows a matching Origin without Sec-Fetch-Site (older browser)', () => {
      const r = req('/api/admin/end-drop', method, { ...JSON_CT, origin: BASE });
      expect(checkAdminMutation(r)).toEqual({ ok: true });
    });

    it.each(['cross-site', 'same-site', 'none'])('rejects Sec-Fetch-Site: %s', (site) => {
      const r = req('/api/admin/end-drop', method, { ...JSON_CT, 'sec-fetch-site': site });
      expect(checkAdminMutation(r)).toEqual({ ok: false, status: 403, error: 'forbidden' });
    });

    it.each([
      'https://evil.example',
      'https://shop.anna-ciok.studio', // same-site subdomain
      'http://anna-ciok.studio', // scheme downgrade
      'https://anna-ciok.studio:8443', // different port
      'null', // opaque origin (sandboxed frame, data: URL)
    ])('rejects Origin: %s', (origin) => {
      const r = req('/api/admin/end-drop', method, { ...JSON_CT, origin });
      expect(checkAdminMutation(r)).toEqual({ ok: false, status: 403, error: 'forbidden' });
    });

    it('rejects a matching Origin when Sec-Fetch-Site says cross-site', () => {
      const r = req('/api/admin/end-drop', method, {
        ...JSON_CT,
        origin: BASE,
        'sec-fetch-site': 'cross-site',
      });
      expect(checkAdminMutation(r).ok).toBe(false);
    });

    it('rejects Sec-Fetch-Site same-origin with a foreign Origin', () => {
      const r = req('/api/admin/end-drop', method, {
        ...JSON_CT,
        origin: 'https://evil.example',
        'sec-fetch-site': 'same-origin',
      });
      expect(checkAdminMutation(r).ok).toBe(false);
    });
  });

  it('also gates mutating requests to /admin pages', () => {
    const r = req('/admin/orders', 'POST', { origin: 'https://evil.example' });
    expect(checkAdminMutation(r)).toEqual({ ok: false, status: 403, error: 'forbidden' });
  });

  it('reproduces the audit PoC (text/plain cross-site end-drop) and rejects it', () => {
    const r = new Request(`${BASE}/api/admin/end-drop`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
      body: '{"dropId":"drop-2","x":"="}',
    });
    expect(checkAdminMutation(r).ok).toBe(false);
  });

  it('accepts a localhost preview origin that matches the request URL', () => {
    const r = new Request('http://localhost:8787/api/admin/end-drop', {
      method: 'POST',
      headers: { ...JSON_CT, origin: 'http://localhost:8787', 'sec-fetch-site': 'same-origin' },
    });
    expect(checkAdminMutation(r)).toEqual({ ok: true });
  });
});

describe('checkAdminMutation — content type on /api/admin', () => {
  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'Application/JSON',
  ])('allows %s on JSON routes', (ct) => {
    const r = req('/api/admin/promotions', 'POST', { 'content-type': ct, origin: BASE });
    expect(checkAdminMutation(r)).toEqual({ ok: true });
  });

  it.each([
    'text/plain',
    'text/plain;charset=UTF-8',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'image/webp', // only valid on the media upload route
  ])('rejects %s on JSON routes with 415', (ct) => {
    const r = req('/api/admin/promotions', 'POST', { 'content-type': ct });
    expect(checkAdminMutation(r)).toEqual({
      ok: false,
      status: 415,
      error: 'unsupported_media_type',
    });
  });

  it('rejects a missing content type on JSON routes', () => {
    const r = req('/api/admin/refund', 'POST');
    expect(checkAdminMutation(r)).toEqual({
      ok: false,
      status: 415,
      error: 'unsupported_media_type',
    });
  });

  it.each(['image/webp', 'image/jpeg', 'video/mp4'])(
    'allows %s on the media upload route',
    (ct) => {
      const r = req('/api/admin/content/media?width=1&height=1&slot=desktop', 'POST', {
        'content-type': ct,
        origin: BASE,
      });
      expect(checkAdminMutation(r)).toEqual({ ok: true });
    },
  );

  it.each(['text/plain', 'multipart/form-data; boundary=x', 'application/x-www-form-urlencoded'])(
    'rejects %s on the media upload route',
    (ct) => {
      const r = req('/api/admin/content/media', 'POST', { 'content-type': ct });
      expect(checkAdminMutation(r).ok).toBe(false);
    },
  );

  it('does not apply the content-type rule to /admin pages', () => {
    const r = req('/admin/orders', 'POST', { origin: BASE, 'sec-fetch-site': 'same-origin' });
    expect(checkAdminMutation(r)).toEqual({ ok: true });
  });

  it('checks origin before content type (cross-site JSON is still 403)', () => {
    const r = req('/api/admin/refund', 'POST', { 'sec-fetch-site': 'cross-site' });
    expect(checkAdminMutation(r)).toEqual({ ok: false, status: 403, error: 'forbidden' });
  });
});

// ---------------------------------------------------------------------------
// withAdminSecurityHeaders — anti-framing / nosniff (audit ED-01, admin part)
// ---------------------------------------------------------------------------

describe('withAdminSecurityHeaders', () => {
  it('adds nosniff, anti-framing, CSP frame-ancestors and referrer policy', async () => {
    const res = withAdminSecurityHeaders(
      new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json' } }),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe('{"ok":true}');
  });

  it('does not clobber an existing CSP or Referrer-Policy', () => {
    const res = withAdminSecurityHeaders(
      new Response('x', {
        headers: {
          'content-security-policy': "default-src 'self'",
          'referrer-policy': 'no-referrer',
        },
      }),
    );
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('works on responses with immutable headers (Response.redirect)', () => {
    const res = withAdminSecurityHeaders(Response.redirect(`${BASE}/admin`, 307));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`${BASE}/admin`);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('preserves body-less statuses', () => {
    const res = withAdminSecurityHeaders(new Response(null, { status: 204 }));
    expect(res.status).toBe(204);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
