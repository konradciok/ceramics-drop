export type MarketingConsent = 'granted' | 'denied';

export type MarketingContext = {
  consent: MarketingConsent;
  fbp: string | null;
  fbc: string | null;
  ga_client_id: string | null;
  ga_session_id: string | null;
  /**
   * Google Ads click identifiers (gclid; gbraid/wbraid for iOS app-to-web and web-to-app),
   * captured at checkout under granted consent only. Stored for server-side / offline
   * Google Ads conversion upload and attribution audits; nothing sends them yet.
   * Optional: orders persisted before this field existed simply lack the keys.
   */
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  ip: string | null;
  user_agent: string | null;
  event_source_url: string | null;
  captured_at: string;
  /**
   * The buyer ticked the checkout "send me news about drops" box (explicit,
   * unticked by default). Independent of the cookie `consent` above — kept in
   * both branches, since it is a record of the buyer's own choice, not tracking
   * data. On payment the buyer is added to the Resend marketing segment
   * (completePaidOrder). Optional: orders persisted before it existed lack it.
   */
  email_opt_in?: boolean;
  /** ISO timestamp of the opt-in (evidence of consent); null when not given. */
  email_opt_in_at?: string | null;
};

/**
 * Google click ids (gclid / gbraid / wbraid) are URL-safe tokens. Anything else is
 * dropped so malformed or hostile input can never reach `orders.marketing`.
 */
export function sanitizeGoogleClickId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return /^[A-Za-z0-9_-]{8,200}$/.test(s) ? s : null;
}

/** Google tag click cookies (`_gcl_aw`, `_gcl_gb`) hold "GCL.<unix_ts>.<click_id>". */
export function parseGclCookie(cookie: string | null): string | null {
  if (!cookie) return null;
  const match = cookie.match(/^GCL\.\d+\.(.+)$/);
  return sanitizeGoogleClickId(match ? match[1] : null);
}

/** _ga = "GA1.1.<client_id_parts>"; client_id is the 3rd + 4th dot-segments. */
export function parseGaClientId(gaCookie: string | null): string | null {
  if (!gaCookie) return null;
  const parts = gaCookie.split('.');
  if (parts.length < 4) return null;
  return `${parts[2]}.${parts[3]}`;
}

/**
 * The numeric GA4 session id from any shape it reaches us in, or null:
 * - a bare id (`1795501352`);
 * - a legacy `_ga_<streamId>` cookie, `GS1.1.<session_id>.<…>`;
 * - a current one (rolled out by Google in 2025), `GS2.1.s<session_id>$o1$g1$t…`;
 * - the bare GS2 segment `s<session_id>$o1$…` — what the GS1-only parser used
 *   to store in `orders.marketing.ga_session_id`, so already-persisted orders
 *   still resolve.
 * Measurement Protocol only stitches an event to its session with the bare
 * number; anything else lands the event in a "(not set)" session.
 */
export function normalizeGaSessionId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  const match =
    /^(\d{1,20})$/.exec(v) ??
    /^GS1\.\d+\.(\d{1,20})(?:\.|$)/.exec(v) ??
    /^GS2\.\d+\.s(\d{1,20})(?:\$|$)/.exec(v) ??
    /^s(\d{1,20})(?:\$|$)/.exec(v);
  return match ? match[1] : null;
}

/** Session id from a `_ga_<streamId>` cookie value (GS1 or GS2 format). */
export function parseGaSessionId(gaSessionCookie: string | null): string | null {
  return normalizeGaSessionId(gaSessionCookie);
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
