/**
 * Meta (Facebook / Instagram) catalogue feed — ceramics on sale right now.
 *
 * Served by `/api/feed/meta-ceramics` for a scheduled Commerce Manager data
 * source. It carries ONLY pieces a visitor can buy at fetch time (public, in
 * the active drop, not sold, not reserved, not in the showroom). Every piece is
 * one-of-a-kind, so the feed shrinks as pieces sell: with a scheduled
 * "replace" fetch Meta drops a sold piece from the catalogue at the next fetch.
 * Fetch hourly — between fetches a just-sold piece can still be advertised (the
 * PDP then shows it as sold), which is the accepted cost of catalogue ads for
 * unique items (owner decision 2026-11-25; it reverses the 2026-09-21
 * "no ceramics in feeds" call recorded in git history of src/lib/feed.ts).
 *
 * Meta-specific choices:
 * - `g:id` is the bare product id (`k01`) — the same value the Pixel and CAPI
 *   send as `content_ids` (src/lib/analytics.ts), so dynamic / Advantage+
 *   catalogue ads and retargeting match views and carts to catalogue rows.
 * - Images are the square JPEGs under `/uploads/feed/` (Meta rejects WebP);
 *   generate them with `node scripts/optimize-images.mjs --feed-jpeg`.
 * - The link pins `?currency=` so the landing page shows the feed's price
 *   whatever currency cookie the visitor arrives with.
 * - Custom labels expose family, price band, drop and the 1/1 status for
 *   product sets.
 *
 * Fails closed: when availability or the catalogue cannot be read, the route
 * answers 503 instead of an empty feed — a 200 with zero items would make Meta
 * delete the whole catalogue.
 */
import { CATEGORIES, getProducts, isProductListed, isProductPublic, isProductPurchasable, productDisplayName } from './products';
import { getCeramicSaleState, mergeCeramicSaleState } from './ceramic-sale-state';
import { fallbackProductNotes, getProductNotes, LOCALE_MESSAGES } from './cms/messages';
import { priceOfCurrency } from './pricing';
import { absoluteUrl } from './seo/urls';
import { PRODUCT_BRAND_NAME, SITE_NAME, SITE_URL } from './site';
import type { Currency } from './currency';
import type { CategorySlug, Product } from './types';
import type { Locale } from '@/i18n/routing';

export const META_FEED_LOCALES = ['pl', 'en', 'es', 'de'] as const satisfies readonly Locale[];
export type MetaFeedLocale = (typeof META_FEED_LOCALES)[number];
export type MetaFeedCurrency = Extract<Currency, 'pln' | 'eur' | 'gbp'>;

/** Public directory of the feed JPEGs — keep in sync with FEED_OUT_DIR in scripts/optimize-images.mjs. */
export const FEED_IMAGE_DIR = '/uploads/feed';

/** Raised when availability cannot be verified; the route maps it to 503. */
export class MetaFeedUnavailableError extends Error {
  constructor(reason: string) {
    super(`meta_feed_unavailable: ${reason}`);
    this.name = 'MetaFeedUnavailableError';
  }
}

/**
 * Locale ⇄ currency pairs the storefront can actually sell in: Polish prices in
 * PLN only; every other locale in EUR (default) or GBP. Returns null for a pair
 * the landing page would contradict.
 */
export function resolveMetaFeedCurrency(locale: MetaFeedLocale, requested: string | null): MetaFeedCurrency | null {
  if (locale === 'pl') return requested === null || requested === 'pln' ? 'pln' : null;
  if (requested === null) return 'eur';
  return requested === 'eur' || requested === 'gbp' ? requested : null;
}

const CURRENCY_CODE: Record<MetaFeedCurrency, string> = { pln: 'PLN', eur: 'EUR', gbp: 'GBP' };

/**
 * Google product taxonomy ids (Meta accepts them in `google_product_category`).
 * Verified against taxonomy-with-ids.en-US.txt on 2026-11-25:
 * 2169 Drinkware > Mugs · 602 Decor > Vases · 3553 Dinnerware > Plates ·
 * 3498 Dinnerware > Bowls.
 */
