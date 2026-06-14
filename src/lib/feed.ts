import { getProducts, CATEGORIES } from './products';
import { priceOf } from './pricing';
import { absoluteUrl } from './seo/urls';
import { SITE_URL, SITE_NAME } from './site';
import type { CategorySlug } from './types';
import type { Locale } from '@/i18n/routing';

import plMessages from '../../messages/pl.json';
import enMessages from '../../messages/en.json';
import esMessages from '../../messages/es.json';
import deMessages from '../../messages/de.json';
import gbMessages from '../../messages/gb.json';

export type FeedLocale = Locale;

export const FEED_LOCALES: FeedLocale[] = ['pl', 'en', 'es', 'de', 'gb'];

type Messages = typeof enMessages;

const LOCALE_MESSAGES: Record<FeedLocale, Messages> = {
  pl: plMessages as unknown as Messages,
  en: enMessages,
  es: esMessages as unknown as Messages,
  de: deMessages as unknown as Messages,
  gb: gbMessages as unknown as Messages,
};

function currency(locale: FeedLocale): string {
  if (locale === 'pl') return 'PLN';
  if (locale === 'gb') return 'GBP';
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
};

export function buildFeedItems(locale: FeedLocale, soldIds: Set<string>): FeedItem[] {
  const msg = LOCALE_MESSAGES[locale];
  const cur = currency(locale);
  const products = getProducts();

  return products.map((product) => {
    const cat = CATEGORIES[product.category];
    const singularName = (msg.product as Record<string, string>)[cat.singularKey] ?? cat.singularKey;
    const title = `${singularName} #${product.num}`;

    const notesForCategory = (msg.notes as Record<string, string[]>)[product.category] ?? [];
    const description = notesForCategory[product.noteIndex] ?? title;

    const path = `/${product.category}/${product.id}`;
    const link = absoluteUrl(locale, path);

    const imageLink = `${SITE_URL}${product.image}`;
    const additionalImages = (product.gallery ?? []).map((g) => `${SITE_URL}${g}`);

    const price = priceOf(product, locale);
    const priceStr = `${price}.00 ${cur}`;

    return {
      id: product.id,
      title,
      description,
      link,
      imageLink,
      additionalImages,
      availability: soldIds.has(product.id) ? 'out of stock' : 'in stock',
      price: priceStr,
      category: product.category,
    };
  });
}

function itemToGoogleXml(item: FeedItem): string {
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
    <g:brand>Anna Ciok</g:brand>
    <g:condition>new</g:condition>
    <g:identifier_exists>no</g:identifier_exists>
    <g:google_product_category>${GOOGLE_CATEGORY[item.category]}</g:google_product_category>
    <g:product_type>Ceramics &gt; ${escapeXml(item.title.split(' #')[0])}</g:product_type>${additionalImages ? '\n' + additionalImages : ''}
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
    <g:brand>Anna Ciok</g:brand>
    <g:condition>new</g:condition>
    <g:google_product_category>${GOOGLE_CATEGORY[item.category]}</g:google_product_category>${additionalImages ? '\n' + additionalImages : ''}
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
