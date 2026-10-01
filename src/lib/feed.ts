/**
 * Merchant feeds — fine-art prints only.
 *
 * Both the Google Shopping and the Meta Catalog feed carry the print-on-demand
 * catalogue and nothing else. Ceramics are deliberately excluded: every piece
 * is one-of-a-kind, so a piece sold at 10:00 keeps being advertised until the
 * merchant platform's next scheduled fetch (daily at best) — an availability
 * mismatch and wasted ad spend by construction, not a bug we could tune away.
 * Prints are print-on-demand: unlimited, always in stock, and the only part of
 * the catalogue a merchant feed can describe truthfully between fetches.
 *
 * Consequence for analytics: ceramic `content_ids` / `item_id` values still
 * emitted by the pixel + CAPI (`src/lib/analytics.ts`) no longer resolve to a
 * catalogue row. Decided by the studio owner on 2026-09-21 and accepted: the
 * studio does not run Meta catalogue / dynamic product ads for ceramics, and
 * those are the only surfaces that need a catalogue match. Ceramic events keep
 * carrying `value` + `currency`, so conversion reporting and value-based
 * audiences are unaffected; the visible cost is unmatched-`content_ids`
 * warnings in Meta Events Manager. Reopen this only if catalogue-backed ads
 * for ceramics are ever wanted — that is a feed decision, not an analytics one.
 */
import { printDisplayName } from '@/lib/print-curation';
import { getPrintDesigns } from './prints';
import { loadPrintCollectionDefinitions } from './print-collections';
import { fromPriceOf } from './print-pricing';
import { getPrintPricingConfig } from './print-pricing-config/get';
import { PRINT_COUNTRIES, printShippingOf, type PrintCountry } from './print-shipping';
import { absoluteUrl } from './seo/urls';
import { SITE_URL, SITE_NAME, PRODUCT_BRAND_NAME } from './site';
import type { CategorySlug } from './types';
import type { Locale } from '@/i18n/routing';

import plMessages from '../../messages/pl.json';
import enMessages from '../../messages/en.json';
import esMessages from '../../messages/es.json';
import deMessages from '../../messages/de.json';

export type FeedLocale = Locale;

export const FEED_LOCALES: FeedLocale[] = ['pl', 'en', 'es', 'de'];

type Messages = typeof enMessages;

const LOCALE_MESSAGES: Record<FeedLocale, Messages> = {
  pl: plMessages as unknown as Messages,
  en: enMessages,
  es: esMessages as unknown as Messages,
  de: deMessages as unknown as Messages,
};

type FeedCurrency = 'pln' | 'eur' | 'gbp';

type GoogleFeedMarket = {
  locale: FeedLocale;
  currency: FeedCurrency;
  currencyCode: 'PLN' | 'EUR' | 'GBP';
  countries: readonly PrintCountry[];
};

/** Every EU member served by the print checkout, deliberately excluding the
 * separately priced PL market and non-EU GB market. Keep this derived from the
 * checkout country allow-list so a feed can never advertise an unsupported
 * destination. */
export const EU_PRINT_COUNTRIES = PRINT_COUNTRIES.filter(
  (country): country is Exclude<PrintCountry, 'PL' | 'GB'> => country !== 'PL' && country !== 'GB',
);

/**
 * Merchant markets, not UI locales. A market is the contract Google sees:
 * language/landing page, offer currency and every country with product-level
 * shipping. Do not add a country here unless checkout can complete an order to
 * it in the same currency.
 */
export const GOOGLE_FEED_MARKETS = {
  pl: { locale: 'pl', currency: 'pln', currencyCode: 'PLN', countries: ['PL'] },
  gb: { locale: 'en', currency: 'gbp', currencyCode: 'GBP', countries: ['GB'] },
  eu: { locale: 'en', currency: 'eur', currencyCode: 'EUR', countries: EU_PRINT_COUNTRIES },
} as const satisfies Record<string, GoogleFeedMarket>;

export type GoogleFeedMarketId = keyof typeof GOOGLE_FEED_MARKETS;

