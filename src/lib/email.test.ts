import { describe, it, expect } from 'vitest';
import { EMAIL, EMAIL_FROM } from './email-addresses';
import {
  buildLabelToStudioEmail,
  buildNewOrderToStudioEmail,
  buildOrderConfirmationEmail,
  buildReturnLabelEmail,
  buildShippingConfirmation,
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

  it('falls back to Polish for an unknown locale', () => {
    const { subject } = buildShippingConfirmation({ order: baseOrder, locale: 'de' });
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

  it('falls back to Polish for an unknown locale', () => {
    const { subject } = buildReturnLabelEmail({ order: returnOrder, locale: 'de' });
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

  it('falls back to Polish for an unknown locale', () => {
    const { subject } = buildOrderConfirmationEmail({ order: confirmOrder, locale: 'de' });
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
  it('mentions "10 lipca" in both p2 and p3 (PL)', () => {
    const { html } = buildOrderConfirmationEmail({ order: confirmOrder, locale: 'pl' });
    expect(html).toContain('10 lipca');
    expect(html).not.toContain('po 10 lipca');
  });

  it('mentions "10 July" in both p2 and p3 (EN)', () => {
    const { html } = buildOrderConfirmationEmail({ order: confirmOrder, locale: 'en' });
    expect(html).toContain('10 July');
    expect(html).not.toContain('after 10 July');
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