const GOOGLE_CATEGORY: Record<CategorySlug, string> = {
  kubki: '2169',
  wazony: '602',
  'wazony-srednie': '602',
  'wazony-duze': '602',
  talerzyki: '3553',
  'talerze-male': '3553',
  'talerze-srednie': '3553',
  'talerze-duze': '3553',
  'talerze-owalne': '3553',
  'duze-michy': '3498',
  'miski-falowane': '3498',
};

/** Feed-only copy (titles/descriptions Meta shows in catalogue ads). */
const FEED_COPY: Record<MetaFeedLocale, {
  titleSuffix: string;
  material: string;
  productTypeRoot: string;
  size: string;
  unique: string;
}> = {
  pl: {
    titleSuffix: 'ręcznie malowana ceramika, unikat',
    material: 'Ceramika',
    productTypeRoot: 'Ceramika',
    size: 'Wymiary',
    unique: 'Ręcznie malowana przez Annę Ciok. Każda praca istnieje tylko w jednym egzemplarzu.',
  },
  en: {
    titleSuffix: 'hand-painted ceramic, one of a kind',
    material: 'Ceramic',
    productTypeRoot: 'Ceramics',
    size: 'Size',
    unique: 'Hand-painted by Anna Ciok. Every piece is one of a kind.',
  },
  es: {
    titleSuffix: 'cerámica pintada a mano, pieza única',
    material: 'Cerámica',
    productTypeRoot: 'Cerámica',
    size: 'Medidas',
    unique: 'Pintada a mano por Anna Ciok. Cada pieza es única.',
  },
  de: {
    titleSuffix: 'handbemalte Keramik, Unikat',
    material: 'Keramik',
    productTypeRoot: 'Keramik',
    size: 'Maße',
    unique: 'Handbemalt von Anna Ciok. Jedes Stück ist ein Unikat.',
  },
};

/** Meta caps `title` at 200 characters; keep well inside it. */
const TITLE_MAX = 150;
/** Meta caps `description` at 9999 characters. */
const DESCRIPTION_MAX = 5000;

/** Price band in PLN — stable across currencies so product sets don't fork per market. */
export function priceBand(pricePln: number): string {
  if (pricePln < 200) return 'price_under_200_pln';
  if (pricePln < 400) return 'price_200_399_pln';
  if (pricePln < 700) return 'price_400_699_pln';
  return 'price_700_plus_pln';
}

/** The Meta-compatible JPEG for a product WebP, or null when the image is not a local upload. */
export function feedImageUrl(image: string): string | null {
  const match = /^\/uploads\/([^/]+)\.webp$/.exec(image);
  return match ? `${SITE_URL}${FEED_IMAGE_DIR}/${match[1]}.jpg` : null;
}

export type MetaFeedItem = {
  id: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  additionalImageLinks: string[];
  price: string;
  googleProductCategory: string;
  productType: string;
  material: string;
  customLabels: [string, string, string, string];
};

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

