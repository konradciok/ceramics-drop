import type { Graph, Organization, WithContext } from 'schema-dts';
import type { Locale } from '@/i18n/routing';
import type { CategorySlug, PrintDesign, Product } from '@/lib/types';
import { getCategory, getProductsByCategory } from '@/lib/products';
import { getPrintDesigns, isVariantAvailable } from '@/lib/prints';
import { PRICE_EUR, SHIPPING_PLN, SHIPPING_EUR } from '@/lib/pricing';
import { priceOfVariant } from '@/lib/print-pricing';
import { PRINT_FRAME_COLOURS, PRINT_SIZES } from '@/lib/print-cart';
import { SITE_NAME, SITE_URL } from '@/lib/site';
import { absoluteUrl } from '@/lib/seo/urls';
import { EMAIL } from '@/lib/email-addresses';
import { SHIPPING_COUNTRY } from '@/lib/feed';

const PRINTS_SLUG = 'fine-art-prints';

/** Matches the literal <g:brand> value in feed.ts — keep them identical so the
 *  Merchant feed and on-page schema never disagree on brand. */
const BRAND_NAME = 'Anna Ciok';

/** Matches the copy on /dostawa-i-zwroty (shipping.s5P / s5Li2 / s5Li3): 14-day
 *  right of withdrawal, buyer pays return shipping, refund within 14 days. */
const RETURN_WINDOW_DAYS = 14;

/**
 * Ceramics ship on the two InPost rates already advertised in feed.ts —
 * mirror them here (and reuse its `SHIPPING_COUNTRY`) so the Merchant feed
 * and this on-page `Offer.shippingDetails` never disagree.
 */
function shippingDetailsFor(locale: Locale) {
  const rates = locale === 'pl' ? SHIPPING_PLN : SHIPPING_EUR;
  const currency = locale === 'pl' ? 'PLN' : 'EUR';
  const addressCountry = SHIPPING_COUNTRY[locale];
  return [
    {
      '@type': 'OfferShippingDetails' as const,
      shippingRate: { '@type': 'MonetaryAmount' as const, value: rates.paczkomat, currency },
      shippingDestination: { '@type': 'DefinedRegion' as const, addressCountry },
    },
    {
      '@type': 'OfferShippingDetails' as const,
      shippingRate: { '@type': 'MonetaryAmount' as const, value: rates.kurier, currency },
      shippingDestination: { '@type': 'DefinedRegion' as const, addressCountry },
    },
  ];
}

/** Ceramics-only 14-day right-of-withdrawal return policy (see /dostawa-i-zwroty). */
function merchantReturnPolicy() {
  return {
    '@type': 'MerchantReturnPolicy' as const,
    returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow' as const,
    merchantReturnDays: RETURN_WINDOW_DAYS,
    returnMethod: 'https://schema.org/ReturnByMail' as const,
    returnFees: 'https://schema.org/ReturnShippingFees' as const,
    applicableCountry: 'PL',
  };
}

/** Prices (major units, given currency) of every sellable variant of a design. */
function sellableVariantPrices(design: PrintDesign, currency: 'pln' | 'eur' | 'gbp'): number[] {
  const prices: number[] = [];
  for (const size of PRINT_SIZES) {
    // Unframed variant
    const unframed = { size, framed: false, mount: false, frameColour: 'none' as const };
    if (isVariantAvailable(design, unframed)) prices.push(priceOfVariant(design, unframed, currency));
    // Framed variants
    for (const frameColour of PRINT_FRAME_COLOURS) {
      for (const mount of [false, true]) {
        const sel = { size, framed: true, mount, frameColour };
        if (isVariantAvailable(design, sel)) prices.push(priceOfVariant(design, sel, currency));
      }
    }
  }
  return prices;
}

/** Locale → (currency code pair) for print schemas — locale default (pl→PLN, else EUR). */
function printCurrencyFor(locale: Locale): { currency: 'pln' | 'eur'; priceCurrency: 'PLN' | 'EUR' } {
  if (locale === 'pl') return { currency: 'pln', priceCurrency: 'PLN' };
  return { currency: 'eur', priceCurrency: 'EUR' };
}

/** schema.org availability for a 1/1 piece, derived from its `sold` flag. */
function availabilityFor(sold: boolean) {
  return sold ? 'https://schema.org/SoldOut' : 'https://schema.org/InStock';
}

/**
 * Site-wide `Organization` node. Rendered once in the root layout so every page
 * carries publisher identity without per-page duplication.
 */
export function organizationSchema(): WithContext<Organization> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: SITE_URL,
    logo: `${SITE_URL}/logotype.png`,
    email: EMAIL.contact,
  };
}

