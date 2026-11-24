import { describe, it, expect, vi } from 'vitest';
import { buyShipmentWhenReady, shipxCarrier } from './carrier';
import { ShipxApiError } from './errors';
import type { InPostClient } from './client';

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }));

describe('buyShipmentWhenReady', () => {
  it('skips buy when shipment is already confirmed', async () => {
    const inpost: Pick<InPostClient, 'getShipment' | 'buyShipment'> = {
      getShipment: vi.fn().mockResolvedValue({ id: '42', status: 'confirmed', tracking_number: '6200001' }),
      buyShipment: vi.fn(),
    };

    await buyShipmentWhenReady(inpost as InPostClient, '42', { delayMs: 0 });

    expect(inpost.getShipment).toHaveBeenCalledOnce();
    expect(inpost.buyShipment).not.toHaveBeenCalled();
  });

  it('polls then buys when offer appears on second GET', async () => {
    const getShipment = vi.fn()
      .mockResolvedValueOnce({ id: '42', status: 'created', tracking_number: null, offers: [] })
      .mockResolvedValueOnce({ id: '42', status: 'created', tracking_number: null, offers: [{ id: 77, status: 'available' }] });
    const buyShipment = vi.fn().mockResolvedValue({ id: '42', status: 'confirmed', tracking_number: null });
    const inpost = { getShipment, buyShipment } as unknown as InPostClient;

    await buyShipmentWhenReady(inpost, '42', { delayMs: 0 });

    expect(getShipment).toHaveBeenCalledTimes(2);
    expect(buyShipment).toHaveBeenCalledOnce();
    expect(buyShipment).toHaveBeenCalledWith('42', '77');
  });

  it('throws after exhausting all attempts with no buyable offer', async () => {
    const getShipment = vi.fn().mockResolvedValue({ id: '42', status: 'created', tracking_number: null, offers: [] });
    const buyShipment = vi.fn();
    const inpost = { getShipment, buyShipment } as unknown as InPostClient;

    await expect(
      buyShipmentWhenReady(inpost, '42', { attempts: 2, delayMs: 0 }),
    ).rejects.toThrow(/no buyable offer.*42.*2 attempt/i);

    expect(buyShipment).not.toHaveBeenCalled();
  });

  it('does not sleep on the last attempt before throwing', async () => {
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    const getShipment = vi.fn().mockResolvedValue({ id: '42', status: 'created', offers: [] });
    const inpost = { getShipment, buyShipment: vi.fn() } as unknown as InPostClient;

    await expect(
      buyShipmentWhenReady(inpost, '42', { attempts: 3, delayMs: 99, sleep: sleepSpy }),
    ).rejects.toThrow();

    // With 3 attempts: sleep after attempt 0 and 1 → 2 sleeps (not 3).
    expect(sleepSpy).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenCalledWith(99);
  });

  it('propagates a non-retryable offer error (duplicate-buy idempotency contract)', async () => {
    // A duplicate buy on an already-bought shipment surfaces a non-retryable offer
    // error (offer_unavailable / offer_not_found) from ShipX, which the webhook
    // route's shouldRethrowShipmentError gate swallows — returning 200 to Stripe.
    // This test ensures buyShipmentWhenReady does NOT swallow it itself; the error
    // must propagate so the gate can make the decision.
    const offerError = new ShipxApiError(
      'POST',
      '/v1/shipments/42/buy',
      422,
      JSON.stringify({ error: 'offer_unavailable', message: 'Offer is no longer available' }),
    );
    const getShipment = vi.fn().mockResolvedValue({
      id: '42',
      status: 'created',
      tracking_number: null,
      offers: [{ id: 99, status: 'available' }],
    });
    const buyShipment = vi.fn().mockRejectedValue(offerError);
    const inpost = { getShipment, buyShipment } as unknown as InPostClient;

    await expect(
      buyShipmentWhenReady(inpost, '42', { delayMs: 0 }),
    ).rejects.toThrow(offerError);

    expect(buyShipment).toHaveBeenCalledOnce();
  });
});

describe('shipxCarrier', () => {
  it('is the inpost_shipx channel and reads the label through the client', async () => {
    const pdf = new ArrayBuffer(4);
    const getLabelPdf = vi.fn().mockResolvedValue(pdf);
    const carrier = shipxCarrier({ getLabelPdf } as unknown as InPostClient);
    expect(carrier.channel).toBe('inpost_shipx');
    expect(carrier.cancel).toBeUndefined();
    await expect(carrier.getLabelPdf('42')).resolves.toBe(pdf);
    expect(getLabelPdf).toHaveBeenCalledWith('42');
  });
});
