/**
 * Decide whether the Cloudflare Queue consumer should ack or retry a
 * fulfilment message after `processJob` threw. Terminal failures
 * (`retryable === false`) are acked so they drop out of the retry loop
 * instead of bouncing for `max_retries`; everything else is retried —
 * plain `Error`, transient DB/Prodigi hiccups, and unknown shapes all
 * default to retry so a paid order is never silently dropped.
 */
export function decideMessageDisposition(err: unknown): 'ack' | 'retry' {
  if ((err as { retryable?: boolean })?.retryable === false) return 'ack';
  return 'retry';
}
