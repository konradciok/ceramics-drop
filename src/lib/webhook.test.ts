import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import { handleStripeEvent, type WebhookDeps } from './webhook';

function deps(overrides: Partial<WebhookDeps> = {}): WebhookDeps {
  return {
    markPaid: vi.fn().mockResolvedValue(true),
    releaseHold: vi.fn().mockResolvedValue(undefined),
    ensureInvoiced: vi.fn().mockResolvedValue(undefined),
    revalidate: vi.fn(),
    ...overrides,
  };
}

const pi = (id = 'pi_1') => ({ id, object: 'payment_intent' });

describe('handleStripeEvent', () => {
  it('on success: marks paid, revalidates, ensures invoice', async () => {
    const d = deps();
    await handleStripeEvent({ type: 'payment_intent.succeeded', data: { object: pi() } } as unknown as Stripe.Event, d);
    expect(d.markPaid).toHaveBeenCalledWith('pi_1');
    expect(d.revalidate).toHaveBeenCalledWith('inventory');
    expect(d.ensureInvoiced).toHaveBeenCalledWith('pi_1');
  });

  it('already processed: still ensures invoice (idempotent) but does NOT revalidate', async () => {
    const d = deps({ markPaid: vi.fn().mockResolvedValue(false) });
    await handleStripeEvent({ type: 'payment_intent.succeeded', data: { object: pi() } } as unknown as Stripe.Event, d);
    expect(d.ensureInvoiced).toHaveBeenCalledWith('pi_1');
    expect(d.revalidate).not.toHaveBeenCalled();
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