export function isGoogleFeedMarketId(value: string | null): value is GoogleFeedMarketId {
  return value !== null && Object.hasOwn(GOOGLE_FEED_MARKETS, value);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The one category a merchant feed row can carry. `satisfies` keeps it honest
 *  against `CategorySlug` if the slug is ever renamed. */
const FEED_CATEGORY = 'fine-art-prints' satisfies CategorySlug;

/**
 * `google_product_category` as Google's numeric taxonomy ID:
 * 500044 = Home & Garden > Decor > Artwork > Posters, Prints, & Visual Artwork.
 *
 * Google accepts either the numeric ID or the full path string, one per item,
 * never both. The ID is the safer of the two here: it survives Google rewording
 * a taxonomy node, and it carries no `&`/`>` so it needs no XML escaping — the
 * path form had to be stored pre-escaped and inserted raw, which is one edit
 * away from emitting a broken document.
 *
 * Do not restore the previous value, `Arts & Entertainment > Fine Art > Prints`:
 * that was never a node in Google's taxonomy (there is no `Fine Art` branch
 * under `Arts & Entertainment`), so Merchant Center rejected it outright.
 */
const GOOGLE_CATEGORY = '500044';

const PRICE_TIER = 'standard';
const PRODUCT_FAMILY = 'prints';

// Legacy representative destinations for on-page structured data. Google feed
// destinations are now defined by GOOGLE_FEED_MARKETS above, never by locale.
export const SHIPPING_COUNTRY: Record<FeedLocale, string> = {
  pl: 'PL',
  en: 'GB',
  es: 'ES',
  de: 'DE',
};

export type FeedItem = {
  id: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  additionalImages: string[];
  availability: 'in stock' | 'out of stock';
  price: string;
  category: typeof FEED_CATEGORY;
  material: string;
  productType: string;
  customLabel0: string;
  customLabel1: string;
  customLabel2: string;
  shipping: Array<{ country: string; service: string; price: string }>;
};

/**
 * Merchant-feed rows for published fine-art prints — the whole feed. One row
 * per design per locale, id = design id (fap0x) so it matches the fap0x
 * content_ids/item_ids the print pixel + CAPI emit (see
 * buildPrintAddToCartEvent). Prints are print-on-demand: always in stock,
 * priced from the cheapest sellable variant, shipped to a home address
 * (Prodigi) — never a locker.
 *
 * Print descriptions come from the static i18n notes, not the CMS: there is no
 * per-print CMS note document today (the `page:print-pdp` document carries
 * shared accordion copy, not per-design text). Wire a CMS resolver in here only
 * once editors actually draft per-design descriptions.
 */
async function buildItems(locale: FeedLocale, market: Pick<GoogleFeedMarket, 'currency' | 'currencyCode' | 'countries'>): Promise<FeedItem[]> {
  const msg = LOCALE_MESSAGES[locale];
  const { currency: chargeable, currencyCode: cur, countries } = market;
  const singular = (msg.product as Record<string, string>).print ?? 'Print';
  // Three independent catalogue reads — under CATALOG_SOURCE=db each is a real
  // Supabase round trip, so issue them together rather than in sequence.
  const [designs, pricing, definitions] = await Promise.all([
    getPrintDesigns(), // published only, CATALOG_SOURCE-aware
    getPrintPricingConfig(), // global price list, CATALOG_SOURCE-aware
    loadPrintCollectionDefinitions(),
  ]);

  return designs.map((design) => {
    const title = printDisplayName(design, singular, definitions);
    const notes = (msg.notes as Record<string, string[]>)[FEED_CATEGORY];
    const description = notes?.[design.noteIndex] ?? title;

    // The query is consumed by middleware before rendering, overriding an old
    // visitor cookie. A Google crawl therefore sees the same currency as the
    // feed even when it has no cookie or arrives from a different country.
    const linkUrl = new URL(absoluteUrl(locale, `/fine-art-prints/${design.id}`));
    linkUrl.searchParams.set('currency', chargeable);
    const link = linkUrl.toString();
    const imageLink = `${SITE_URL}${design.image}`;
    const additionalImages = (design.gallery ?? []).map((g) => `${SITE_URL}${g}`);

    const price = fromPriceOf(design, chargeable, pricing);
    // Loose (unframed) rate pairs with the unframed "from" price above. Pass
    // `pricing` through so shipping converts at the same admin-set FX rate
    // the item price above uses, instead of print-shipping.ts's hardcoded
    // fallback constants.
    const shipping = countries.map((country) => ({
      country,
      service: 'Prodigi',
      price: `${printShippingOf(country, false, chargeable, pricing)}.00 ${cur}`,
    }));

    return {
      id: design.id,
      title,
      description,
      link,
      imageLink,
      additionalImages,
      availability: 'in stock' as const,
      price: `${price}.00 ${cur}`,
      category: FEED_CATEGORY,
      material: 'Fine Art Print',
      productType: `Prints > ${singular}`,
      customLabel0: PRICE_TIER,
      customLabel1: PRODUCT_FAMILY,
      customLabel2: FEED_CATEGORY,
      shipping,
    };
  });
}

/** Build the product data used by Google Merchant Center. */
export async function buildGoogleFeedItems(marketId: GoogleFeedMarketId): Promise<FeedItem[]> {
  const market = GOOGLE_FEED_MARKETS[marketId];
  return buildItems(market.locale, market);
}

/**
 * Meta's existing locale feeds keep their locale-specific catalogue language.
 * They don't serialize the Google-only shipping element, but retain a valid
 * product price/link pair. Google must use buildGoogleFeedItems instead.
 */
export async function buildFeedItems(locale: FeedLocale): Promise<FeedItem[]> {
  const currency: FeedCurrency = locale === 'pl' ? 'pln' : locale === 'en' ? 'gbp' : 'eur';
  const currencyCode = currency === 'pln' ? 'PLN' : currency === 'gbp' ? 'GBP' : 'EUR';
  return buildItems(locale, {
    currency,
    currencyCode,
    countries: [SHIPPING_COUNTRY[locale] as PrintCountry],
  });
}

function itemToGoogleXml(item: FeedItem): string {
  const additionalImages = item.additionalImages
    .map((url) => `    <g:additional_image_link>${escapeXml(url)}</g:additional_image_link>`)
    .join('\n');

  const shippingXml = item.shipping
    .map(
      (s) =>
        `    <g:shipping>\n      <g:country>${s.country}</g:country>\n      <g:service>${escapeXml(s.service)}</g:service>\n      <g:price>${escapeXml(s.price)}</g:price>\n    </g:shipping>`,
    )
    .join('\n');

  return `  <item>
    <g:id>${escapeXml(item.id)}</g:id>
    <g:title>${escapeXml(item.title)}</g:title>
    <g:description>${escapeXml(item.description)}</g:description>
    <g:link>${escapeXml(item.link)}</g:link>
    <g:image_link>${escapeXml(item.imageLink)}</g:image_link>
    <g:availability>${item.availability}</g:availability>
    <g:price>${escapeXml(item.price)}</g:price>
    <g:brand>${escapeXml(PRODUCT_BRAND_NAME)}</g:brand>
    <g:condition>new</g:condition>
    <g:identifier_exists>no</g:identifier_exists>
    <g:material>${escapeXml(item.material)}</g:material>
    <g:google_product_category>${GOOGLE_CATEGORY}</g:google_product_category>
    <g:product_type>${escapeXml(item.productType)}</g:product_type>
    <g:custom_label_0>${escapeXml(item.customLabel0)}</g:custom_label_0>
    <g:custom_label_1>${escapeXml(item.customLabel1)}</g:custom_label_1>
    <g:custom_label_2>${escapeXml(item.customLabel2)}</g:custom_label_2>
${shippingXml}${additionalImages ? '\n' + additionalImages : ''}
  </item>`;
}

function itemToMetaXml(item: FeedItem): string {
  const additionalImages = item.additionalImages
    .map((url) => `    <g:additional_image_link>${escapeXml(url)}</g:additional_image_link>`)
    .join('\n');

  return `  <item>
    <g:id>${escapeXml(item.id)}</g:id>
    <g:title>${escapeXml(item.title)}</g:title>
    <g:description>${escapeXml(item.description)}</g:description>
    <g:link>${escapeXml(item.link)}</g:link>
    <g:image_link>${escapeXml(item.imageLink)}</g:image_link>
    <g:availability>${item.availability}</g:availability>
    <g:price>${escapeXml(item.price)}</g:price>
    <g:brand>${escapeXml(PRODUCT_BRAND_NAME)}</g:brand>
    <g:condition>new</g:condition>
    <g:identifier_exists>no</g:identifier_exists>
    <g:material>${escapeXml(item.material)}</g:material>
    <g:google_product_category>${GOOGLE_CATEGORY}</g:google_product_category>
    <g:product_type>${escapeXml(item.productType)}</g:product_type>
    <g:custom_label_0>${escapeXml(item.customLabel0)}</g:custom_label_0>
    <g:custom_label_1>${escapeXml(item.customLabel1)}</g:custom_label_1>
    <g:custom_label_2>${escapeXml(item.customLabel2)}</g:custom_label_2>${additionalImages ? '\n' + additionalImages : ''}
  </item>`;
}

function channelHeader(locale: FeedLocale): string {
  const msg = LOCALE_MESSAGES[locale];
  const description = (msg.meta as { description?: string }).description ?? '';
  return `  <title>${escapeXml(SITE_NAME)}</title>
  <link>${SITE_URL}</link>
  <description>${escapeXml(description)}</description>`;
}

export function buildGoogleXml(items: FeedItem[], locale: FeedLocale): string {
  const itemsXml = items.map(itemToGoogleXml).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
<channel>
${channelHeader(locale)}
${itemsXml}
</channel>
</rss>`;
}

export function buildMetaXml(items: FeedItem[], locale: FeedLocale): string {
  const itemsXml = items.map(itemToMetaXml).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
<channel>
${channelHeader(locale)}
${itemsXml}
</channel>
</rss>`;
}
