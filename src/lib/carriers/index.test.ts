import { describe, it, expect, vi } from 'vitest';
import { carrierResolver, carriersFromEnv, parcelForOrder, sendcloudCarrierFromEnv } from './index';
import { shippingChannelOf } from './channel';
import { SendcloudConfigError } from './sendcloud/errors';
import { PARCEL_DIMS } from '@/lib/packing';
import type { ShipmentCarrier } from './types';

function itemsClient(rows: Array<{ product_id: string; variant: unknown }>, error: { message: string } | null = null) {
  const eq = vi.fn(async () => ({ data: error ? null : rows, error }));
  return { from: vi.fn(() => ({ select: vi.fn(() => ({ eq })) })) } as never;
}

describe('shippingChannelOf', () => {
  it('reads NULL (pre-column orders) as ShipX', () => {
    expect(shippingChannelOf({ shipping_channel: 'sendcloud' })).toBe('sendcloud');
    expect(shippingChannelOf({ shipping_channel: 'inpost_shipx' })).toBe('inpost_shipx');
    expect(shippingChannelOf({ shipping_channel: null })).toBe('inpost_shipx');
    expect(shippingChannelOf({})).toBe('inpost_shipx');
  });
});

describe('carrierResolver', () => {
  it('builds each adapter lazily, once', () => {
    const shipx = { channel: 'inpost_shipx' } as ShipmentCarrier;
    const factories = { inpost_shipx: vi.fn(() => shipx), sendcloud: vi.fn(() => ({}) as ShipmentCarrier) };
    const carriers = carrierResolver(factories);

    expect(factories.inpost_shipx).not.toHaveBeenCalled();
    expect(carriers('inpost_shipx')).toBe(shipx);
    expect(carriers('inpost_shipx')).toBe(shipx);
    expect(factories.inpost_shipx).toHaveBeenCalledOnce();
    expect(factories.sendcloud).not.toHaveBeenCalled();
  });

  it('fails only the channel whose env is missing', () => {
    const carriers = carriersFromEnv(
      { INPOST_API_URL: 'https://shipx.test', INPOST_API_TOKEN: 't', INPOST_ORGANIZATION_ID: '1' } as CloudflareEnv,
      itemsClient([]),
    );
    expect(carriers('inpost_shipx').channel).toBe('inpost_shipx');
    expect(() => carriers('sendcloud')).toThrow(SendcloudConfigError);
  });
});

describe('sendcloudCarrierFromEnv', () => {
  it('needs a positive integer sender address id', () => {
    const env = { SENDCLOUD_PUBLIC_KEY: 'p', SENDCLOUD_SECRET_KEY: 's' } as CloudflareEnv;
    expect(() => sendcloudCarrierFromEnv(env, itemsClient([]))).toThrow(/SENDCLOUD_SENDER_ADDRESS_ID/);
    expect(() => sendcloudCarrierFromEnv({ ...env, SENDCLOUD_SENDER_ADDRESS_ID: 'abc' } as CloudflareEnv, itemsClient([]))).toThrow(/not_configured/);
    expect(sendcloudCarrierFromEnv({ ...env, SENDCLOUD_SENDER_ADDRESS_ID: '42' } as CloudflareEnv, itemsClient([])).channel).toBe('sendcloud');
  });
});

describe('parcelForOrder', () => {
  it('sizes a single-box order from the packing estimate', async () => {
    const parcel = await parcelForOrder(itemsClient([{ product_id: 'k01', variant: null }]), 'o1');
    expect(parcel.weightKg).toBeGreaterThan(0);
    // Either a stocked carton or a full slot — never larger than gabaryt C.
    expect(parcel.lengthCm).toBeLessThanOrEqual(PARCEL_DIMS.C.l);
    expect(parcel.heightCm).toBeLessThanOrEqual(PARCEL_DIMS.C.h);
  });

  it('stops for manual packing when nothing (or more than one box) ships', async () => {
    await expect(parcelForOrder(itemsClient([{ product_id: 'legacy', variant: { kind: 'print' } }]), 'o1')).rejects.toMatchObject({
      code: 'manual_packing_required',
    });
  });

  it('throws on a failed item load', async () => {
    await expect(parcelForOrder(itemsClient([], { message: 'db down' }), 'o1')).rejects.toThrow(/db down/);
  });
});
