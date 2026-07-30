export type MarketingConsent = 'granted' | 'denied';

export type MarketingContext = {
  consent: MarketingConsent;
  fbp: string | null;
  fbc: string | null;
  ga_client_id: string | null;
  ga_session_id: string | null;
  ip: string | null;
  user_agent: string | null;
  event_source_url: string | null;
  captured_at: string;
};

/** _ga = "GA1.1.<client_id_parts>"; client_id is the 3rd + 4th dot-segments. */
export function parseGaClientId(gaCookie: string | null): string | null {
  if (!gaCookie) return null;
  const parts = gaCookie.split('.');
  if (parts.length < 4) return null;
  return `${parts[2]}.${parts[3]}`;
}

/** _ga_<streamId> = "GS1.1.<session_id>.<...>"; session_id is the 3rd dot-segment. */
export function parseGaSessionId(gaSessionCookie: string | null): string | null {
  if (!gaSessionCookie) return null;
  const parts = gaSessionCookie.split('.');
  return parts.length >= 3 ? parts[2] : null;
}

/**
 * The GA4 client_id to persist for a checkout. Prefer the visitor's real `_ga`
 * client_id (already parsed from the cookie by the caller); when it is absent —
 * Safari ITP cleared `_ga`, or storage was denied — mint a per-order fallback so
 * the server-side GA4 MP purchase (the revenue safety net) still records instead
 * of skipping (see sendGa4Purchase in ga4-mp.ts / audit N-6). Caveat: a minted id
 * is unique to this order, so GA4 cannot stitch it to the visitor's other
 * sessions or devices.
 * ponytail: per-order fallback; upgrade to a first-party `acc_ga_cid` cookie only
 * if within-browser session stitching for cleared-cookie visitors ever matters.
 */
export function resolveGaClientId(fromCookie: string | null): string {
  return fromCookie ?? crypto.randomUUID();
}
