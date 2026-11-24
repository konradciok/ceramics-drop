/**
 * Checkout delivery domain types — carrier-neutral. What the buyer chose at
 * checkout and what `orders` persists; carrier adapters (src/lib/carriers/)
 * turn these into their own API payloads.
 */
import type { DeliveryMethod } from '@/lib/pricing';

/** Receiver contact collected at checkout. `phone` is required for carrier shipments. */
export type DeliveryContact = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
};

/** Courier address (also what we persist in `orders.shipping_address`). */
export type DeliveryAddress = {
  street: string;
  building_number: string;
  city: string;
  post_code: string;
  country_code: string;
};

export type DeliverySelection = {
  method: DeliveryMethod;
  contact: DeliveryContact;
  /** Paczkomat code (e.g. 'KRA010') — paczkomat only. */
  target_point?: string;
  /** Courier address — kurier only. */
  address?: DeliveryAddress;
};

export type ValidateDeliveryResult =
  | { ok: true; delivery: DeliverySelection }
  | {
      ok: false;
      reason:
        | 'invalid_method'
        | 'invalid_contact'
        | 'missing_target_point'
        | 'invalid_address';
    };
