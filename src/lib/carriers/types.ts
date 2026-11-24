/**
 * Carrier adapter contract. `createOrderShipment` (src/lib/shipment.ts) owns
 * the order-level orchestration — load, idempotency, persistence — and drives
 * any carrier through this interface, so adding a carrier never touches the
 * Stripe webhook, the admin actions or the orders CLI.
 */
import type { DeliveryMethod } from '@/lib/pricing';
import type { DeliveryAddress } from '@/lib/delivery/types';

/** Which carrier integration an order's shipment lives in. */
export type ShippingChannel = 'inpost_shipx';

/**
 * Order fields a carrier needs to create a shipment (a subset of the `orders`
 * row). The `inpost_*` columns hold the shipment of whichever channel ships it.
 */
export type OrderForShipment = {
  id: string;
  delivery_method: DeliveryMethod;
  email: string | null;
  receiver_first_name: string | null;
  receiver_last_name: string | null;
  receiver_phone: string | null;
  inpost_target_point: string | null;
  shipping_address: DeliveryAddress | null;
  /** Set once a shipment exists — used to keep creation idempotent. */
  inpost_shipment_id: string | null;
  /** Set once a dispatch order exists — used to retry dispatch when shipment succeeded but dispatch failed. */
  inpost_dispatch_order_id: string | null;
  /** Latest carrier delivery status (e.g. 'created', 'confirmed') — used to retry the commit step on replays. */
  delivery_status?: string | null;
};

/** A shipment as the orchestration persists it. */
export type CarrierShipment = {
  id: string;
  trackingNumber: string | null;
  status: string;
};

/** Where an order's shipment stands once its id is saved — what `complete` needs. */
export type ShipmentProgress = {
  orderId: string;
  deliveryMethod: DeliveryMethod;
  shipmentId: string;
  /** Persisted courier dispatch order id, if any. */
  dispatchOrderId: string | null;
  /** Last persisted status; null when unknown (fresh create) — the carrier re-reads it. */
  deliveryStatus: string | null;
};

/** Persistence callbacks a carrier may need while completing a shipment. */
export type ShipmentHooks = {
  /** Persist a courier dispatch order id; dispatch is skipped when absent. */
  saveDispatchOrderId?: (orderId: string, dispatchOrderId: string) => Promise<void>;
};

export interface ShipmentCarrier {
  readonly channel: ShippingChannel;
  /**
   * Create the order's shipment, or adopt one a previous attempt already
   * created but failed to persist (the API-success-then-DB-save-fails window).
   * `adoptExisting: false` always creates (admin "recreate").
   */
  create(order: OrderForShipment, opts: { adoptExisting: boolean }): Promise<CarrierShipment>;
  /**
   * Finish a shipment whose id is already persisted: every post-create step
   * (courier pickup, buying the label). Idempotent — runs on every replay.
   */
  complete(progress: ShipmentProgress, hooks: ShipmentHooks): Promise<void>;
  /** A6 PDF label bytes. */
  getLabelPdf(shipmentId: string): Promise<ArrayBuffer>;
  /** Whether retrying the payment webhook could fix this failure. */
  isRetryable(err: unknown): boolean;
}
