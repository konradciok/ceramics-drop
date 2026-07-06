import { describe, it, expect, vi } from 'vitest';
import { createOrderReturn, type CreateReturnDeps } from './return';
import type { InPostClient } from './inpost';
import type { StudioReturnConfig } from './shipx';

const studioConfig: StudioReturnConfig = {
  first_name: 'Anna Ciok',
  last_name: 'Studio',
  email: 'studio@ciok.art',
  phone: '+48600000001',
  address: { street: 'Floriańska', building_number: '12', city: 'Kraków', post_code: '31-019', country_code: 'PL' },
  return_point: 'WAW20A',
};

const paidOrder = {
  id: 'ord-1',
  status: 'paid',
  delivery_method: 'paczkomat',
  email: 'buyer@example.com',
  receiver_first_name: 'Anna',
  receiver_last_name: 'Kowalska',
  receiver_phone: '+48111222333',
  locale: 'pl',
  inpost_return_shipment_id: null,
};

function deps(overrides: Partial<CreateReturnDeps> = {}): CreateReturnDeps {
  const inpost: InPostClient = {
    createShipment: vi.fn().mockResolvedValue({ id: 77, status: 'created', tracking_number: 'RET001' }),
    getShipment: vi.fn(),
    getLabelPdf: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    createDispatchOrder: vi.fn(),
    buyShipment: vi.fn(),
    findShipmentsByReference: vi.fn(),
  };
  return {
    loadOrder: vi.fn().mockResolvedValue(paidOrder),
    saveReturn: vi.fn().mockResolvedValue(undefined),
    inpost,
    studioConfig,
    ...overrides,
  };
}

describe('createOrderReturn', () => {
  it('creates a return shipment and persists id/tracking', async () => {
    const d = deps();
    const result = await createOrderReturn('ord-1', d);
    expect(result).toEqual({ ok: true, returnShipmentId: '77', trackingNumber: 'RET001' });
    expect(d.inpost.createShipment).toHaveBeenCalledOnce();
    expect(d.saveReturn).toHaveBeenCalledWith('ord-1', { returnShipmentId: '77', trackingNumber: 'RET001' });
  });

  it('saves the shipment ID before any further side effects', async () => {
    const callOrder: string[] = [];
    const d = deps({
      saveReturn: vi.fn().mockImplementation(() => { callOrder.push('save'); return Promise.resolve(); }),
    });
    (d.inpost.createShipment as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('create');
      return Promise.resolve({ id: 77, status: 'created', tracking_number: 'RET001' });
    });
    await createOrderReturn('ord-1', d);
    expect(callOrder).toEqual(['create', 'save']);
  });

  it('is idempotent when return shipment already exists', async () => {
    const d = deps({ loadOrder: vi.fn().mockResolvedValue({ ...paidOrder, inpost_return_shipment_id: '77' }) });
    const result = await createOrderReturn('ord-1', d);
    expect(result).toEqual({ ok: false, reason: 'already_returned' });
    expect(d.inpost.createShipment).not.toHaveBeenCalled();
  });

  it('rejects orders that are not paid', async () => {
    const d = deps({ loadOrder: vi.fn().mockResolvedValue({ ...paidOrder, status: 'pending' }) });
    const result = await createOrderReturn('ord-1', d);
    expect(result).toEqual({ ok: false, reason: 'not_eligible' });
  });

  it('rejects odbior (studio pickup — no carrier involved)', async () => {
    const d = deps({ loadOrder: vi.fn().mockResolvedValue({ ...paidOrder, delivery_method: 'odbior' }) });
    const result = await createOrderReturn('ord-1', d);
    expect(result).toEqual({ ok: false, reason: 'not_eligible' });
  });

  it('returns order_not_found for unknown order', async () => {
    const d = deps({ loadOrder: vi.fn().mockResolvedValue(null) });
    const result = await createOrderReturn('unknown', d);
    expect(result).toEqual({ ok: false, reason: 'order_not_found' });
  });

  it('propagates InPost API errors', async () => {
    const d = deps();
    (d.inpost.createShipment as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ShipX unavailable'));
    await expect(createOrderReturn('ord-1', d)).rejects.toThrow('ShipX unavailable');
    expect(d.saveReturn).not.toHaveBeenCalled();
  });
});
