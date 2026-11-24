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
  try {
    const sendcloud = client ?? sendcloudFromEnv(getCloudflareContext().env);
    // In parallel: the point's details, and whether it takes parcels right
    // now (`is_expired` on the point is freshness only, not availability).
    const [point, available] = await Promise.all([
      sendcloud.getServicePoint(servicePointId),
      sendcloud.checkServicePointAvailability(servicePointId),
    ]);
    const checked = checkServicePoint(point, { country: destination.country, carrier: destination.sendcloudCarrier });
    if (!checked.ok) return checked;
    if (available === null) return { ok: false, reason: 'not_found' };
    if (!available) return { ok: false, reason: 'not_available' };
    return checked;
  } catch (err) {
    // A 4xx about the id itself (malformed, gone) is the buyer's point, not an outage.
    if (err instanceof SendcloudApiError && err.status < 500 && !SERVICE_FAULTS.has(err.status)) {
      return { ok: false, reason: 'not_found' };
    }
    Sentry.captureException(err, { tags: { area: 'checkout', step: 'sendcloud_service_point' } });
    return { ok: false, reason: 'unavailable' };
  }
}
