/* ============================================================
   Shared shipment-tracking helpers — used by the Prodigi callback
   (persistence), customer emails, the account pages, and the admin
   fulfilment view.
   ============================================================ */

/**
 * Validate an externally-sourced tracking URL. Carrier tracking URLs arrive
 * from Prodigi callbacks and are later rendered as `href`s, so they are
 * untrusted external data: only absolute `https://` URLs are ever stored or
 * linked (closing off `javascript:`/`data:`-scheme injection from a buggy or
 * compromised upstream payload). Anything else → null — callers keep the bare
 * tracking number as text.
 */
export function httpsUrlOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === 'https:' ? url.href : null;
}

/** Public InPost tracking page for a shipment number (shipping email + account pages). */
export function inpostTrackingUrl(trackingNumber: string): string {
  return `https://inpost.pl/sledzenie-przesylek?number=${encodeURIComponent(trackingNumber)}`;
}
