/**
 * Former fine-art-print URLs → the new print shop (PRINT_SHOP_URL, Shopify).
 *
 * Prints stopped selling on this storefront in 2026-11 and moved, design for
 * design, to a separate Shopify store. Every print URL this site ever served
 * (PDPs, the `/fine-art-prints` index, the `/kolekcje` hub and its collection
 * pages) answers a 301 to the matching page there, so backlinks, bookmarks and
 * search equity follow the products instead of hitting a 404.
 *
 * `PRINT_HANDLES` is generated from `docs/shopify/shopify-url-redirects.csv`
 * (the redirect map produced alongside the Shopify product import) — it is
 * frozen: prints are no longer added here, so it never needs regenerating.
 * An id missing from it (e.g. the archived fap029/fap037) and every collection
 * page go to the shop's all-products listing — the same products under the
 * same brand, which is a relevant destination, not a bulk redirect to home.
 */
import { routing } from '../i18n/routing';
import { printShopUrl } from './site';

export const PRINT_HANDLES: Readonly<Record<string, string>> = {
  fap001: 'ostrea-01-fine-art-print',
  fap002: 'ostrea-02-fine-art-print',
  fap003: 'ostrea-03-fine-art-print',
  fap004: 'signs-01-fine-art-print',
  fap005: 'signs-02-fine-art-print',
  fap006: 'ostrea-04-fine-art-print',
  fap007: 'ostrea-05-fine-art-print',
  fap008: 'ciala-01-fine-art-print',
  fap009: 'verticles-01-fine-art-print',
  fap010: 'gestures-01-fine-art-print',
  fap011: 'gestures-05-fine-art-print',
  fap012: 'gestures-02-fine-art-print',
  fap013: 'verticles-02-fine-art-print',
  fap014: 'gestures-03-fine-art-print',
  fap015: 'gestures-08-fine-art-print',
  fap016: 'gestures-04-fine-art-print',
  fap017: 'verticles-03-fine-art-print',
  fap018: 'linea-01-fine-art-print',
  fap019: 'linea-06-fine-art-print',
  fap020: 'linea-07-fine-art-print',
  fap021: 'linea-08-fine-art-print',
  fap022: 'verticles-04-fine-art-print',
  fap023: 'horizons-01-fine-art-print',
  fap024: 'portals-01-fine-art-print',
  fap025: 'balance-02-fine-art-print',
  fap026: 'horizons-02-fine-art-print',
  fap027: 'portals-02-fine-art-print',
  fap028: 'balance-01-fine-art-print',
  fap030: 'portals-03-fine-art-print',
  fap031: 'portals-04-fine-art-print',
  fap032: 'portals-05-fine-art-print',
  fap033: 'ciala-02-fine-art-print',
  fap034: 'linea-09-fine-art-print',
  fap035: 'linea-05-fine-art-print',
  fap036: 'linea-02-fine-art-print',
  fap038: 'gestures-06-fine-art-print',
  fap039: 'gestures-07-fine-art-print',
  fap040: 'linea-04-fine-art-print',
  fap041: 'linea-03-fine-art-print',
  fap042: 'aurora-01-fine-art-print',
  fap043: 'aurora-02-fine-art-print',
  fap044: 'aurora-04-fine-art-print',
  fap045: 'cirrus-01-fine-art-print',
  fap046: 'cumulonimbus-03-fine-art-print',
  fap047: 'cumulonimbus-06-fine-art-print',
  fap048: 'cumulus-01-fine-art-print',
  fap049: 'cumulus-06-fine-art-print',
  fap050: 'obsidian-02-fine-art-print',
  fap051: 'obsidian-03-fine-art-print',
  fap052: 'obsidian-04-fine-art-print',
  fap053: 'obsidian-05-fine-art-print',
  fap054: 'scopulus-02-fine-art-print',
  fap055: 'unda-04-fine-art-print',
  fap056: 'unda-05-fine-art-print',
  fap057: 'tachylite-03-fine-art-print',
  fap058: 'cumulus-02-fine-art-print',
};

/** The shop's listing of every print — target for non-product print URLs. */
const ALL_PRINTS_PATH = '/collections/all';

const LOCALES = routing.locales.join('|');
// `/{locale?}/fine-art-prints[/{id}]` and `/{locale?}/kolekcje[/{slug}]`, with
// an optional trailing slash. `pl` is matched too: next-intl's as-needed
// prefix redirect would otherwise bounce `/pl/...` once before we see it.
const PRINT_PATH_RE = new RegExp(
  `^(?:/(${LOCALES}))?/(fine-art-prints|kolekcje)(?:/([^/]+))?/?$`,
);

/**
 * Absolute URL in the print shop for a former print path, or `null` when the
 * path is not a print URL. Locale is carried over (default `pl` when the path
 * is unprefixed, matching this site's as-needed routing).
 */
export function printShopRedirectTarget(pathname: string): string | null {
  const m = pathname.match(PRINT_PATH_RE);
  if (!m) return null;
  const [, locale = routing.defaultLocale, section, id] = m;
  if (section === 'fine-art-prints' && id) {
    const key = id.toLowerCase();
    const handle = Object.hasOwn(PRINT_HANDLES, key) ? PRINT_HANDLES[key] : undefined;
    if (handle) return printShopUrl(locale, `/products/${handle}`);
  }
  return printShopUrl(locale, ALL_PRINTS_PATH);
}