type CollectionArgs = {
  slug: CategorySlug;
  locale: Locale;
  /** A next-intl translator bound to the request locale. */
  t: (key: string) => string;
  /** Raw (non-string) message accessor, used for the static `notes.<slug>` array fallback. */
  tRaw?: (key: string) => unknown;
  /**
   * Live sold piece ids (from `getSoldIds()`), so JSON-LD availability matches the
   * Supabase-backed gallery. Defaults to none sold — the static catalog flag alone
   * would otherwise always report `InStock`.
   */
  soldIds?: readonly string[];
  /** Live showroom piece ids (from `getShowroomIds()`) — never advertised InStock. */
  showroomIds?: readonly string[];
  /** CMS-resolved per-product notes (id → text) from `getProductNotes(slug, locale)`. */
  notes?: Record<string, string>;
};

/**
 * `@graph` for a collection page: a `BreadcrumbList` (Home → category) plus an
 * `ItemList` of every piece in the family as `Product` nodes with PLN offers.
 * Pieces are one-of-a-kind, so the price is the shared family price and
 * availability degrades to `SoldOut` once a piece sells.
 */
export async function collectionSchema({ slug, locale, t, tRaw, soldIds = [], showroomIds = [], notes }: CollectionArgs): Promise<Graph> {
  const category = getCategory(slug);
  const products = await getProductsByCategory(slug);
  const sold = new Set(soldIds);
  const showroom = new Set(showroomIds);
  const singular = t(`product.${category.singularKey}`);
  const categoryName = t(category.nameKey);
  const homeUrl = absoluteUrl(locale, '/');
  const collectionUrl = absoluteUrl(locale, `/${slug}`);
  const rawNotes = tRaw?.(`notes.${slug}`);

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: homeUrl },
          { '@type': 'ListItem', position: 2, name: categoryName, item: collectionUrl },
        ],
      },
      {
        '@type': 'ItemList',
        name: categoryName,
        numberOfItems: products.length,
        itemListElement: products.map((p, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: {
            '@type': 'Product',
            name: `${singular} Nº ${p.num}`,
            description: notes?.[p.id] ?? (Array.isArray(rawNotes) ? ((rawNotes[p.noteIndex] as string) ?? '') : ''),
            image: `${SITE_URL}${p.image}`,
            category: categoryName,
            brand: { '@type': 'Brand', name: BRAND_NAME },
            offers: {
              '@type': 'Offer',
              price: locale === 'pl' ? category.price : PRICE_EUR[slug],
              priceCurrency: locale === 'pl' ? 'PLN' : 'EUR',
              availability: availabilityFor(p.sold || sold.has(p.id) || showroom.has(p.id)),
              url: absoluteUrl(locale, `/${slug}/${p.id}`),
              shippingDetails: shippingDetailsFor(locale),
              hasMerchantReturnPolicy: merchantReturnPolicy(),
            },
          },
        })),
      },
    ],
  };
}

type PrintCollectionArgs = {
  locale: Locale;
  t: (key: string) => string;
  /** Raw (non-string) message accessor, used for the static `notes.<PRINTS_SLUG>` array fallback. */
  tRaw?: (key: string) => unknown;
  /** CMS-resolved per-design notes (id → text) from `getProductNotes(PRINTS_SLUG, locale)`. */
  notes?: Record<string, string>;
};

/**
 * `@graph` for the fine-art-prints collection: a `BreadcrumbList` plus an
 * `ItemList` of published designs. Each design is a `Product` with an
 * `AggregateOffer` (lowPrice/highPrice across its sellable variants) since a
 * print is configurable, not a single SKU.
 */
export async function printCollectionSchema({ locale, t, tRaw, notes }: PrintCollectionArgs): Promise<Graph> {
  const designs = await getPrintDesigns();
  const { currency, priceCurrency } = printCurrencyFor(locale);
  const categoryName = t('nav.fineArtPrints');
  const singular = t('product.print');
  const homeUrl = absoluteUrl(locale, '/');
  const collectionUrl = absoluteUrl(locale, `/${PRINTS_SLUG}`);
  const rawNotes = tRaw?.(`notes.${PRINTS_SLUG}`);

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: homeUrl },
          { '@type': 'ListItem', position: 2, name: categoryName, item: collectionUrl },
        ],
      },
      {
        '@type': 'ItemList',
        name: categoryName,
        numberOfItems: designs.length,
        itemListElement: designs.map((d, i) => {
          const prices = sellableVariantPrices(d, currency);
          return {
            '@type': 'ListItem',
            position: i + 1,
            item: {
              '@type': 'Product',
              name: `${singular} Nº ${d.num}`,
              description: notes?.[d.id] ?? (Array.isArray(rawNotes) ? ((rawNotes[d.noteIndex] as string) ?? '') : ''),
              image: `${SITE_URL}${d.image}`,
              category: categoryName,
              brand: { '@type': 'Brand', name: BRAND_NAME },
              offers: {
                '@type': 'AggregateOffer',
                priceCurrency,
                lowPrice: Math.min(...prices),
                highPrice: Math.max(...prices),
                offerCount: prices.length,
                availability: 'https://schema.org/InStock',
                url: absoluteUrl(locale, `/${PRINTS_SLUG}/${d.id}`),
              },
            },
          };
        }),
      },
    ],
  };
}

