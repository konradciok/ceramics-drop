import { describe, it, expect, vi } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import { createOrderShipment, buyShipmentWhenReady, type CreateShipmentDeps } from './shipment';

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }));
import { ShipxApiError } from './shipx-errors';
import type { OrderForShipment } from './shipx';
import type { InPostClient } from './inpost';

const order: OrderForShipment = {
  id: 'ord-1',
  delivery_method: 'paczkomat',
  email: 'a@example.com',
  receiver_first_name: 'Anna',
  receiver_last_name: 'Kowalska',
  receiver_phone: '+48600100200',
  inpost_target_point: 'KRA010',
  shipping_address: null,
  inpost_shipment_id: null,
  inpost_dispatch_order_id: null,
};

/**
 * Default inpost mock: getShipment returns a shipment with one available offer
 * (so buyShipmentWhenReady succeeds on the first poll without sleeping), and
 * buyShipment resolves immediately. Individual tests override per-case.
 */
function deps(overrides: Partial<CreateShipmentDeps> = {}): CreateShipmentDeps {
  const inpost: InPostClient = {
    createShipment: vi.fn().mockResolvedValue({ id: 42, status: 'created', tracking_number: '6200001' }),
    getShipment: vi.fn().mockResolvedValue({ id: 42, status: 'created', tracking_number: '6200001', offers: [{ id: 99, status: 'available' }] }),
    buyShipment: vi.fn().mockResolvedValue({ id: 42, status: 'confirmed', tracking_number: '6200001' }),
    getLabelPdf: vi.fn(),
    createDispatchOrder: vi.fn().mockResolvedValue({ id: 99, status: 'created', deadline_time: '2026-06-05 18:00' }),
    // Default: no prior ShipX shipment under this order's reference — create as today.
    findShipmentsByReference: vi.fn().mockResolvedValue([]),
  };
  return {
    loadOrder: vi.fn().mockResolvedValue(order),
    saveShipment: vi.fn().mockResolvedValue(undefined),
    inpost,
    ...overrides,
  };
}