export function buildMetaFeedItem(
  product: Product,
  locale: MetaFeedLocale,
  currency: MetaFeedCurrency,
  note: string,
): MetaFeedItem | null {
  const imageLink = feedImageUrl(product.image);
  // Meta rejects an item without a fetchable JPEG/PNG — leave it out rather
  // than ship a row that fails ingestion.
  if (!imageLink) return null;

  const msg = LOCALE_MESSAGES[locale];
  const copy = FEED_COPY[locale];
  const category = CATEGORIES[product.category];
  const singular = (msg.product as Record<string, string>)[category.singularKey] ?? product.category;
  const [ns, key] = category.nameKey.split('.');
  const familyName = (msg as unknown as Record<string, Record<string, string> | undefined>)[ns]?.[key] ?? singular;
  const name = productDisplayName(product, singular);

  const body = (product.description ?? note).trim();
  const description = [body, `${copy.size}: ${product.measure}.`, copy.unique].filter(Boolean).join('\n\n');

  const link = new URL(absoluteUrl(locale, `/${product.category}/${product.id}`));
  link.searchParams.set('currency', currency);

  const additionalImageLinks = (product.gallery ?? [])
    .map(feedImageUrl)
    .filter((url): url is string => url !== null)
    .slice(0, 20);

  return {
    id: product.id,
    title: clip(`${name} – ${copy.titleSuffix}`, TITLE_MAX),
    description: description.length <= DESCRIPTION_MAX ? description : clip(description, DESCRIPTION_MAX),
    link: link.toString(),
    imageLink,
    additionalImageLinks,
    price: `${priceOfCurrency(product, currency).toFixed(2)} ${CURRENCY_CODE[currency]}`,
    googleProductCategory: GOOGLE_CATEGORY[product.category],
    productType: `${copy.productTypeRoot} > ${familyName}`,
    material: copy.material,
    customLabels: [product.category, priceBand(product.price), product.dropId, 'one_of_a_kind'],
  };
}

/** Pieces a visitor can buy at this moment. Throws MetaFeedUnavailableError when that can't be known. */
export async function getPurchasableCeramics(): Promise<Product[]> {
  const [catalogue, state] = await Promise.all([getProducts(), getCeramicSaleState()]);
  if (state.failed) throw new MetaFeedUnavailableError('sale_state');
  const publicProducts = mergeCeramicSaleState(catalogue.filter(isProductPublic), state).filter(isProductPublic);
  // The showroom archive keeps public pieces even when the shop is sold out,
  // so an empty public set means the cold-fail-closed catalogue was served.
  if (publicProducts.length === 0) throw new MetaFeedUnavailableError('catalogue');
  return publicProducts.filter((p) => isProductListed(p) && isProductPurchasable(p));
}

async function notesFor(slugs: CategorySlug[], locale: MetaFeedLocale): Promise<Map<CategorySlug, Record<string, string>>> {
  const entries = await Promise.all(
    slugs.map(async (slug) => {
      const notes = await getProductNotes(slug, locale).catch(() => fallbackProductNotes(slug, locale));
      return [slug, notes] as const;
    }),
  );
  return new Map(entries);
}

export async function buildMetaFeedItems(locale: MetaFeedLocale, currency: MetaFeedCurrency): Promise<MetaFeedItem[]> {
  const products = await getPurchasableCeramics();
  const notes = await notesFor([...new Set(products.map((p) => p.category))], locale);
  return products
    .map((p) => buildMetaFeedItem(p, locale, currency, notes.get(p.category)?.[p.id] ?? ''))
    .filter((item): item is MetaFeedItem => item !== null);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function tag(name: string, value: string): string {
  return `    <g:${name}>${escapeXml(value)}</g:${name}>`;
}

function itemXml(item: MetaFeedItem): string {
  return [
    '  <item>',
    tag('id', item.id),
    tag('title', item.title),
    tag('description', item.description),
    tag('link', item.link),
    tag('image_link', item.imageLink),
    ...item.additionalImageLinks.map((url) => tag('additional_image_link', url)),
    tag('availability', 'in stock'),
    tag('condition', 'new'),
    tag('price', item.price),
    tag('brand', PRODUCT_BRAND_NAME),
    tag('identifier_exists', 'no'),
    tag('google_product_category', item.googleProductCategory),
    tag('product_type', item.productType),
    tag('material', item.material),
    ...item.customLabels.map((label, i) => tag(`custom_label_${i}`, label)),
    '  </item>',
  ].join('\n');
}

export function buildMetaFeedXml(items: MetaFeedItem[], locale: MetaFeedLocale): string {
  const description = (LOCALE_MESSAGES[locale].meta as { description?: string }).description ?? '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">
<channel>
  <title>${escapeXml(SITE_NAME)}</title>
  <link>${SITE_URL}</link>
  <description>${escapeXml(description)}</description>
${items.map(itemXml).join('\n')}
</channel>
</rss>
`;
}
