import { describe, it, expect, vi } from 'vitest';
import { createOrderShipment, type CreateShipmentDeps } from './shipment';
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

function deps(overrides: Partial<CreateShipmentDeps> = {}): CreateShipmentDeps {
  const inpost: InPostClient = {
    createShipment: vi.fn().mockResolvedValue({ id: 42, status: 'created', tracking_number: '6200001' }),
    getShipment: vi.fn(),
    getLabelPdf: vi.fn(),
    createDispatchOrder: vi.fn().mockResolvedValue({ id: 99, status: 'created', deadline_time: '2026-06-05 18:00' }),
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

  it('is idempotent when a shipment already exists', async () => {
    const d = deps({ loadOrder: vi.fn().mockResolvedValue({ ...order, inpost_shipment_id: '42' }) });
    await createOrderShipment('pi_1', d);
    expect(d.inpost.createShipment).not.toHaveBeenCalled();
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
});