describe('createOrderShipment', () => {
  it('creates a shipment and persists id/tracking/status', async () => {
    const d = deps();
    await createOrderShipment('pi_1', d);
    expect(d.inpost.findShipmentsByReference).toHaveBeenCalledWith('ord-1');
    expect(d.inpost.createShipment).toHaveBeenCalledOnce();
    expect(d.saveShipment).toHaveBeenCalledWith('ord-1', {
      shipmentId: '42',
      trackingNumber: '6200001',
      status: 'created',
    });
  });

  it('skips studio pickup (odbior) — no shipment created', async () => {
    const d = deps({ loadOrder: vi.fn().mockResolvedValue({ ...order, delivery_method: 'odbior' }) });
    await createOrderShipment('pi_1', d);
    expect(d.inpost.createShipment).not.toHaveBeenCalled();
    expect(d.saveShipment).not.toHaveBeenCalled();
  });

  it('is idempotent when a shipment already exists (confirmed — no buy retry)', async () => {
    const d = deps({
      loadOrder: vi.fn().mockResolvedValue({
        ...order,
        inpost_shipment_id: '42',
        delivery_status: 'confirmed',
      }),
    });
    await createOrderShipment('pi_1', d);
    expect(d.inpost.createShipment).not.toHaveBeenCalled();
    expect(d.inpost.buyShipment).not.toHaveBeenCalled();
  });

  it('no-ops when the order is missing', async () => {
    const d = deps({ loadOrder: vi.fn().mockResolvedValue(null) });
    await createOrderShipment('pi_x', d);
    expect(d.inpost.createShipment).not.toHaveBeenCalled();
  });

  it('creates a dispatch order for kurier and persists its id', async () => {
    const saveDispatchOrderId = vi.fn().mockResolvedValue(undefined);
    const kurierOrder: OrderForShipment = {
      ...order,
      delivery_method: 'kurier',
      inpost_target_point: null,
      shipping_address: { street: 'Floriańska', building_number: '12', city: 'Kraków', post_code: '31-019', country_code: 'PL' },
    };
    const d = deps({ loadOrder: vi.fn().mockResolvedValue(kurierOrder), saveDispatchOrderId });
    await createOrderShipment('pi_1', d);
    expect(d.inpost.createDispatchOrder).toHaveBeenCalledOnce();
    expect(saveDispatchOrderId).toHaveBeenCalledWith('ord-1', '99');
  });

  it('retries dispatch when shipment exists but dispatch is missing', async () => {
    const saveDispatchOrderId = vi.fn().mockResolvedValue(undefined);
    const kurierWithShipment: OrderForShipment = {
      ...order,
      delivery_method: 'kurier',
      inpost_target_point: null,
      shipping_address: { street: 'Floriańska', building_number: '12', city: 'Kraków', post_code: '31-019', country_code: 'PL' },
      inpost_shipment_id: '42',         // shipment already created
      inpost_dispatch_order_id: null,   // but dispatch never persisted
      delivery_status: 'confirmed',     // already confirmed — no buy retry needed
    };
    const d = deps({ loadOrder: vi.fn().mockResolvedValue(kurierWithShipment), saveDispatchOrderId });
    await createOrderShipment('pi_1', d);
    expect(d.inpost.createShipment).not.toHaveBeenCalled();   // no duplicate shipment
    expect(d.inpost.createDispatchOrder).toHaveBeenCalledOnce();
    expect(saveDispatchOrderId).toHaveBeenCalledWith('ord-1', '99');
  });

  it('does not create a dispatch order for paczkomat (no saveDispatchOrderId needed)', async () => {
    const d = deps();
    await createOrderShipment('pi_1', d);
    expect(d.inpost.createDispatchOrder).not.toHaveBeenCalled();
  });

  it('does not create a dispatch order for kurier when saveDispatchOrderId is absent', async () => {
    const d = deps({
      loadOrder: vi.fn().mockResolvedValue({
        ...order,
        delivery_method: 'kurier',
        inpost_target_point: null,
        shipping_address: { street: 'Floriańska', building_number: '12', city: 'Kraków', post_code: '31-019', country_code: 'PL' },
      }),
    });
    await createOrderShipment('pi_1', d);
    expect(d.inpost.createShipment).toHaveBeenCalledOnce();
    expect(d.inpost.createDispatchOrder).not.toHaveBeenCalled();
  });

  // ── New: buy-step wiring ────────────────────────────────────────────────────

  it('new paczkomat create: calls buyShipment after saveShipment', async () => {
    const callOrder: string[] = [];
    const d = deps();
    (d.saveShipment as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('saveShipment');
    });
    (d.inpost.getShipment as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 42,
      status: 'created',
      tracking_number: '6200001',
      offers: [{ id: 99, status: 'available' }],
    });
    (d.inpost.buyShipment as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('buyShipment');
      return { id: 42, status: 'confirmed', tracking_number: '6200001' };
    });

    await createOrderShipment('pi_1', d);

    expect(callOrder).toEqual(['saveShipment', 'buyShipment']);
    expect(d.inpost.buyShipment).toHaveBeenCalledOnce();
    expect(d.inpost.buyShipment).toHaveBeenCalledWith('42', '99');
  });

  it('adoptExisting: false always creates a fresh shipment instead of adopting by reference', async () => {
    const findShipmentsByReference = vi.fn().mockResolvedValue([{ id: 99, status: 'created', reference: order.id }]);
    const base = deps();
    const d = deps({
      inpost: {
        ...base.inpost,
        findShipmentsByReference,
      },
    });

    await createOrderShipment('pi_1', d, { adoptExisting: false });

    expect(findShipmentsByReference).not.toHaveBeenCalled();
    expect(d.inpost.createShipment).toHaveBeenCalledOnce();
    expect(d.saveShipment).toHaveBeenCalledWith(order.id, expect.objectContaining({ shipmentId: '42' }));
  });

  it('idempotent replay: retries buy when delivery_status is not confirmed', async () => {
    const d = deps({
      loadOrder: vi.fn().mockResolvedValue({
        ...order,
        inpost_shipment_id: '42',
        delivery_status: 'created',
      }),
    });
    (d.inpost.getShipment as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 42,
      status: 'created',
      tracking_number: '6200001',
      offers: [{ id: 99, status: 'available' }],
    });

    await createOrderShipment('pi_1', d);

    expect(d.inpost.createShipment).not.toHaveBeenCalled();
    expect(d.inpost.buyShipment).toHaveBeenCalledOnce();
    expect(d.inpost.buyShipment).toHaveBeenCalledWith('42', '99');
  });

  it('idempotent replay: skips buy when delivery_status is already confirmed', async () => {
    const d = deps({
      loadOrder: vi.fn().mockResolvedValue({
        ...order,
        inpost_shipment_id: '42',
        delivery_status: 'confirmed',
      }),
    });

    await createOrderShipment('pi_1', d);

    expect(d.inpost.createShipment).not.toHaveBeenCalled();
    // buyShipmentWhenReady re-GETs and self-guards on status === 'confirmed'
    expect(d.inpost.buyShipment).not.toHaveBeenCalled();
  });

  it('kurier replay: calls BOTH createDispatchOrder and buyShipment when dispatch is missing and buy is pending', async () => {
    // Most dangerous replay case: shipment created, dispatch order missing, label not yet bought.
    // Verifies both paths are exercised and createShipment is NOT called again.
    const saveDispatchOrderId = vi.fn().mockResolvedValue(undefined);
    const kurierPartialReplay: OrderForShipment = {
      ...order,
      delivery_method: 'kurier',
      inpost_target_point: null,
      shipping_address: { street: 'Floriańska', building_number: '12', city: 'Kraków', post_code: '31-019', country_code: 'PL' },
      inpost_shipment_id: '42',          // shipment already created
      inpost_dispatch_order_id: null,    // dispatch order never persisted
      delivery_status: 'created',        // label not yet bought
    };
    const d = deps({
      loadOrder: vi.fn().mockResolvedValue(kurierPartialReplay),
      saveDispatchOrderId,
    });
    // getShipment returns a buyable offer — offer available on attempt 0, no sleep.
    (d.inpost.getShipment as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 42,
      status: 'created',
      tracking_number: '6200001',
      offers: [{ id: 99, status: 'available' }],
    });

    await createOrderShipment('pi_1', d);

    expect(d.inpost.createShipment).not.toHaveBeenCalled();           // no duplicate shipment
    expect(d.inpost.createDispatchOrder).toHaveBeenCalledOnce();      // dispatch retried
    expect(saveDispatchOrderId).toHaveBeenCalledWith('ord-1', '99'); // dispatch id persisted
    expect(d.inpost.buyShipment).toHaveBeenCalledOnce();              // buy executed
  });

  // ── New: adopt an existing ShipX shipment instead of duplicating it (F3) ──

  describe('adoption by reference (F3)', () => {
    it('adopts an existing shipment found by reference — does not call createShipment', async () => {
      const d = deps({
        loadOrder: vi.fn().mockResolvedValue(order),
      });
      (d.inpost.findShipmentsByReference as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 55, status: 'created', tracking_number: '6200099', created_at: '2026-06-01T10:00:00Z' },
      ]);

      await createOrderShipment('pi_1', d);

      expect(d.inpost.findShipmentsByReference).toHaveBeenCalledWith('ord-1');
      expect(d.inpost.createShipment).not.toHaveBeenCalled();
      expect(d.saveShipment).toHaveBeenCalledWith('ord-1', {
        shipmentId: '55',
        trackingNumber: '6200099',
        status: 'created',
      });
      // Adoption must feed the same buy-when-ready path as a fresh create.
      expect(d.inpost.getShipment).toHaveBeenCalledWith('55');
    });

    it('creates a new shipment when the lookup returns no matches (existing behavior)', async () => {
      const d = deps();
      (d.inpost.findShipmentsByReference as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await createOrderShipment('pi_1', d);

      expect(d.inpost.findShipmentsByReference).toHaveBeenCalledWith('ord-1');
      expect(d.inpost.createShipment).toHaveBeenCalledOnce();
      expect(d.saveShipment).toHaveBeenCalledWith('ord-1', {
        shipmentId: '42',
        trackingNumber: '6200001',
        status: 'created',
      });
    });

    it('propagates a lookup failure (retryable) and creates nothing', async () => {
      const d = deps({
        loadOrder: vi.fn().mockResolvedValue(order),
      });
      const lookupError = new Error('ShipX GET /shipments → 503: upstream unavailable');
      (d.inpost.findShipmentsByReference as ReturnType<typeof vi.fn>).mockRejectedValue(lookupError);

      await expect(createOrderShipment('pi_1', d)).rejects.toThrow(lookupError);

      expect(d.inpost.createShipment).not.toHaveBeenCalled();
      expect(d.saveShipment).not.toHaveBeenCalled();
    });

    it('adopts the oldest of multiple matches and logs a warning naming the orphans', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const d = deps({
        loadOrder: vi.fn().mockResolvedValue(order),
      });
      (d.inpost.findShipmentsByReference as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 77, status: 'created', tracking_number: '6200077', created_at: '2026-06-03T10:00:00Z' },
        { id: 55, status: 'created', tracking_number: '6200055', created_at: '2026-06-01T10:00:00Z' }, // oldest
        { id: 88, status: 'created', tracking_number: '6200088', created_at: '2026-06-02T10:00:00Z' },
      ]);

      await createOrderShipment('pi_1', d);

      expect(d.saveShipment).toHaveBeenCalledWith('ord-1', {
        shipmentId: '55',
        trackingNumber: '6200055',
        status: 'created',
      });
      expect(warnSpy).toHaveBeenCalledOnce();
      const warning = warnSpy.mock.calls[0].join(' ');
      expect(warning).toContain('ord-1');
      expect(warning).toContain('55'); // adopted
      expect(warning).toContain('77'); // orphan
      expect(warning).toContain('88'); // orphan
      // Orphans need a manual ShipX cancel — the warning must also reach Sentry.
      expect(Sentry.captureMessage).toHaveBeenCalledWith('shipx_orphaned_shipments', {
        level: 'warning',
        extra: { orderId: 'ord-1', adopted: '55', orphaned: ['88', '77'] }, // created_at order
      });

      warnSpy.mockRestore();
    });
  });
});

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
