import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ applySendcloudParcelUpdate: vi.fn(), sendcloudFromEnv: vi.fn() }));
vi.mock('./sendcloud-parcel-update', () => ({ applySendcloudParcelUpdate: mocks.applySendcloudParcelUpdate }));
vi.mock('@/lib/carriers/sendcloud/client', () => ({ sendcloudFromEnv: mocks.sendcloudFromEnv }));

import { sweepSendcloudShipments } from './sweep-sendcloud-shipments';
import type { SendcloudClient } from '@/lib/carriers/sendcloud/client';

function supabaseReturning(rows: Array<{ id: string; inpost_shipment_id: string }>, error: { message: string } | null = null) {
  const calls: Array<[string, ...unknown[]]> = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'not', 'or', 'gte', 'order']) {
    chain[m] = vi.fn((...args: unknown[]) => {
      calls.push([m, ...args]);
      return chain;
    });
  }
  chain.limit = vi.fn(async () => ({ data: error ? null : rows, error }));
  return { client: { from: vi.fn(() => chain) } as never, calls };
}

const env = {} as CloudflareEnv;

describe('sweepSendcloudShipments', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds no client when no Sendcloud parcel is open', async () => {
    const db = supabaseReturning([]);
    await expect(sweepSendcloudShipments({ supabase: db.client, env })).resolves.toEqual({ checked: 0, applied: 0, failed: [] });
    expect(mocks.sendcloudFromEnv).not.toHaveBeenCalled();
    expect(db.calls).toContainEqual(['eq', 'shipping_channel', 'sendcloud']);
    expect(db.calls).toContainEqual(['or', 'delivery_status.is.null,delivery_status.not.in.(delivered,returned_to_sender,canceled)']);
  });

  it('feeds each open parcel through the shared update and keeps going past a failure', async () => {
    const db = supabaseReturning([
      { id: 'o1', inpost_shipment_id: 's1' },
      { id: 'o2', inpost_shipment_id: 's2' },
      { id: 'o3', inpost_shipment_id: 's3' },
    ]);
    const client = {
      getShipment: vi.fn(async (id: string) => {
        if (id === 's2') throw new Error('Sendcloud 503');
        return { id, parcels: [{ id: 1, status: { code: 'DELIVERED' }, tracking_number: `T-${id}`, tracking_url: null }] };
      }),
    } as unknown as SendcloudClient;
    mocks.applySendcloudParcelUpdate.mockResolvedValueOnce('applied').mockResolvedValueOnce('unchanged');
    const getLabelPdf = vi.fn();

    const result = await sweepSendcloudShipments({ supabase: db.client, env, client, getLabelPdf });

    expect(result).toEqual({ checked: 3, applied: 1, failed: [{ orderId: 'o2', error: 'Sendcloud 503' }] });
    expect(mocks.applySendcloudParcelUpdate).toHaveBeenCalledWith(
      { supabase: db.client, getLabelPdf, env },
      { orderId: 'o1', trackingNumber: 'T-s1', trackingUrl: null, status: { code: 'DELIVERED' } },
    );
  });

  it('throws when the order query fails (the cron wrapper alerts)', async () => {
    const db = supabaseReturning([], { message: 'db down' });
    await expect(sweepSendcloudShipments({ supabase: db.client, env })).rejects.toThrow(/db down/);
  });
});
