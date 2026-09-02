/**
 * Legacy Shopify → current-storefront redirect map (P0-07 / SEO-017).
 *
 * The site migrated off Shopify before this repo's history starts, but
 * backlinks/bookmarks/social bio links still land on old Shopify-shaped URLs
 * (`/products/{handle}`, `/pages/{slug}`) that 404 today — confirmed via a
 * GA4 landing-page pull (`npm run ga4:report -- landing-pages`) at roughly ⅓
 * of total sessions, ~100% bounce rate on the dead ones.
 *
 * Keys are the legacy pathname with the locale prefix and leading slash
 * stripped (e.g. `pages/about-me` for `/en/pages/about-me`); values are the
 * new canonical path in the same shape, re-prefixed with whatever locale the
 * incoming request used (see the middleware guard that consumes this table).
 *
 * Deliberately incomplete: the fine-art-print registry was fully reset
 * 2026-08-17 (old `fap01–fap047` → new `fap001–fap041`), so there is no
 * numeric formula from a legacy product handle (`novocumulus-27-fine-art-print`,
 * `cumulus-05`, `stratus-03`, …) to today's id — each would need to be
 * matched by which painting it actually names, which only the
 * artist/store-owner can confirm. Per the audit's explicit policy, an
 * unmapped legacy URL must stay a real 404 — never bulk-redirect to home.
 * Add entries here only once a mapping is verified.
 */
export const LEGACY_REDIRECTS: Readonly<Record<string, string>> = {
  'pages/about-me': 'o-studiu',
  'pages/contact': 'kontakt',
};

/**
 * TODO (content/owner follow-up, not blocking): legacy product-handle URLs
 * seen in GA4 with real session volume that still need a verified match to a
 * current fap0xx id before they can be added to LEGACY_REDIRECTS above —
 * novocumulus-05/10/11/12/16/21/24/25/26/27/30/31/32/33/34/37/38/39/42/44/45/46,
 * cumulus-01/03/05, cumulonimbus-03, stratus-02/03, stratocumulus-01/02/05,
 * cirrus-01/02. `appointment` and `pages/workshops` have no obvious current
 * equivalent and may simply stay 404. Re-pull with
 * `npm run ga4:report -- landing-pages --days 90 --limit 300` for current
 * volumes before triaging.
 */
