import type { DeliveryAddress } from './shipx';
import type { PrintShippingAddress } from './print-delivery';

export type StoredShippingAddress = DeliveryAddress | PrintShippingAddress;

export type NormalizedShippingAddress = {
  line1: string;
  line2?: string;
  city: string;
  post_code: string;
  country_code: string;
  /** Present only for legacy ceramic addresses and CSV compatibility. */
  street?: string;
  /** Present only for legacy ceramic addresses and CSV compatibility. */
  building_number?: string;
};

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

/** Read either the legacy ShipX JSONB shape or the native print address shape. */
export function normalizeShippingAddress(raw: unknown): NormalizedShippingAddress | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const address = raw as Record<string, unknown>;
  const city = text(address.city);
  const postCode = text(address.post_code);
  const countryCode = text(address.country_code);
  if (!city || !postCode || !countryCode) return null;

  const nativeLine1 = text(address.line1);
  if (nativeLine1) {
    const line2 = text(address.line2);
    return {
      line1: nativeLine1,
      ...(line2 ? { line2 } : {}),
      city,
      post_code: postCode,
      country_code: countryCode,
    };
  }

  const street = text(address.street);
  const buildingNumber = text(address.building_number);
  const line1 = [street, buildingNumber].filter(Boolean).join(' ');
  if (!line1) return null;
  return {
    line1,
    city,
    post_code: postCode,
    country_code: countryCode,
    ...(street ? { street } : {}),
    ...(buildingNumber ? { building_number: buildingNumber } : {}),
  };
}

export function formatShippingAddress(raw: unknown): string | null {
  const address = normalizeShippingAddress(raw);
  if (!address) return null;
  return [
    address.line1,
    address.line2,
    `${address.post_code} ${address.city}`,
    address.country_code,
  ].filter(Boolean).join(', ');
}