type PrintProductArgs = {
  design: PrintDesign;
  locale: Locale;
  t: (key: string) => string;
  tRaw: (key: string) => unknown;
  description?: string;
};

/**
 * `@graph` for a print PDP: `BreadcrumbList` + a `Product` node whose offer is an
 * `AggregateOffer` spanning the cheapest→priciest sellable variant.
 */
export function printProductSchema({ design, locale, t, tRaw, description: descriptionOverride }: PrintProductArgs): Graph {
  const { currency, priceCurrency } = printCurrencyFor(locale);
  const categoryName = t('nav.fineArtPrints');
  const singular = t('product.print');
  const name = `${singular} Nº ${design.num}`;
  const rawNotes = tRaw(`notes.${PRINTS_SLUG}`);
  const description = descriptionOverride ?? (Array.isArray(rawNotes) ? ((rawNotes[design.noteIndex] as string) ?? '') : '');
  const homeUrl = absoluteUrl(locale, '/');
  const collectionUrl = absoluteUrl(locale, `/${PRINTS_SLUG}`);
  const productUrl = absoluteUrl(locale, `/${PRINTS_SLUG}/${design.id}`);
  const images = [design.image, ...(design.gallery ?? [])].map((img) => `${SITE_URL}${img}`);
  const prices = sellableVariantPrices(design, currency);

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: homeUrl },
          { '@type': 'ListItem', position: 2, name: categoryName, item: collectionUrl },
          { '@type': 'ListItem', position: 3, name, item: productUrl },
        ],
      },
      {
        '@type': 'Product',
        '@id': productUrl,
        name,
        description,
        sku: design.id,
        image: images,
        category: categoryName,
        brand: { '@type': 'Brand', name: BRAND_NAME },
        offers: {
          '@type': 'AggregateOffer',
          priceCurrency,
          lowPrice: Math.min(...prices),
          highPrice: Math.max(...prices),
          offerCount: prices.length,
          availability: 'https://schema.org/InStock',
          url: productUrl,
        },
      },
    ],
  };
}

type ProductArgs = {
  product: Product;
  locale: Locale;
  t: (key: string) => string;
  tRaw: (key: string) => unknown;
  description?: string;
};

/**
 * `@graph` for an individual product page: a `BreadcrumbList` (Home → category → product)
 * plus a `Product` node with images, description, and PLN offer.
 */
export function productSchema({ product, locale, t, tRaw, description: descriptionOverride }: ProductArgs): Graph {
  const category = getCategory(product.category);
  const singular = t(`product.${category.singularKey}`);
  const categoryName = t(category.nameKey);
  const name = `${singular} Nº ${product.num}`;
  const rawNotes = tRaw(`notes.${product.category}`);
  const description = descriptionOverride ?? (Array.isArray(rawNotes) ? ((rawNotes[product.noteIndex] as string) ?? '') : '');
  const homeUrl = absoluteUrl(locale, '/');
  const collectionUrl = absoluteUrl(locale, `/${product.category}`);
  const productUrl = absoluteUrl(locale, `/${product.category}/${product.id}`);
  const images = [product.image, ...(product.gallery ?? [])].map((img) => `${SITE_URL}${img}`);

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: homeUrl },
          { '@type': 'ListItem', position: 2, name: categoryName, item: collectionUrl },
          { '@type': 'ListItem', position: 3, name, item: productUrl },
        ],
      },
      {
        '@type': 'Product',
        '@id': productUrl,
        name,
        description,
        sku: product.id,
        image: images,
        category: categoryName,
        brand: { '@type': 'Brand', name: BRAND_NAME },
        offers: {
          '@type': 'Offer',
          price: locale === 'pl' ? product.price : PRICE_EUR[product.category],
          priceCurrency: locale === 'pl' ? 'PLN' : 'EUR',
          // Showroom pieces are not purchasable — never advertise them InStock.
          availability: availabilityFor(product.sold || product.showroom === true),
          url: productUrl,
          shippingDetails: shippingDetailsFor(locale),
          hasMerchantReturnPolicy: merchantReturnPolicy(),
        },
      },
    ],
  };
}
