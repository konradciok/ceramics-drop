import { parseGaClientId, parseGaSessionId } from './context';

export type MarketingCookies = {
  fbp: string | null;
  fbc: string | null;
  ga_client_id: string | null;
  ga_session_id: string | null;
};

function readCookie(cookieString: string, name: string): string | null {
  const match = cookieString.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function readGaSessionCookie(cookieString: string): string | null {
  // The _ga_<streamId> name carries a per-stream suffix we don't know at build time.
  const match = cookieString.match(/(?:^|;\s*)_ga_[A-Z0-9]+=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
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
  return {
    fbp: readCookie(cookies, '_fbp'),
    fbc,
    ga_client_id: parseGaClientId(readCookie(cookies, '_ga')),
    ga_session_id: parseGaSessionId(readGaSessionCookie(cookies)),
  };
}
