/**
 * Sendcloud adapter for the carrier contract (src/lib/carriers/types.ts):
 * InPost Spain lockers / Punto Pack points, shipped from mainland Spain.
 *
 * Lifecycle: one synchronous announce returns the shipment with its label
 * (status Ready to send = `confirmed`), so `complete` has nothing to do. The
 * studio drops the parcel at any InPost Spain point; status updates arrive by
 * the signed webhook (src/app/api/sendcloud/webhook) and the cron backstop.
 */
import type { CarrierShipment, OrderForShipment, ShipmentCarrier } from '@/lib/carriers/types';
import { destinationFor } from '@/lib/delivery/destinations';
import { httpsUrlOrNull } from '@/lib/tracking';
import { SendcloudApiError, SendcloudConfigError } from './errors';
import { buildAnnounceRequest, type SendcloudParcelSpec } from './payload';
import { CANCELED_STATUS, mapSendcloudStatus } from './status-map';
import type { SendcloudClient, SendcloudShipment } from './client';

export type SendcloudCarrierDeps = {
  client: SendcloudClient;
  /** `sender_address_id` of the mainland-Spain sender address in the Sendcloud panel. */
  senderAddressId: number;
  /** The single parcel for an order; throws `manual_packing_required` otherwise. */
  parcelFor: (orderId: string) => Promise<SendcloudParcelSpec>;
  /** Shipping option code for a destination; defaults to the destination registry. */
  shippingOptionFor?: (country: string) => string | null;
};

function registryShippingOption(country: string): string | null {
  return destinationFor(country)?.sendcloudShippingOption ?? null;
}

/** The persisted view of a Sendcloud shipment (its first — and only — parcel). */
export function toCarrierShipment(shipment: SendcloudShipment): CarrierShipment {
  const parcel = shipment.parcels?.[0];
  return {
    id: String(shipment.id),
    trackingNumber: typeof parcel?.tracking_number === 'string' && parcel.tracking_number ? parcel.tracking_number : null,
    status: mapSendcloudStatus(parcel?.status) ?? 'created',
    trackingUrl: httpsUrlOrNull(parcel?.tracking_url),
  };
}

export function sendcloudCarrier(deps: SendcloudCarrierDeps): ShipmentCarrier {
  const shippingOptionFor = deps.shippingOptionFor ?? registryShippingOption;

  return {
    channel: 'sendcloud',

    // `adoptExisting` needs no lookup here: Sendcloud deduplicates on
    // external_reference_id (orders.id:<shipment_attempt>) and answers a repeat
    // with the existing shipment. An admin recreate advances the attempt first,
    // so it always mints a new shipment.
    async create(order: OrderForShipment) {
      const country = order.delivery_country?.trim().toUpperCase() ?? '';
      const shippingOptionCode = shippingOptionFor(country);
      if (!shippingOptionCode) {
        throw new SendcloudConfigError('no_shipping_option', `no verified Sendcloud shipping option for ${country || 'unknown country'} (order ${order.id})`);
      }
      const parcel = await deps.parcelFor(order.id);
      const body = buildAnnounceRequest(order, {
        senderAddressId: deps.senderAddressId,
        shippingOptionCode,
        parcel,
      });
      const { shipment } = await deps.client.announceShipment(body);
      return toCarrierShipment(shipment);
    },

    async complete() {
      // Announced shipments carry their label already — nothing left to do.
    },

    async getLabelPdf(shipmentId) {
      const shipment = await deps.client.getShipment(shipmentId);
      const parcelId = shipment.parcels?.[0]?.id;
      if (parcelId === undefined || parcelId === null) {
        throw new Error(`Sendcloud shipment ${shipmentId} has no parcel to label`);
      }
      return deps.client.getParcelLabelPdf(String(parcelId));
    },

    // Idempotent: a repeat cancel (e.g. a recreate retried after the DB clear
    // failed) answers a 4xx for an already-cancelled shipment. Confirm that
    // state from the shipment itself; any other refusal (delivered, past the
    // 42-day window) still throws.
    async cancel(shipmentId) {
      try {
        await deps.client.cancelShipment(shipmentId);
      } catch (err) {
        if (!(err instanceof SendcloudApiError) || err.status >= 500) throw err;
        const shipment = await deps.client.getShipment(shipmentId);
        const status = shipment.parcels?.[0]?.status;
        const pendingCancel = /cancel/i.test(`${status?.code ?? ''} ${status?.message ?? ''}`);
        if (mapSendcloudStatus(status) !== CANCELED_STATUS && !pendingCancel) throw err;
      }
    },
  };
}
