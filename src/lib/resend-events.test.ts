import { describe, it, expect, vi } from 'vitest';
import {
  ABANDONED_CART_EVENTS,
  AUTOMATION_SUBJECTS,
  cartUrlForLocale,
  buildAbandonedCartEmail,
  buildCheckoutStartedPayload,
  buildPurchasedPayload,
  sendResendEvent,
} from './resend-events';
import { SITE_URL } from '@/lib/site';

describe('ABANDONED_CART_EVENTS', () => {
  it('uses the event names the Resend automation triggers on', () => {
    expect(ABANDONED_CART_EVENTS.checkoutStarted).toBe('cart.checkout_started');
    expect(ABANDONED_CART_EVENTS.purchased).toBe('cart.purchased');
  });
});

describe('cartUrlForLocale', () => {
  it('builds an unprefixed /koszyk URL for the default Polish locale', () => {
    expect(cartUrlForLocale('pl')).toBe(`${SITE_URL}/koszyk`);
  });

  it('prefixes the locale for en/es', () => {
    expect(cartUrlForLocale('en')).toBe(`${SITE_URL}/en/koszyk`);
    expect(cartUrlForLocale('es')).toBe(`${SITE_URL}/es/koszyk`);
  });

  it('prefixes the locale for de/gb', () => {
    expect(cartUrlForLocale('de')).toBe(`${SITE_URL}/de/koszyk`);
    expect(cartUrlForLocale('gb')).toBe(`${SITE_URL}/gb/koszyk`);
  });

  it('falls back to Polish (unprefixed) for a truly unknown locale', () => {
    expect(cartUrlForLocale('xx')).toBe(`${SITE_URL}/koszyk`);
  });

  it('uses an explicit origin override when given', () => {
    expect(cartUrlForLocale('en', 'https://preview.example.com')).toBe(
      'https://preview.example.com/en/koszyk',
    );
  });

  it('falls back to SITE_URL when origin is an empty string', () => {
    expect(cartUrlForLocale('pl', '')).toBe(`${SITE_URL}/koszyk`);
  });
});

describe('buildAbandonedCartEmail — subject localisation', () => {
  it('returns the Polish subject for pl', () => {
    const { subject } = buildAbandonedCartEmail({ locale: 'pl', firstName: 'Anna', cartUrl: 'x' });
    expect(subject).toBe('Twój koszyk czeka');
  });
  it('returns the English subject for en', () => {
    const { subject } = buildAbandonedCartEmail({ locale: 'en', firstName: 'Anna', cartUrl: 'x' });
    expect(subject).toBe('Your cart is waiting');
  });
  it('returns the Spanish subject for es', () => {
    const { subject } = buildAbandonedCartEmail({ locale: 'es', firstName: 'Anna', cartUrl: 'x' });
    expect(subject).toBe('Tu cesta te espera');
  });
  it('falls back to English for de/gb locales', () => {
    const { subject: de } = buildAbandonedCartEmail({ locale: 'de', firstName: 'Anna', cartUrl: 'x' });
    expect(de).toBe('Your cart is waiting');
    const { subject: gb } = buildAbandonedCartEmail({ locale: 'gb', firstName: 'Anna', cartUrl: 'x' });
    expect(gb).toBe('Your cart is waiting');
  });

  it('falls back to Polish for a truly unknown locale', () => {
    const { subject } = buildAbandonedCartEmail({ locale: 'xx', firstName: 'Anna', cartUrl: 'x' });
    expect(subject).toBe('Twój koszyk czeka');
  });
});

describe('subject drift guard', () => {
  // The Resend automation sends a STATIC subject per locale (it cannot read
  // event.subject). These builder subjects must stay identical to the subjects
  // hard-coded in the "Abandoned checkout — 30m" automation, or the live email
  // subject silently diverges from the version-controlled copy.
  it('builder subjects equal the automation static subjects', () => {
    expect(buildAbandonedCartEmail({ locale: 'pl', firstName: null, cartUrl: 'x' }).subject).toBe(
      AUTOMATION_SUBJECTS.pl,
    );
    expect(buildAbandonedCartEmail({ locale: 'en', firstName: null, cartUrl: 'x' }).subject).toBe(
      AUTOMATION_SUBJECTS.en,
    );
    expect(buildAbandonedCartEmail({ locale: 'es', firstName: null, cartUrl: 'x' }).subject).toBe(
      AUTOMATION_SUBJECTS.es,
    );
  });
});

