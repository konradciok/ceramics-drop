import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import { handleStripeEvent, type WebhookDeps } from './webhook';

function deps(overrides: Partial<WebhookDeps> = {}): WebhookDeps {
  return {
    markPaid: vi.fn().mockResolvedValue(true),
    releaseHold: vi.fn().mockResolvedValue(undefined),
    createInvoice: vi.fn().mockResolvedValue(undefined),
    createShipment: vi.fn().mockResolvedValue(undefined),
    revalidate: vi.fn(),
    ...overrides,
  };
}

const pi = (id = 'pi_1') => ({ id, object: 'payment_intent' });

describe('handleStripeEvent', () => {
  it('on success: marks paid, invoices, ships, revalidates', async () => {
    const d = deps();
    await handleStripeEvent({ type: 'payment_intent.succeeded', data: { object: pi() } } as unknown as Stripe.Event, d);
    expect(d.markPaid).toHaveBeenCalledWith('pi_1');
    expect(d.createInvoice).toHaveBeenCalledWith('pi_1');
    expect(d.createShipment).toHaveBeenCalledWith('pi_1');
    expect(d.revalidate).toHaveBeenCalledWith('inventory');
  });

  it('skips invoice when already paid, but still attempts shipment (retry path)', async () => {
    // On webhook redelivery markPaid is a no-op, yet shipment creation must
    // still run so a paid order without a shipment can recover.
    const d = deps({ markPaid: vi.fn().mockResolvedValue(false) });
    await handleStripeEvent({ type: 'payment_intent.succeeded', data: { object: pi() } } as unknown as Stripe.Event, d);
    expect(d.createInvoice).not.toHaveBeenCalled();
    expect(d.revalidate).not.toHaveBeenCalled();
    expect(d.createShipment).toHaveBeenCalledWith('pi_1');
  });

  it('propagates a shipment error so the webhook 5xxs and Stripe retries', async () => {
    const d = deps({ createShipment: vi.fn().mockRejectedValue(new Error('shipx down')) });
    await expect(
      handleStripeEvent({ type: 'payment_intent.succeeded', data: { object: pi() } } as unknown as Stripe.Event, d),
    ).rejects.toThrow('shipx down');
  });

  it('on failure: releases the hold', async () => {
    const d = deps();
    await handleStripeEvent({ type: 'payment_intent.payment_failed', data: { object: pi('pi_2') } } as unknown as Stripe.Event, d);
    expect(d.releaseHold).toHaveBeenCalledWith('pi_2');
  });

  it('ignores unrelated event types', async () => {
    const d = deps();
    await handleStripeEvent({ type: 'charge.updated', data: { object: {} } } as unknown as Stripe.Event, d);
    expect(d.markPaid).not.toHaveBeenCalled();
    expect(d.releaseHold).not.toHaveBeenCalled();
  });
});
