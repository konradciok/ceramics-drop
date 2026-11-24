/**
 * Carrier-agnostic failure classification for the payment webhook: rethrow
 * (so Stripe redelivers) only when a retry might succeed.
 */
import { shouldRethrowShipmentError } from './inpost-shipx/errors';
import {
  isRetryableSendcloudError,
  SendcloudApiError,
  SendcloudConfigError,
} from './sendcloud/errors';

export function isRetryableShipmentError(err: unknown): boolean {
  if (err instanceof SendcloudApiError || err instanceof SendcloudConfigError) {
    return isRetryableSendcloudError(err);
  }
  // ShipX errors — and anything unknown (network, DB), which defaults to retryable.
  return shouldRethrowShipmentError(err);
}
