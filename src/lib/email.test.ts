import { afterEach, describe, it, expect, vi } from 'vitest';
import { EMAIL, EMAIL_FROM } from './email-addresses';

// M-27 sender-level tests need a Workers env for the getCloudflareContext()-
// based senders; the pure build* functions below never touch it.
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({
    env: { RESEND_API_KEY: 're_test_key', STUDIO_NOTIFY_EMAIL: 'studio@test.example' },
  }),
}));

import {
  emailNewOrderToStudio,
  emailOrderConfirmationToCustomer,
  buildDisputeCreatedAlertEmail,
  buildLabelToStudioEmail,
  buildNewOrderToStudioEmail,
  buildOrderConfirmationEmail,
  buildPrintShippingConfirmation,
  buildRefundFailedAlertEmail,
  buildReturnLabelEmail,
  buildShippingConfirmation,
  buildShowroomInterestEmail,
  type CustomerShippingOrder,
  type LabelEmailOrder,
  type OrderConfirmationOrder,
  type ReturnLabelOrder,
} from './email';

describe('transactional FROM address', () => {
  it('uses one Resend FROM for all transactional mail', () => {
    expect(EMAIL_FROM).toBe(`${EMAIL.shopFromDisplay} <${EMAIL.shopFrom}>`);
  });
});

