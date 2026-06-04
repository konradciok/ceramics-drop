import { describe, it, expect } from 'vitest';
import { buildShippingConfirmation, type CustomerShippingOrder } from './email';

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
