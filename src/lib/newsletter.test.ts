import { describe, it, expect, vi } from 'vitest';
import type { Locale } from '@/i18n/routing';
import {
  NEWSLETTER_CONFIRM_TTL_SECS,
  mintConfirmToken,
  verifyConfirmToken,
  newsletterConfirmUrl,
  newsletterLandingPath,
  buildNewsletterConfirmEmail,
  sendNewsletterConfirmEmail,
  subscribeNewsletterContact,
} from './newsletter';
import { EMAIL, EMAIL_FROM } from './email-addresses';

const SECRET = 'newsletter-test-secret';
const NOW = 1_750_000_000_000; // fixed epoch ms — keeps the TTL windows deterministic

describe('confirm token — mint/verify', () => {
  it('round-trips email and locale', async () => {
    const token = await mintConfirmToken({ email: 'anna@example.com', locale: 'en', secret: SECRET, nowMs: NOW });
    const verdict = await verifyConfirmToken(token, SECRET, NOW);
    expect(verdict).toEqual({ ok: true, email: 'anna@example.com', locale: 'en' });
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await mintConfirmToken({ email: 'anna@example.com', locale: 'pl', secret: 'other-secret', nowMs: NOW });
    expect(await verifyConfirmToken(token, SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a tampered body', async () => {
    const token = await mintConfirmToken({ email: 'anna@example.com', locale: 'pl', secret: SECRET, nowMs: NOW });
    const [body, sig] = token.split('.');
    const flipped = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
    expect(await verifyConfirmToken(`${flipped}.${sig}`, SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a tampered signature', async () => {
    const token = await mintConfirmToken({ email: 'anna@example.com', locale: 'pl', secret: SECRET, nowMs: NOW });
    const [body, sig] = token.split('.');
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(await verifyConfirmToken(`${body}.${flipped}`, SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects structural garbage', async () => {
    for (const garbage of [null, undefined, '', 'no-dot', 'a.b.c', 'ok!chars.but-bad', '.', 'x.']) {
      expect(await verifyConfirmToken(garbage, SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('accepts a token right at the 7-day TTL boundary', async () => {
    const token = await mintConfirmToken({ email: 'anna@example.com', locale: 'de', secret: SECRET, nowMs: NOW });
    const atBoundary = NOW + NEWSLETTER_CONFIRM_TTL_SECS * 1000;
    expect((await verifyConfirmToken(token, SECRET, atBoundary)).ok).toBe(true);
  });

  it('reports expired (with the token locale) one second past the TTL', async () => {
    const token = await mintConfirmToken({ email: 'anna@example.com', locale: 'de', secret: SECRET, nowMs: NOW });
    const pastTtl = NOW + (NEWSLETTER_CONFIRM_TTL_SECS + 1) * 1000;
    expect(await verifyConfirmToken(token, SECRET, pastTtl)).toEqual({ ok: false, reason: 'expired', locale: 'de' });
  });

  it('rejects a future-dated iat beyond the skew tolerance', async () => {
    const token = await mintConfirmToken({ email: 'anna@example.com', locale: 'pl', secret: SECRET, nowMs: NOW + 400_000 });
    expect(await verifyConfirmToken(token, SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a correctly signed payload with an unknown locale', async () => {
    const token = await mintConfirmToken({ email: 'anna@example.com', locale: 'xx' as Locale, secret: SECRET, nowMs: NOW });
    expect(await verifyConfirmToken(token, SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a correctly signed payload with a malformed email', async () => {
    const token = await mintConfirmToken({ email: 'not-an-email', locale: 'pl', secret: SECRET, nowMs: NOW });
    expect(await verifyConfirmToken(token, SECRET, NOW)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('newsletterLandingPath', () => {
  it('leaves the default Polish locale unprefixed', () => {
    expect(newsletterLandingPath('pl', 'confirmed')).toBe('/newsletter?status=confirmed');
  });

  it('prefixes non-default locales', () => {
    expect(newsletterLandingPath('en', 'expired')).toBe('/en/newsletter?status=expired');
    expect(newsletterLandingPath('es', 'error')).toBe('/es/newsletter?status=error');
    expect(newsletterLandingPath('de', 'confirmed')).toBe('/de/newsletter?status=confirmed');
  });

  it('falls back to unprefixed for an unknown locale', () => {
    expect(newsletterLandingPath('xx', 'invalid')).toBe('/newsletter?status=invalid');
  });
});

describe('newsletterConfirmUrl', () => {
  it('targets the confirm endpoint on the given origin with the token URL-encoded', () => {
    expect(newsletterConfirmUrl('abc.def', 'https://example.com')).toBe(
      'https://example.com/api/newsletter/confirm?token=abc.def',
    );
  });
});

describe('buildNewsletterConfirmEmail', () => {
  it('localises the subject for all four locales', () => {
    expect(buildNewsletterConfirmEmail({ locale: 'pl', confirmUrl: 'x' }).subject).toBe(
      'Potwierdź zapis do newslettera — Anna Ciok Ceramics',
    );
    expect(buildNewsletterConfirmEmail({ locale: 'en', confirmUrl: 'x' }).subject).toBe(
      'Confirm your newsletter signup — Anna Ciok Ceramics',
    );
    expect(buildNewsletterConfirmEmail({ locale: 'es', confirmUrl: 'x' }).subject).toBe(
      'Confirma tu suscripción — Anna Ciok Ceramics',
    );
    expect(buildNewsletterConfirmEmail({ locale: 'de', confirmUrl: 'x' }).subject).toBe(
      'Bestätige deine Newsletter-Anmeldung — Anna Ciok Ceramics',
    );
  });

  it('falls back to Polish for an unknown locale', () => {
    expect(buildNewsletterConfirmEmail({ locale: 'xx', confirmUrl: 'x' }).subject).toBe(
      'Potwierdź zapis do newslettera — Anna Ciok Ceramics',
    );
  });

  it('links the confirm URL and carries the expiry and not-you lines', () => {
    const url = 'https://anna-ciok.studio/api/newsletter/confirm?token=abc.def';
    const { mainContent } = buildNewsletterConfirmEmail({ locale: 'en', confirmUrl: url });
    expect(mainContent).toContain(`href="${url}"`);
    expect(mainContent).toContain('This link is valid for 7 days.');
    expect(mainContent).toContain("you won't be subscribed");
  });

  it('fills the template shell completely', () => {
    const { html, mainContent } = buildNewsletterConfirmEmail({ locale: 'pl', confirmUrl: 'x' });
    expect(html).not.toContain('{{{MAIN_CONTENT}}}');
    expect(html).toContain(mainContent);
  });
});

describe('sendNewsletterConfirmEmail', () => {
  it('POSTs the email payload to the Resend /emails endpoint', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await sendNewsletterConfirmEmail({
      apiKey: 're_test',
      to: 'anna@example.com',
      subject: 'Subject',
      html: '<p>hi</p>',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test');
    expect(JSON.parse(String(init.body))).toEqual({
      from: EMAIL_FROM,
      to: ['anna@example.com'],
      reply_to: EMAIL.contact,
      subject: 'Subject',
      html: '<p>hi</p>',
    });
  });

  it('throws on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    await expect(
      sendNewsletterConfirmEmail({
        apiKey: 're_test',
        to: 'anna@example.com',
        subject: 's',
        html: 'h',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Resend 500/);
  });
});

describe('subscribeNewsletterContact', () => {
  it('creates the contact via the global /contacts endpoint by default', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 201 }));
    await subscribeNewsletterContact({
      apiKey: 're_test',
      email: 'anna@example.com',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/contacts');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test');
    expect(JSON.parse(String(init.body))).toEqual({ email: 'anna@example.com', unsubscribed: false });
  });

  it('targets the legacy audience endpoint (id URL-encoded) when audienceId is set', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 201 }));
    await subscribeNewsletterContact({
      apiKey: 're_test',
      email: 'anna@example.com',
      audienceId: 'aud 1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.resend.com/audiences/aud%201/contacts');
  });

  it('treats 409 as success (idempotent re-click)', async () => {
    const fetchImpl = vi.fn(async () => new Response('conflict', { status: 409 }));
    await expect(
      subscribeNewsletterContact({ apiKey: 're_test', email: 'a@b.co', fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeUndefined();
  });

  it('treats an "already exists" validation message as success', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"message":"Contact already exists"}', { status: 422 }),
    );
    await expect(
      subscribeNewsletterContact({ apiKey: 're_test', email: 'a@b.co', fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeUndefined();
  });

  it('throws on any other failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(
      subscribeNewsletterContact({ apiKey: 're_test', email: 'a@b.co', fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/Resend 500/);
  });
});