// ── M-27: Resend Idempotency-Key on claim-based sends ────────────────────────
//
// sendEmailOnceWithClaim retries a send up to 3× after claiming; a Resend
// timeout on an accepted request + a local retry would double-send without a
// provider-side key. Resend dedupes an Idempotency-Key for 24 h.
describe('Resend Idempotency-Key (M-27)', () => {
  type FetchInit = { headers: Record<string, string> };
  const fetchMock = vi.fn<(url: string, init?: FetchInit) => Promise<{
    ok: boolean;
    json: () => Promise<{ id: string }>;
    text: () => Promise<string>;
  }>>(async () => ({
    ok: true,
    json: async () => ({ id: 'em_1' }),
    text: async () => '',
  }));

  function headersOfLastCall(): Record<string, string> {
    const init = fetchMock.mock.calls.at(-1)?.[1];
    if (!init) throw new Error('fetch was not called');
    return init.headers;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  const studioOrder = {
    id: 'o1',
    email: 'buyer@example.com',
    total: 10000,
    currency: 'pln',
    delivery_method: 'paczkomat',
    receiver_first_name: 'Ann',
    receiver_last_name: 'K',
    inpost_target_point: 'WAW01',
    items: [],
  };

  it('sendResendHtml path (studio new-order): sends Idempotency-Key when a claim key is passed', async () => {
    vi.stubGlobal('fetch', fetchMock);

    await emailNewOrderToStudio({ order: studioOrder, idempotencyKey: 'studio-new-order/o1' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(headersOfLastCall()['Idempotency-Key']).toBe('studio-new-order/o1');
  });

  it('sendResendHtml path: omits the header when no key is passed', async () => {
    vi.stubGlobal('fetch', fetchMock);

    await emailNewOrderToStudio({ order: studioOrder });

    expect(headersOfLastCall()).not.toHaveProperty('Idempotency-Key');
  });

  it('sendResendTemplate path (order confirmation): sends Idempotency-Key when a claim key is passed', async () => {
    vi.stubGlobal('fetch', fetchMock);

    await emailOrderConfirmationToCustomer({
      order: { id: 'o1', email: 'buyer@example.com', receiver_first_name: 'Ann' },
      locale: 'pl',
      idempotencyKey: 'order-confirmation/o1',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(headersOfLastCall()['Idempotency-Key']).toBe('order-confirmation/o1');
  });

  it('sendResendTemplate path: omits the header when no key is passed (e.g. the admin manual re-send)', async () => {
    vi.stubGlobal('fetch', fetchMock);

    await emailOrderConfirmationToCustomer({
      order: { id: 'o1', email: 'buyer@example.com', receiver_first_name: 'Ann' },
      locale: 'pl',
    });

    expect(headersOfLastCall()).not.toHaveProperty('Idempotency-Key');
  });
});

const labelOrder: LabelEmailOrder = {
  id: 'ord-label-1',
  delivery_method: 'paczkomat',
  inpost_tracking_number: '620000000012345678',
  inpost_target_point: 'KRA010',
  receiver_first_name: 'Anna',
  receiver_last_name: 'Ciok',
};

describe('buildLabelToStudioEmail — subject', () => {
  it('prefixes subject with [Etykieta] for studio inbox filters', () => {
    const { subject } = buildLabelToStudioEmail({ order: labelOrder });
    expect(subject).toBe('[Etykieta] Etykieta InPost — zamówienie ord-label-1');
  });
});

describe('buildNewOrderToStudioEmail', () => {
  const newOrder = {
    id: 'ord-9',
    email: 'buyer@example.com',
    total: 10500,
    currency: 'pln',
    delivery_method: 'paczkomat',
    receiver_first_name: 'Jan',
    receiver_last_name: 'Kowalski',
    inpost_target_point: 'WAW01A',
    items: [
      { product_id: 'kubek-1', unit_price: 9000 },
      { product_id: 'miska-2', unit_price: 1500 },
    ],
  };
  it('includes order id, customer, items, delivery method and total', () => {
    const { subject, html } = buildNewOrderToStudioEmail({ order: newOrder });
    expect(subject).toContain('ord-9');
    expect(html).toContain('ord-9');
    expect(html).toContain('buyer@example.com');
    expect(html).toContain('kubek-1');
    expect(html).toContain('Paczkomat');
    expect(html).toContain('105.00');
  });

  it('renders the variant label and Prodigi SKU for print items', () => {
    const printOrder = {
      ...newOrder,
      delivery_method: 'kurier',
      inpost_target_point: null,
      items: [
        {
          product_id: 'fap01',
          unit_price: 42000,
          variant: {
            size: '50x70' as const,
            framed: true,
            mount: false,
            frameColour: 'black' as const,
            prodigiSku: 'GLOBAL-CFP-20X28',
          },
        },
      ],
    };
    const { html } = buildNewOrderToStudioEmail({ order: printOrder });
    expect(html).toContain('fap01');
    expect(html).toContain('50×70 cm');
    expect(html).toContain('czarna'); // frame colour, PL studio copy
    expect(html).toContain('GLOBAL-CFP-20X28');
  });

  it('renders a Rabat row with the promo code only when the order carries a discount', () => {
    const discounted = buildNewOrderToStudioEmail({
      order: { ...newOrder, promo_code: 'WELCOME10', discount: 900, total: 9600 },
    });
    expect(discounted.html).toContain('Rabat');
    expect(discounted.html).toContain('WELCOME10');
    expect(discounted.html).toContain('-9.00'); // discount rendered negative, major units
    expect(discounted.html).toContain('96.00'); // total stays the charged amount

    const plain = buildNewOrderToStudioEmail({ order: newOrder });
    expect(plain.html).not.toContain('Rabat');
  });
});

describe('buildRefundFailedAlertEmail', () => {
  it('prefixes subject with [Zwrot], names the order, and lists refund id + reason', () => {
    const { subject, mainContent } = buildRefundFailedAlertEmail({
      orderId: 'ord-refund-1',
      refundId: 're_123',
      failureReason: 'expired_or_canceled_card',
    });
    expect(subject).toBe('[Zwrot] Zwrot nie dotarł do klienta — ord-refund-1');
    expect(mainContent).toContain('re_123');
    expect(mainContent).toContain('expired_or_canceled_card');
  });

  it('falls back to the refund id in the subject when no order matched', () => {
    const { subject, mainContent } = buildRefundFailedAlertEmail({
      orderId: null,
      refundId: 're_456',
      failureReason: null,
    });
    expect(subject).toBe('[Zwrot] Zwrot nie dotarł do klienta — re_456');
    expect(mainContent).toContain('(nie znaleziono)');
    expect(mainContent).toContain('(brak)');
  });
});

describe('buildDisputeCreatedAlertEmail', () => {
  it('is deadline-bearing: surfaces evidence_details.due_by in the subject and body (L-6)', () => {
    const { subject, mainContent } = buildDisputeCreatedAlertEmail({
      orderId: 'ord-dispute-1',
      disputeId: 'dp_123',
      amount: 13900,
      currency: 'pln',
      reason: 'fraudulent',
      evidenceDueBy: 1767139200, // 2025-12-31T00:00:00Z
    });
    expect(subject).toBe('[Spór] Nowy spór Stripe — odpowiedz do 2025-12-31 — ord-dispute-1');
    expect(mainContent).toContain('2025-12-31');
    expect(mainContent).toContain('dp_123');
    expect(mainContent).toContain('139.00 PLN');
    expect(mainContent).toContain('fraudulent');
  });

  it('degrades cleanly with no order match and no due_by', () => {
    const { subject, mainContent } = buildDisputeCreatedAlertEmail({
      orderId: null,
      disputeId: 'dp_456',
      amount: 5000,
      currency: 'eur',
      reason: null,
      evidenceDueBy: null,
    });
    expect(subject).toContain('dp_456');
    expect(mainContent).toContain('(nie znaleziono)');
    expect(mainContent).toContain('(brak)');
  });
});

describe('buildShowroomInterestEmail', () => {
  it('includes product id, email, locale and message', () => {
    const { subject, html } = buildShowroomInterestEmail({
      interest: {
        productId: 'k01',
        email: 'fan@example.com',
        message: 'Love this glaze',
        consentMarketing: true,
        locale: 'en',
      },
    });
    expect(subject).toContain('k01');
    expect(html).toContain('k01');
    expect(html).toContain('fan@example.com');
    expect(html).toContain('Love this glaze');
    expect(html).toContain('Tak'); // consent yes
  });

  it('escapes HTML in the customer message', () => {
    const { html } = buildShowroomInterestEmail({
      interest: {
        productId: 'k01',
        email: 'x@example.com',
        message: '<script>alert(1)</script>',
        consentMarketing: false,
        locale: 'pl',
      },
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Nie'); // consent no
  });
});

const baseOrder: CustomerShippingOrder = {
  id: 'ord-abc',
  email: 'buyer@example.com',
  delivery_method: 'paczkomat',
  receiver_first_name: 'Anna',
  inpost_tracking_number: '620000000012345678',
  inpost_target_point: 'KRA010',
};

describe('buildShippingConfirmation — subject localisation', () => {
  it('returns Polish subject for pl', () => {
    const { subject } = buildShippingConfirmation({ order: baseOrder, locale: 'pl' });
    expect(subject).toBe('Twoje zamówienie zostało wysłane');
  });

  it('returns English subject for en', () => {
    const { subject } = buildShippingConfirmation({ order: baseOrder, locale: 'en' });
    expect(subject).toBe('Your order has been shipped');
  });

  it('returns Spanish subject for es', () => {
    const { subject } = buildShippingConfirmation({ order: baseOrder, locale: 'es' });
    expect(subject).toBe('Tu pedido ha sido enviado');
  });

  it('returns German subject for de', () => {
    const { subject } = buildShippingConfirmation({ order: baseOrder, locale: 'de' });
    expect(subject).toBe('Deine Bestellung wurde versandt');
  });

  it('falls back to Polish for an unknown locale', () => {
    const { subject } = buildShippingConfirmation({ order: baseOrder, locale: 'xx' });
    expect(subject).toBe('Twoje zamówienie zostało wysłane');
  });
});

describe('buildShippingConfirmation — tracking number', () => {
  it('includes the tracking number in html when present', () => {
    const { html } = buildShippingConfirmation({ order: baseOrder, locale: 'pl' });
    expect(html).toContain('620000000012345678');
  });

  it('includes the inpost tracking URL when a tracking number is present', () => {
    const { html } = buildShippingConfirmation({ order: baseOrder, locale: 'pl' });
    expect(html).toContain('inpost.pl/sledzenie-przesylek?number=');
    expect(html).toContain(encodeURIComponent('620000000012345678'));
  });

  it('omits the tracking URL when tracking number is null', () => {
    const noTracking: CustomerShippingOrder = { ...baseOrder, inpost_tracking_number: null };
    const { html } = buildShippingConfirmation({ order: noTracking, locale: 'pl' });
    expect(html).not.toContain('inpost.pl/sledzenie-przesylek');
  });
});

describe('buildShippingConfirmation — HTML escaping', () => {
  it('escapes HTML special chars in receiver_first_name', () => {
    const xssOrder: CustomerShippingOrder = {
      ...baseOrder,
      receiver_first_name: '<b>x',
    };
    const { html } = buildShippingConfirmation({ order: xssOrder, locale: 'pl' });
    expect(html).not.toContain('<b>x');
    expect(html).toContain('&lt;b&gt;x');
  });
});

describe('buildShippingConfirmation — paczkomat line', () => {
  it('includes the locker code for paczkomat method with a target_point', () => {
    const { html } = buildShippingConfirmation({ order: baseOrder, locale: 'pl' });
    expect(html).toContain('KRA010');
  });

  it('omits the paczkomat line for kurier method', () => {
    const kurierOrder: CustomerShippingOrder = {
      ...baseOrder,
      delivery_method: 'kurier',
      inpost_target_point: null,
    };
    const { html } = buildShippingConfirmation({ order: kurierOrder, locale: 'pl' });
    // Should not contain the paczkomat label
    expect(html).not.toContain('Paczkomat');
  });

  it('omits the paczkomat line when target_point is null even for paczkomat method', () => {
    const noPoint: CustomerShippingOrder = { ...baseOrder, inpost_target_point: null };
    const { html } = buildShippingConfirmation({ order: noPoint, locale: 'pl' });
    expect(html).not.toContain('Paczkomat:');
  });
});

describe('buildShippingConfirmation — returns link', () => {
  it('includes a returns link with the order id', () => {
    const { html } = buildShippingConfirmation({ order: { ...baseOrder, id: 'abc-123' }, locale: 'pl' });
    expect(html).toContain('/zwrot?order=abc-123');
  });
  it('prefixes the locale for non-default locales', () => {
    const { html } = buildShippingConfirmation({ order: { ...baseOrder, id: 'abc-123' }, locale: 'en' });
    expect(html).toContain('/en/zwrot?order=abc-123');
  });
});

const returnOrder: ReturnLabelOrder = {
  id: 'ord-ret-1',
  email: 'buyer@example.com',
  receiver_first_name: 'Anna',
};

describe('buildReturnLabelEmail — subject localisation', () => {
  it('returns Polish subject with order id for pl', () => {
    const { subject } = buildReturnLabelEmail({ order: returnOrder, locale: 'pl' });
    expect(subject).toBe('Etykieta zwrotna — zamówienie ord-ret-1');
  });

  it('returns English subject for en', () => {
    const { subject } = buildReturnLabelEmail({ order: returnOrder, locale: 'en' });
    expect(subject).toBe('Return label — order ord-ret-1');
  });

  it('returns German subject for de', () => {
    const { subject } = buildReturnLabelEmail({ order: returnOrder, locale: 'de' });
    expect(subject).toBe('Rücksendeetikett — Bestellung ord-ret-1');
  });

  it('falls back to Polish for an unknown locale', () => {
    const { subject } = buildReturnLabelEmail({ order: returnOrder, locale: 'xx' });
    expect(subject).toBe('Etykieta zwrotna — zamówienie ord-ret-1');
  });
});

describe('buildReturnLabelEmail — HTML escaping', () => {
  it('escapes HTML special chars in receiver_first_name', () => {
    const { html } = buildReturnLabelEmail({
      order: { ...returnOrder, receiver_first_name: '<script>' },
      locale: 'pl',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

const confirmOrder: OrderConfirmationOrder = {
  id: 'ord-confirm-1',
  email: 'buyer@example.com',
  receiver_first_name: 'Anna',
};

describe('buildOrderConfirmationEmail — subject localisation', () => {
  it('returns Polish subject for pl', () => {
    const { subject } = buildOrderConfirmationEmail({ order: confirmOrder, locale: 'pl' });
    expect(subject).toBe('Zamówienie przyjęte — Anna Ciok Ceramics');
  });

  it('returns English subject for en', () => {
    const { subject } = buildOrderConfirmationEmail({ order: confirmOrder, locale: 'en' });
    expect(subject).toBe('Order confirmed — Anna Ciok Ceramics');
  });

  it('returns Spanish subject for es', () => {
    const { subject } = buildOrderConfirmationEmail({ order: confirmOrder, locale: 'es' });
    expect(subject).toBe('Pedido confirmado — Anna Ciok Ceramics');
  });

  it('returns German subject for de', () => {
    const { subject } = buildOrderConfirmationEmail({ order: confirmOrder, locale: 'de' });
    expect(subject).toBe('Bestellung bestätigt — Anna Ciok Ceramics');
  });

  it('falls back to Polish for an unknown locale', () => {
    const { subject } = buildOrderConfirmationEmail({ order: confirmOrder, locale: 'xx' });
    expect(subject).toBe('Zamówienie przyjęte — Anna Ciok Ceramics');
  });
});

describe('buildOrderConfirmationEmail — greeting', () => {
  it('includes the first name in the greeting when present', () => {
    const { html } = buildOrderConfirmationEmail({ order: confirmOrder, locale: 'pl' });
    expect(html).toContain('Cześć Anna');
  });

  it('uses a generic greeting when first name is null', () => {
    const noName: OrderConfirmationOrder = { ...confirmOrder, receiver_first_name: null };
    const { html } = buildOrderConfirmationEmail({ order: noName, locale: 'pl' });
    expect(html).toContain('Cześć,');
    expect(html).not.toContain('Cześć null');
  });
});

describe('buildOrderConfirmationEmail — delivery copy consistency', () => {
  it('uses "od 10 lipca" in both p2 and p3 — no contradictory "do 10 lipca" (PL)', () => {
    const { html } = buildOrderConfirmationEmail({ order: confirmOrder, locale: 'pl' });
    expect(html).toContain('od 10 lipca');
    expect(html).not.toContain('do 10 lipca');
  });

  it('uses "from 10 July" in both p2 and p3 — no contradictory "by 10 July" (EN)', () => {
    const { html } = buildOrderConfirmationEmail({ order: confirmOrder, locale: 'en' });
    expect(html).toContain('from 10 July');
    expect(html).not.toContain('by 10 July');
  });

  it('uses "a partir del 10 de julio" in both p2 and p3 — no contradictory "antes del" (ES)', () => {
    const { html } = buildOrderConfirmationEmail({ order: confirmOrder, locale: 'es' });
    expect(html).toContain('a partir del 10 de julio');
    expect(html).not.toContain('antes del 10 de julio');
  });
});

describe('buildOrderConfirmationEmail — print copy (kind: print)', () => {
  const locales = ['pl', 'en', 'es', 'de'] as const;

  it.each(locales)('uses Prodigi/courier copy with no InPost/locker/Poland text (%s)', (locale) => {
    const { html } = buildOrderConfirmationEmail({ order: confirmOrder, locale, kind: 'print' });
    expect(html).toContain('Prodigi');
    expect(html).not.toContain('InPost');
    expect(html).not.toContain('Paczkomat');
    expect(html).not.toContain('paczkomat');
  });

  it('keeps the ceramic copy when kind is omitted', () => {
    const { html } = buildOrderConfirmationEmail({ order: confirmOrder, locale: 'pl' });
    expect(html).toContain('InPost');
    expect(html).not.toContain('Prodigi');
  });
});

describe('buildPrintShippingConfirmation', () => {
  const printOrder = { id: 'ord-p1', email: 'buyer@example.com', receiver_first_name: 'Anna' };
  const tracking = { number: '1Z999AA1', url: 'https://track.example.com/1Z999AA1', carrier: 'dpd' };

  it('includes carrier tracking number and link, localised', () => {
    const { subject, html } = buildPrintShippingConfirmation({ order: printOrder, tracking, locale: 'en' });
    expect(subject).toBe('Your order has been shipped');
    expect(html).toContain('1Z999AA1');
    expect(html).toContain('https://track.example.com/1Z999AA1');
    expect(html).toContain('dpd');
  });

  it('has no returns block and no InPost/locker language', () => {
    const { html } = buildPrintShippingConfirmation({ order: printOrder, tracking, locale: 'pl' });
    expect(html).not.toContain('zwrot');
    expect(html).not.toContain('inpost.pl');
    expect(html).not.toContain('Paczkomat');
  });

  it('omits the tracking block when no number is available yet', () => {
    const { html } = buildPrintShippingConfirmation({
      order: printOrder,
      tracking: { number: null, url: null },
      locale: 'de',
    });
    expect(html).toContain('Hallo Anna');
    expect(html).not.toContain('Sendungsnummer:');
  });
});

describe('buildOrderConfirmationEmail — HTML escaping', () => {
  it('escapes HTML special chars in receiver_first_name', () => {
    const xssOrder: OrderConfirmationOrder = { ...confirmOrder, receiver_first_name: '<b>x' };
    const { html } = buildOrderConfirmationEmail({ order: xssOrder, locale: 'pl' });
    expect(html).not.toContain('<b>x');
    expect(html).toContain('&lt;b&gt;x');
  });
});