describe('buildAbandonedCartEmail — body', () => {
  it('links the CTA button to the cart URL', () => {
    const { mainContent } = buildAbandonedCartEmail({
      locale: 'pl',
      firstName: 'Anna',
      cartUrl: 'https://anna-ciok.studio/koszyk',
    });
    expect(mainContent).toContain('href="https://anna-ciok.studio/koszyk"');
  });

  it('includes the one-of-a-kind urgency line per locale', () => {
    expect(
      buildAbandonedCartEmail({ locale: 'pl', firstName: null, cartUrl: 'x' }).mainContent,
    ).toContain('jedyna w swoim rodzaju');
    expect(
      buildAbandonedCartEmail({ locale: 'en', firstName: null, cartUrl: 'x' }).mainContent,
    ).toContain('one of a kind');
    expect(
      buildAbandonedCartEmail({ locale: 'es', firstName: null, cartUrl: 'x' }).mainContent,
    ).toContain('única');
  });

  it('greets the customer by first name when present', () => {
    const { mainContent } = buildAbandonedCartEmail({ locale: 'pl', firstName: 'Anna', cartUrl: 'x' });
    expect(mainContent).toContain('Cześć Anna');
  });

  it('uses a generic greeting when first name is null (no "null")', () => {
    const { mainContent } = buildAbandonedCartEmail({ locale: 'pl', firstName: null, cartUrl: 'x' });
    expect(mainContent).toContain('Cześć,');
    expect(mainContent).not.toContain('null');
  });

  it('escapes HTML special chars in the first name', () => {
    const { mainContent } = buildAbandonedCartEmail({
      locale: 'pl',
      firstName: '<b>x',
      cartUrl: 'x',
    });
    expect(mainContent).not.toContain('<b>x');
    expect(mainContent).toContain('&lt;b&gt;x');
  });
});

describe('buildCheckoutStartedPayload', () => {
  const base = {
    orderId: 'ord-1',
    locale: 'en',
    currency: 'eur',
    totalMinor: 4500,
    firstName: 'Anna',
    cartUrl: 'https://anna-ciok.studio/en/koszyk',
  };

  it('carries every field the automation references', () => {
    const p = buildCheckoutStartedPayload(base);
    expect(p.order_id).toBe('ord-1');
    expect(p.locale).toBe('en');
    expect(p.currency).toBe('eur');
    expect(p.total_minor).toBe(4500);
    expect(p.cart_url).toBe('https://anna-ciok.studio/en/koszyk');
    expect(p.first_name).toBe('Anna');
    expect(p.subject).toBe('Your cart is waiting');
    expect(p.main_content_html).toContain('href="https://anna-ciok.studio/en/koszyk"');
  });

  it('coerces a null first name to an empty string in the payload', () => {
    const p = buildCheckoutStartedPayload({ ...base, firstName: null });
    expect(p.first_name).toBe('');
  });
});

describe('buildPurchasedPayload', () => {
  it('carries only the order id', () => {
    expect(buildPurchasedPayload('ord-9')).toEqual({ order_id: 'ord-9' });
  });
});

describe('sendResendEvent', () => {
  it('POSTs to the Resend events/send endpoint with event, email and payload', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    await sendResendEvent({
      apiKey: 're_test',
      event: 'cart.checkout_started',
      email: 'buyer@example.com',
      payload: { order_id: 'ord-1' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/events/send');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test');
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({
      event: 'cart.checkout_started',
      email: 'buyer@example.com',
      payload: { order_id: 'ord-1' },
    });
  });

  it('throws on a non-ok Resend response so callers can log/swallow', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 422 }));
    await expect(
      sendResendEvent({
        apiKey: 're_test',
        event: 'cart.purchased',
        email: 'buyer@example.com',
        payload: { order_id: 'ord-1' },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Resend 422/);
  });
});
