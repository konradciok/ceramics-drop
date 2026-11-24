import { describe, it, expect, vi } from 'vitest';
import * as Sentry from '@sentry/nextjs';
import { createOrderShipment, type CreateShipmentDeps } from './shipment';
import { shipxCarrier } from './carriers/inpost-shipx/carrier';
import type { InPostClient } from './carriers/inpost-shipx/client';
import type { OrderForShipment, ShipmentCarrier } from './carriers/types';

vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }));

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
type ShipxTestDeps = Omit<CreateShipmentDeps, 'carrier'> & { inpost: InPostClient };

/** Orchestration deps over the real ShipX carrier, exposing its mocked client as `inpost`. */
function deps(overrides: Partial<ShipxTestDeps> = {}): CreateShipmentDeps & { inpost: InPostClient } {
  const defaultInpost: InPostClient = {
    createShipment: vi.fn().mockResolvedValue({ id: 42, status: 'created', tracking_number: '6200001' }),
    getShipment: vi.fn().mockResolvedValue({ id: 42, status: 'created', tracking_number: '6200001', offers: [{ id: 99, status: 'available' }] }),
    buyShipment: vi.fn().mockResolvedValue({ id: 42, status: 'confirmed', tracking_number: '6200001' }),
    getLabelPdf: vi.fn(),
    createDispatchOrder: vi.fn().mockResolvedValue({ id: 99, status: 'created', deadline_time: '2026-06-05 18:00' }),
    // Default: no prior ShipX shipment under this order's reference — create as today.
    findShipmentsByReference: vi.fn().mockResolvedValue([]),
  };
  const inpost = overrides.inpost ?? defaultInpost;
  return {
    loadOrder: vi.fn().mockResolvedValue(order),
    saveShipment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
    inpost,
    carrier: shipxCarrier(inpost),
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


/**
 * A carrier with no ShipX semantics at all: proves the orchestration drives
 * any adapter purely through the ShipmentCarrier contract.
 */
function fakeCarrier(overrides: Partial<ShipmentCarrier> = {}): ShipmentCarrier {
  return {
    channel: 'inpost_shipx',
    create: vi.fn().mockResolvedValue({ id: 'sc-1', trackingNumber: 'TRK1', status: 'announced' }),
    complete: vi.fn().mockResolvedValue(undefined),
    getLabelPdf: vi.fn(),
    isRetryable: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

describe('createOrderShipment with any carrier', () => {
  it('creates, persists, then completes the fresh shipment with unknown status', async () => {
    const calls: string[] = [];
    const carrier = fakeCarrier({
      create: vi.fn(async () => {
        calls.push('create');
        return { id: 'sc-1', trackingNumber: 'TRK1', status: 'announced' };
      }),
      complete: vi.fn(async () => {
        calls.push('complete');
      }),
    });
    const saveShipment = vi.fn(async () => {
      calls.push('save');
    });
    const saveDispatchOrderId = vi.fn();

    await createOrderShipment('pi_1', {
      loadOrder: vi.fn().mockResolvedValue(order),
      saveShipment,
      saveDispatchOrderId,
      carrier,
    });

    expect(calls).toEqual(['create', 'save', 'complete']);
    expect(carrier.create).toHaveBeenCalledWith(order, { adoptExisting: true });
    expect(saveShipment).toHaveBeenCalledWith('ord-1', { shipmentId: 'sc-1', trackingNumber: 'TRK1', status: 'announced' });
    expect(carrier.complete).toHaveBeenCalledWith(
      { orderId: 'ord-1', deliveryMethod: 'paczkomat', shipmentId: 'sc-1', dispatchOrderId: null, deliveryStatus: null },
      { saveDispatchOrderId },
    );
  });

  it('only completes a shipment that is already persisted', async () => {
    const carrier = fakeCarrier();
    await createOrderShipment('pi_1', {
      loadOrder: vi.fn().mockResolvedValue({
        ...order,
        inpost_shipment_id: 'sc-9',
        inpost_dispatch_order_id: 'd-1',
        delivery_status: 'ready_to_pickup',
      }),
      saveShipment: vi.fn(),
      carrier,
    });

    expect(carrier.create).not.toHaveBeenCalled();
    expect(carrier.complete).toHaveBeenCalledWith(
      { orderId: 'ord-1', deliveryMethod: 'paczkomat', shipmentId: 'sc-9', dispatchOrderId: 'd-1', deliveryStatus: 'ready_to_pickup' },
      { saveDispatchOrderId: undefined },
    );
  });

  it('passes adoptExisting: false through and does not complete when create fails', async () => {
    const carrier = fakeCarrier({ create: vi.fn().mockRejectedValue(new Error('carrier down')) });
    const saveShipment = vi.fn();

    await expect(
      createOrderShipment('pi_1', { loadOrder: vi.fn().mockResolvedValue(order), saveShipment, carrier }, { adoptExisting: false }),
    ).rejects.toThrow('carrier down');

    expect(carrier.create).toHaveBeenCalledWith(order, { adoptExisting: false });
    expect(saveShipment).not.toHaveBeenCalled();
    expect(carrier.complete).not.toHaveBeenCalled();
  });

  it('never calls the carrier for studio pickup', async () => {
    const carrier = fakeCarrier();
    await createOrderShipment('pi_1', {
      loadOrder: vi.fn().mockResolvedValue({ ...order, delivery_method: 'odbior' }),
      saveShipment: vi.fn(),
      carrier,
    });
    expect(carrier.create).not.toHaveBeenCalled();
    expect(carrier.complete).not.toHaveBeenCalled();
  });
});
