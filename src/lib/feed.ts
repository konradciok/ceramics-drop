import { getPublicProducts, CATEGORIES } from './products';
import { getPrintDesigns } from './prints';
import { priceOf, SHIPPING_PLN, SHIPPING_EUR } from './pricing';
import { fromPriceOf } from './print-pricing';
import { printShippingOf, type PrintCountry } from './print-shipping';
import { absoluteUrl } from './seo/urls';
import { SITE_URL, SITE_NAME, PRODUCT_BRAND_NAME } from './site';
import { getProductNotes } from './cms/messages';
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

function currency(locale: FeedLocale): string {
  if (locale === 'pl') return 'PLN';
  return 'EUR';
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const PRICE_TIER: Record<CategorySlug, string> = {
  talerzyki: 'budget',
  kubki: 'standard',
  'talerze-srednie': 'standard',
  'talerze-duze': 'standard',
  'miski-falowane': 'standard',
  wazony: 'premium',
  'wazony-srednie': 'premium',
  'wazony-duze': 'premium',
  'duze-michy': 'premium',
  'fine-art-prints': 'standard', // fine-art prints — merchant feed row (see buildPrintFeedItems)
};

const PRODUCT_FAMILY: Record<CategorySlug, string> = {
  kubki: 'tableware',
  talerzyki: 'tableware',
  'talerze-srednie': 'tableware',
  'talerze-duze': 'tableware',
  wazony: 'vessels',
  'wazony-srednie': 'vessels',
  'wazony-duze': 'vessels',
  'duze-michy': 'bowls',
  'miski-falowane': 'bowls',
  'fine-art-prints': 'prints', // fine-art prints — merchant feed row (see buildPrintFeedItems)
};

// Exported so structured-data.ts can reuse the same per-locale shipping
// destination for `Offer.shippingDetails` — keep the feed and on-page schema
// in agreement on where each locale's Offer is quoted for.
export const SHIPPING_COUNTRY: Record<FeedLocale, string> = {
  pl: 'PL',
  en: 'IE',
  es: 'ES',
  de: 'DE',
};

// Values are already-escaped XML entities (& → &amp;, > → &gt;) — insert directly without re-escaping.
const GOOGLE_CATEGORY: Record<CategorySlug, string> = {
  kubki: 'Home &amp; Garden &gt; Kitchen &amp; Dining &gt; Tableware &gt; Cups &amp; Mugs',
  wazony: 'Home &amp; Garden &gt; Decor &gt; Vases',
  'wazony-srednie': 'Home &amp; Garden &gt; Decor &gt; Vases',
  'wazony-duze': 'Home &amp; Garden &gt; Decor &gt; Vases',
  talerzyki: 'Home &amp; Garden &gt; Kitchen &amp; Dining &gt; Tableware &gt; Plates',
  'talerze-srednie': 'Home &amp; Garden &gt; Kitchen &amp; Dining &gt; Tableware &gt; Plates',
  'talerze-duze': 'Home &amp; Garden &gt; Kitchen &amp; Dining &gt; Tableware &gt; Plates',
  'duze-michy': 'Home &amp; Garden &gt; Kitchen &amp; Dining &gt; Tableware &gt; Bowls',
  'miski-falowane': 'Home &amp; Garden &gt; Kitchen &amp; Dining &gt; Tableware &gt; Bowls',
  'fine-art-prints': 'Arts &amp; Entertainment &gt; Fine Art &gt; Prints', // fine-art prints — merchant feed row (see buildPrintFeedItems)
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
  category: CategorySlug;
  material: string;
  productType: string;
  customLabel0: string;
  customLabel1: string;
  customLabel2: string;
  shipping: Array<{ country: string; service: string; price: string }>;
};

async function buildFeedItemsWithNotes(locale: FeedLocale, soldIds: Set<string>, showroomIds: Set<string>, notesBySlug?: Partial<Record<CategorySlug, Record<string, string>>>, prefetchedProducts?: Awaited<ReturnType<typeof getPublicProducts>>): Promise<FeedItem[]> {
  const msg = LOCALE_MESSAGES[locale];
  const cur = currency(locale);
  // The CMS builder already loaded the public catalogue (to derive the note
  // slugs), so reuse it instead of re-reading — under CATALOG_SOURCE=db the
  // accessor rebuilds catalogue maps per call, so a second read is real work.
  const products = prefetchedProducts ?? await getPublicProducts();

  return products.map((product) => {
    const cat = CATEGORIES[product.category];
    const singularName = (msg.product as Record<string, string>)[cat.singularKey] ?? cat.singularKey;
    const title = `${singularName} #${product.num}`;

    const cmsNotes = notesBySlug?.[product.category];
    const description = cmsNotes
      ? cmsNotes[product.id] ?? title
      : (msg.notes as Record<string, string[]>)[product.category]?.[product.noteIndex] ?? title;

    const path = `/${product.category}/${product.id}`;
    const link = absoluteUrl(locale, path);

    const imageLink = `${SITE_URL}${product.image}`;
    const additionalImages = (product.gallery ?? []).map((g) => `${SITE_URL}${g}`);

    const price = priceOf(product, locale);
    const priceStr = `${price}.00 ${cur}`;

    const shippingRates = locale === 'pl' ? SHIPPING_PLN : SHIPPING_EUR;
    const shippingCountry = SHIPPING_COUNTRY[locale];
    const shipping = [
      { country: shippingCountry, service: 'InPost Paczkomat', price: `${shippingRates.paczkomat}.00 ${cur}` },
      { country: shippingCountry, service: 'InPost Kurier', price: `${shippingRates.kurier}.00 ${cur}` },
    ];

    return {
      id: product.id,
      title,
      description,
      link,
      imageLink,
      additionalImages,
      // Showroom pieces are visible but not purchasable — never advertise them
      // in stock in merchant feeds (matches reserve_pieces + JSON-LD).
      availability: soldIds.has(product.id) || showroomIds.has(product.id) ? 'out of stock' : 'in stock',
      price: priceStr,
      category: product.category,
      material: 'Ceramics',
      productType: `Ceramics > ${singularName}`,
      customLabel0: PRICE_TIER[product.category],
      customLabel1: PRODUCT_FAMILY[product.category],
      customLabel2: product.category,
      shipping,
    };
  });
}

/**
 * Merchant-feed rows for published fine-art prints. One row per design per
 * locale, id = design id (fap0x) so it matches the fap0x content_ids/item_ids
 * the print pixel + CAPI emit (see buildPrintAddToCartEvent). Prints are
 * print-on-demand: always in stock, priced from the cheapest sellable variant,
 * shipped to a home address (Prodigi) — never a locker.
 */
async function buildPrintFeedItems(locale: FeedLocale): Promise<FeedItem[]> {
  const msg = LOCALE_MESSAGES[locale];
  const cur = currency(locale); // 'PLN' | 'EUR'
  const chargeable = locale === 'pl' ? 'pln' : 'eur'; // feeds never quote GBP
  const singular = (msg.product as Record<string, string>).print ?? 'Print';
  const country = SHIPPING_COUNTRY[locale] as PrintCountry;
  const designs = await getPrintDesigns(); // published only, CATALOG_SOURCE-aware

  return designs.map((design) => {
    const title = `${singular} #${design.num}`;
    const notes = (msg.notes as Record<string, string[]>)['fine-art-prints'];
    const description = notes?.[design.noteIndex] ?? title;

    const link = absoluteUrl(locale, `/fine-art-prints/${design.id}`);
    const imageLink = `${SITE_URL}${design.image}`;
    const additionalImages = (design.gallery ?? []).map((g) => `${SITE_URL}${g}`);

    const price = fromPriceOf(design, chargeable);
    // Loose (unframed) rate pairs with the unframed "from" price above.
    const shipCost = printShippingOf(country, false, chargeable);

    return {
      id: design.id,
      title,
      description,
      link,
      imageLink,
      additionalImages,
      availability: 'in stock' as const,
      price: `${price}.00 ${cur}`,
      category: 'fine-art-prints' as CategorySlug,
      material: 'Fine Art Print',
      productType: `Prints > ${singular}`,
      customLabel0: PRICE_TIER['fine-art-prints'],
      customLabel1: PRODUCT_FAMILY['fine-art-prints'],
      customLabel2: 'fine-art-prints',
      shipping: [{ country, service: 'Prodigi', price: `${shipCost}.00 ${cur}` }],
    };
  });
}

export async function buildFeedItems(locale: FeedLocale, soldIds: Set<string>, showroomIds: Set<string> = new Set()): Promise<FeedItem[]> {
  const ceramics = await buildFeedItemsWithNotes(locale, soldIds, showroomIds);
  return [...ceramics, ...(await buildPrintFeedItems(locale))];
}

// ponytail: print feed descriptions use static i18n notes; wire CMS print notes
// only if editors start drafting them.
export async function buildFeedItemsCms(locale: FeedLocale, soldIds: Set<string>, showroomIds: Set<string> = new Set()): Promise<FeedItem[]> {
  const products = await getPublicProducts();
  const slugs = [...new Set(products.map((product) => product.category))];
  const entries = await Promise.all(slugs.map(async (slug) => [slug, await getProductNotes(slug, locale)] as const));
  const ceramics = await buildFeedItemsWithNotes(locale, soldIds, showroomIds, Object.fromEntries(entries) as Partial<Record<CategorySlug, Record<string, string>>>, products);
  return [...ceramics, ...(await buildPrintFeedItems(locale))];
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
    <g:google_product_category>${GOOGLE_CATEGORY[item.category]}</g:google_product_category>
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
    <g:google_product_category>${GOOGLE_CATEGORY[item.category]}</g:google_product_category>
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
