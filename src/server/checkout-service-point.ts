/**
 * Checkout's re-check of the Sendcloud service point a buyer picked, before a
 * PaymentIntent exists. The browser sends only the point id; this asks
 * Sendcloud for the point and keeps what Sendcloud says (carrier, country,
 * address) — never what the picker reported on the buyer's device.
 */
import * as Sentry from '@sentry/nextjs';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { sendcloudFromEnv, type SendcloudClient } from '@/lib/carriers/sendcloud/client';
import { SendcloudApiError } from '@/lib/carriers/sendcloud/errors';
import { checkServicePoint, type ServicePointCheck } from '@/lib/carriers/sendcloud/service-points';
import type { Destination } from '@/lib/delivery/destinations';

/** `unavailable` = Sendcloud could not be asked (not configured, down, throttled): the buyer may retry. */
export type CheckoutServicePointResult = ServicePointCheck | { ok: false; reason: 'unavailable' };

// 4xx answers that say something about OUR request, not about the point.
const SERVICE_FAULTS = new Set([401, 403, 408, 425, 429]);

export async function verifyCheckoutServicePoint(
  servicePointId: string,
  destination: Pick<Destination, 'country' | 'sendcloudCarrier'>,
  client?: SendcloudClient,
): Promise<CheckoutServicePointResult> {
  let sendcloud: SendcloudClient;
  try {
    sendcloud = client ?? sendcloudFromEnv(getCloudflareContext().env);
  } catch (err) {
    return unavailable(err);
  }

  // In parallel: the point's details, and whether it takes parcels right
  // now (`is_expired` on the point is freshness only, not availability).
  const [lookup, availability] = await Promise.allSettled([
    sendcloud.getServicePoint(servicePointId),
    sendcloud.checkServicePointAvailability(servicePointId),
  ]);

  if (lookup.status === 'rejected') {
    // A 4xx about the id itself (malformed, gone) is the buyer's point, not an outage.
    const err = lookup.reason;
    if (err instanceof SendcloudApiError && err.status < 500 && !SERVICE_FAULTS.has(err.status)) {
      return { ok: false, reason: 'not_found' };
    }
    return unavailable(err);
  }
  const checked = checkServicePoint(lookup.value, { country: destination.country, carrier: destination.sendcloudCarrier });
  if (!checked.ok) return checked;

  // The point exists, so any failure here (an unknown id is a resolved null)
  // means availability could not be established — never the buyer's fault.
  if (availability.status === 'rejected') return unavailable(availability.reason);
  if (availability.value === null) return { ok: false, reason: 'not_found' };
  if (!availability.value) return { ok: false, reason: 'not_available' };
  return checked;
}

function unavailable(err: unknown): CheckoutServicePointResult {
  Sentry.captureException(err, { tags: { area: 'checkout', step: 'sendcloud_service_point' } });
  return { ok: false, reason: 'unavailable' };
}
