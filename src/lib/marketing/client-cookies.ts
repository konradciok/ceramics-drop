import { parseGaClientId, parseGaSessionId, parseGclCookie, sanitizeGoogleClickId } from './context';

export type MarketingCookies = {
  fbp: string | null;
  fbc: string | null;
  ga_client_id: string | null;
  ga_session_id: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
};

// A malformed %-sequence in a third-party cookie must never throw: this runs
// right before the checkout POST, so an exception would block the purchase.
function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function readCookie(cookieString: string, name: string): string | null {
  const match = cookieString.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? safeDecode(match[1]) : null;
}

function readGaSessionCookie(cookieString: string): string | null {
  // The _ga_<streamId> name carries a per-stream suffix we don't know at build time.
  const match = cookieString.match(/(?:^|;\s*)_ga_[A-Z0-9]+=([^;]+)/);
  return match ? safeDecode(match[1]) : null;
}

export function collectMarketingCookies(
  doc: Pick<Document, 'cookie'> = document,
  loc: Pick<Location, 'search'> = window.location,
  nowMs: number = Date.now(),
): MarketingCookies {
  const cookies = doc.cookie ?? '';
  let fbc = readCookie(cookies, '_fbc');
  if (!fbc) {
    const fbclid = new URLSearchParams(loc.search).get('fbclid');
    if (fbclid) fbc = `fb.1.${nowMs}.${fbclid}`; // Meta's documented _fbc format
  }
  const params = new URLSearchParams(loc.search);
  return {
    fbp: readCookie(cookies, '_fbp'),
    fbc,
    ga_client_id: parseGaClientId(readCookie(cookies, '_ga')),
    ga_session_id: parseGaSessionId(readGaSessionCookie(cookies)),
    // Google Ads click ids: the Google tag's first-party cookies survive navigation
    // (the URL param is only present on the landing page), so prefer the cookie and
    // fall back to the URL for a same-page checkout.
    gclid: parseGclCookie(readCookie(cookies, '_gcl_aw')) ?? sanitizeGoogleClickId(params.get('gclid')),
    gbraid: parseGclCookie(readCookie(cookies, '_gcl_gb')) ?? sanitizeGoogleClickId(params.get('gbraid')),
    wbraid: sanitizeGoogleClickId(params.get('wbraid')),
  };
}
