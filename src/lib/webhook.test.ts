import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import { handleStripeEvent, type WebhookDeps } from './webhook';

function deps(overrides: Partial<WebhookDeps> = {}): WebhookDeps {
  return {
    markPaid: vi.fn().mockResolvedValue(true),
    releaseHold: vi.fn().mockResolvedValue(undefined),
    releaseSale: vi.fn().mockResolvedValue(true),
    ensureInvoiced: vi.fn().mockResolvedValue(undefined),
    createShipment: vi.fn().mockResolvedValue(undefined),
    revalidate: vi.fn(),
    trackPurchase: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const pi = (id = 'pi_1') => ({ id, object: 'payment_intent' });

const charge = (overrides: Partial<{ payment_intent: string; amount: number; amount_refunded: number }> = {}) => ({
  id: 'ch_1',
  object: 'charge',
  payment_intent: 'pi_1',
  amount: 1000,
  amount_refunded: 1000,
  ...overrides,
});

const dispute = (overrides: Partial<{ payment_intent: string | { id: string } | null; status: string }> = {}) => ({
  id: 'dp_1',
  object: 'dispute',
  payment_intent: 'pi_1',
  status: 'lost',
  ...overrides,
});

describe('handleStripeEvent', () => {
  it('on success: marks paid, revalidates, ensures invoice, creates shipment', async () => {
    const d = deps();
    await handleStripeEvent({ type: 'payment_intent.succeeded', data: { object: pi() } } as unknown as Stripe.Event, d);
    expect(d.markPaid).toHaveBeenCalledWith('pi_1');
    expect(d.revalidate).toHaveBeenCalledWith('inventory');
    expect(d.ensureInvoiced).toHaveBeenCalledWith('pi_1');
    expect(d.createShipment).toHaveBeenCalledWith('pi_1');
  });

  it('already processed: still ensures invoice and shipment but does NOT revalidate', async () => {
    const d = deps({ markPaid: vi.fn().mockResolvedValue(false) });
    await handleStripeEvent({ type: 'payment_intent.succeeded', data: { object: pi() } } as unknown as Stripe.Event, d);
    expect(d.ensureInvoiced).toHaveBeenCalledWith('pi_1');
    expect(d.createShipment).toHaveBeenCalledWith('pi_1');
    expect(d.revalidate).not.toHaveBeenCalled();
  });

  it('on a new sale: fires trackPurchase', async () => {
    const d = deps();
    await handleStripeEvent({ type: 'payment_intent.succeeded', data: { object: pi() } } as unknown as Stripe.Event, d);
    expect(d.trackPurchase).toHaveBeenCalledWith('pi_1');
  });

  it('already processed (not a new sale): does NOT fire trackPurchase', async () => {
    const d = deps({ markPaid: vi.fn().mockResolvedValue(false) });
    await handleStripeEvent({ type: 'payment_intent.succeeded', data: { object: pi() } } as unknown as Stripe.Event, d);
    expect(d.trackPurchase).not.toHaveBeenCalled();
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

  // charge.refunded
  describe('charge.refunded', () => {
    it('full refund: calls releaseSale and revalidates', async () => {
      const d = deps();
      await handleStripeEvent(
        { type: 'charge.refunded', data: { object: charge() } } as unknown as Stripe.Event,
        d,
      );
      expect(d.releaseSale).toHaveBeenCalledWith('pi_1');
      expect(d.revalidate).toHaveBeenCalledWith('inventory');
    });

    it('partial refund: does NOT call releaseSale', async () => {
      const d = deps();
      await handleStripeEvent(
        { type: 'charge.refunded', data: { object: charge({ amount: 1000, amount_refunded: 500 }) } } as unknown as Stripe.Event,
        d,
      );
      expect(d.releaseSale).not.toHaveBeenCalled();
    });

    it('full refund but releaseSale returns false: does NOT revalidate', async () => {
      const d = deps({ releaseSale: vi.fn().mockResolvedValue(false) });
      await handleStripeEvent(
        { type: 'charge.refunded', data: { object: charge() } } as unknown as Stripe.Event,
        d,
      );
      expect(d.releaseSale).toHaveBeenCalledWith('pi_1');
      expect(d.revalidate).not.toHaveBeenCalled();
    });

    it('full refund with expanded payment_intent object: extracts id correctly', async () => {
      const d = deps();
      const expandedCharge = { ...charge(), payment_intent: { id: 'pi_expanded' } };
      await handleStripeEvent(
        { type: 'charge.refunded', data: { object: expandedCharge } } as unknown as Stripe.Event,
        d,
      );
      expect(d.releaseSale).toHaveBeenCalledWith('pi_expanded');
    });

    it('full refund with null payment_intent: ignores event', async () => {
      const d = deps();
      await handleStripeEvent(
        { type: 'charge.refunded', data: { object: charge({ payment_intent: undefined as unknown as string }) } } as unknown as Stripe.Event,
        d,
      );
      expect(d.releaseSale).not.toHaveBeenCalled();
    });
  });

  // charge.dispute.closed
  describe('charge.dispute.closed', () => {
    it('lost dispute: calls releaseSale and revalidates', async () => {
      const d = deps();
      await handleStripeEvent(
        { type: 'charge.dispute.closed', data: { object: dispute() } } as unknown as Stripe.Event,
        d,
      );
      expect(d.releaseSale).toHaveBeenCalledWith('pi_1');
      expect(d.revalidate).toHaveBeenCalledWith('inventory');
    });

    it('lost dispute with expanded payment_intent object: extracts id correctly', async () => {
      const d = deps();
      const expandedDispute = { ...dispute(), payment_intent: { id: 'pi_expanded' } };
      await handleStripeEvent(
        { type: 'charge.dispute.closed', data: { object: expandedDispute } } as unknown as Stripe.Event,
        d,
      );
      expect(d.releaseSale).toHaveBeenCalledWith('pi_expanded');
    });

    it('lost dispute but releaseSale returns false: does NOT revalidate', async () => {
      const d = deps({ releaseSale: vi.fn().mockResolvedValue(false) });
      await handleStripeEvent(
        { type: 'charge.dispute.closed', data: { object: dispute() } } as unknown as Stripe.Event,
        d,
      );
      expect(d.releaseSale).toHaveBeenCalledWith('pi_1');
      expect(d.revalidate).not.toHaveBeenCalled();
    });

    it('won dispute: does NOT call releaseSale', async () => {
      const d = deps();
      await handleStripeEvent(
        { type: 'charge.dispute.closed', data: { object: dispute({ status: 'won' }) } } as unknown as Stripe.Event,
        d,
      );
      expect(d.releaseSale).not.toHaveBeenCalled();
    });

    it('other dispute status (needs_response): does NOT call releaseSale', async () => {
      const d = deps();
      await handleStripeEvent(
        { type: 'charge.dispute.closed', data: { object: dispute({ status: 'needs_response' }) } } as unknown as Stripe.Event,
        d,
      );
      expect(d.releaseSale).not.toHaveBeenCalled();
    });
  });
});
