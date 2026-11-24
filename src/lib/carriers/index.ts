/**
 * Builds carrier adapters from a Workers env. Server-only.
 *
 * Adapters are created lazily per channel, so an env without Sendcloud keys
 * keeps every ShipX order working (and vice versa) — only orders on the
 * unconfigured channel fail, with a non-retryable config error.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { recommendPacking, PARCEL_DIMS, CUSTOM_CARTONS } from '@/lib/packing';
import { inpostFromEnv } from './inpost-shipx/client';
import { shipxCarrier } from './inpost-shipx/carrier';
import { sendcloudFromEnv } from './sendcloud/client';
import { sendcloudCarrier } from './sendcloud/carrier';
import { SendcloudConfigError } from './sendcloud/errors';
import type { SendcloudParcelSpec } from './sendcloud/payload';
import type { CarrierResolver, ShipmentCarrier, ShippingChannel } from './types';

/** Memoise one lazily-built adapter per channel. */
export function carrierResolver(factories: Record<ShippingChannel, () => ShipmentCarrier>): CarrierResolver {
  const built = new Map<ShippingChannel, ShipmentCarrier>();
  return (channel) => {
    let carrier = built.get(channel);
    if (!carrier) {
      carrier = factories[channel]();
      built.set(channel, carrier);
    }
    return carrier;
  };
}

/**
 * The one parcel a Sendcloud point shipment carries, from the packing estimate
 * of the order's ceramic lines. More than one box (or none) cannot be
 * announced automatically: it stops with `manual_packing_required` so the
 * studio splits or ships it by hand.
 */
export async function parcelForOrder(supabase: SupabaseClient, orderId: string): Promise<SendcloudParcelSpec> {
  const { data, error } = await supabase
    .from('order_items')
    .select('product_id, variant')
    .eq('order_id', orderId);
  if (error) throw new Error(`parcelForOrder: order_items load failed for ${orderId}: ${error.message}`);
  const productIds = (data ?? [])
    .filter((row: { variant: unknown }) => row.variant === null)
    .map((row: { product_id: string }) => row.product_id);

  const plan = recommendPacking(productIds);
  if (plan.packages.length !== 1) {
    throw new SendcloudConfigError(
      'manual_packing_required',
      `order ${orderId} packs into ${plan.packages.length} parcels (${plan.planLabel})`,
    );
  }
  const [pkg] = plan.packages;
  const carton = pkg.carton ? CUSTOM_CARTONS.find((c) => c.code === pkg.carton) : undefined;
  const dims = carton ?? PARCEL_DIMS[pkg.size];
  return { weightKg: pkg.weightKg, lengthCm: dims.l, widthCm: dims.w, heightCm: dims.h };
}

/** The Sendcloud adapter from env; throws `not_configured` when keys or sender are missing. */
export function sendcloudCarrierFromEnv(env: CloudflareEnv, supabase: SupabaseClient): ShipmentCarrier {
  const senderAddressId = Number(env.SENDCLOUD_SENDER_ADDRESS_ID?.trim());
  if (!Number.isInteger(senderAddressId) || senderAddressId <= 0) {
    throw new SendcloudConfigError('not_configured', 'SENDCLOUD_SENDER_ADDRESS_ID missing or not a positive integer');
  }
  return sendcloudCarrier({
    client: sendcloudFromEnv(env),
    senderAddressId,
    parcelFor: (orderId) => parcelForOrder(supabase, orderId),
  });
}

/** Both adapters over one env + service-role Supabase client. */
export function carriersFromEnv(env: CloudflareEnv, supabase: SupabaseClient): CarrierResolver {
  return carrierResolver({
    inpost_shipx: () => shipxCarrier(inpostFromEnv(env)),
    sendcloud: () => sendcloudCarrierFromEnv(env, supabase),
  });
}
