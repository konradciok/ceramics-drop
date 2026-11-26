import type { Graph, Organization, WithContext } from 'schema-dts';
import type { Locale } from '@/i18n/routing';
import type { CategorySlug, Product } from '@/lib/types';
import { getCategory, getProductsByCategory, productDisplayName } from '@/lib/products';
import { COURIER_ENABLED, PRICE_EUR } from '@/lib/pricing';
import type { ShippingRatesBundle } from '@/lib/shipping-rates/last-known-good';
import { deliveryRatesFor } from '@/lib/shipping-rates/delivery-rates';
import { checkoutCountries, DESTINATIONS, type DestinationCountry } from '@/lib/delivery/destinations';
import { SITE_NAME, SITE_URL, PRODUCT_BRAND_NAME, STUDIO } from '@/lib/site';
import { absoluteUrl } from '@/lib/seo/urls';
import { EMAIL } from '@/lib/email-addresses';
import { RETURNS_POLICY } from '@/lib/returns-policy';

/** The countries checkout ships to (InPost lockers and points, from Spain):
 *  shipping details + the return policy's markets, whatever the page language. */
function shippingCountries(): DestinationCountry[] {
  return checkoutCountries();
}

/** Matches the copy on /dostawa-i-zwroty (shipping.s5P / s5Li2 / s5Li3): 14-day
 *  right of withdrawal, buyer pays return shipping, refund within 14 days. */
const RETURN_WINDOW_DAYS = RETURNS_POLICY.withdrawalDays;

/** Returns go to the studio in Tenerife; the covered markets are shippingCountries(). */
const RETURN_POLICY_COUNTRY = RETURNS_POLICY.address.addressCountry;

/** Resolves a Product description: an explicit CMS override, falling through
 *  to the static `notes.<slug>` array on an empty override too — `??` alone
 *  would let an empty-string CMS note win over a real fallback. */
function resolveDescription(override: string | undefined, rawNotes: unknown, noteIndex: number): string {
  if (override) return override;
  return Array.isArray(rawNotes) ? ((rawNotes[noteIndex] as string) || '') : '';
}

/**
 * One `OfferShippingDetails` per country checkout ships to, each with its
 * zone's locker rate from the CMS-published tables checkout charges from
 * (never the code constants) and its promised transit time (`transitDays` in
 * the destination registry: Spain 4, elsewhere 7 business days). Handling is
 * the owner-confirmed term (shipping.s2P): orders are fulfilled within 2
 * business days. The courier rate (PL only) appears only with COURIER_ENABLED.
 */
function shippingDetailsFor(locale: Locale, shipping: Pick<ShippingRatesBundle, 'domestic' | 'lockers'>) {
  const currency = locale === 'pl' ? 'PLN' : 'EUR';
  const key = locale === 'pl' ? 'pln' : 'eur';
  const rate = (country: DestinationCountry, value: number) => ({
    '@type': 'OfferShippingDetails' as const,
    shippingRate: { '@type': 'MonetaryAmount' as const, value, currency },
    shippingDestination: { '@type': 'DefinedRegion' as const, addressCountry: country },
    deliveryTime: {
      '@type': 'ShippingDeliveryTime' as const,
      handlingTime: { '@type': 'QuantitativeValue' as const, minValue: 0, maxValue: 2, unitCode: 'DAY' },
      transitTime: { '@type': 'QuantitativeValue' as const, minValue: 1, maxValue: DESTINATIONS[country].transitDays, unitCode: 'DAY' },
    },
  });
  return shippingCountries().flatMap((country) => {
    const rates = deliveryRatesFor(shipping, country)[key];
    return COURIER_ENABLED && country === 'PL' ? [rate(country, rates.paczkomat), rate(country, rates.kurier)] : [rate(country, rates.paczkomat)];
  });
}

/**
 * Standard ceramics: 14-day withdrawal policy.
 * `applicableCountry` is the market the offer/policy covers (tracks the
 * locale's shipping destination); `returnPolicyCountry` is the fixed address
 * returns are actually sent back to.
 */
function standardReturnPolicy() {
  return {
    '@type': 'MerchantReturnPolicy' as const,
    returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow' as const,
    merchantReturnDays: RETURN_WINDOW_DAYS,
    returnMethod: 'https://schema.org/ReturnByMail' as const,
    returnFees: 'https://schema.org/ReturnShippingFees' as const,
    returnPolicyCountry: RETURN_POLICY_COUNTRY,
  };
}

function merchantReturnPolicy() {
  return { ...standardReturnPolicy(), applicableCountry: shippingCountries() };
}

/** schema.org availability for a 1/1 piece, derived from its `sold` flag. */
function availabilityFor(sold: boolean, available: boolean) {
  return sold ? 'https://schema.org/SoldOut' : available ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock';
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
    taxID: STUDIO.taxId,
    address: { '@type': 'PostalAddress', ...STUDIO.address },
    sameAs: [STUDIO.instagram, STUDIO.facebook],
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
  /** The CMS-published shipping table checkout charges from (see getShippingRatesForDisplay). */
  shipping: ShippingRatesBundle;
};

/**
 * `@graph` for a collection page: a `BreadcrumbList` (Home → category) plus an
 * `ItemList` of every piece in the family as `Product` nodes with PLN offers.
 * Pieces are one-of-a-kind, so the price is the shared family price and
 * availability degrades to `SoldOut` once a piece sells.
 */
export async function collectionSchema({ slug, locale, t, tRaw, soldIds = [], showroomIds = [], notes, shipping }: CollectionArgs): Promise<Graph> {
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
            name: productDisplayName(p, singular),
            description: resolveDescription(notes?.[p.id], rawNotes, p.noteIndex),
            image: `${SITE_URL}${p.image}`,
            category: categoryName,
            brand: { '@type': 'Brand', name: PRODUCT_BRAND_NAME },
            offers: {
              '@type': 'Offer',
              price: locale === 'pl' ? category.price : PRICE_EUR[slug],
              priceCurrency: locale === 'pl' ? 'PLN' : 'EUR',
              availability: availabilityFor(p.sold || sold.has(p.id), p.onlineAvailable === true && !showroom.has(p.id)),
              url: absoluteUrl(locale, `/${slug}/${p.id}`),
              shippingDetails: shippingDetailsFor(locale, shipping),
              hasMerchantReturnPolicy: merchantReturnPolicy(),
            },
          },
        })),
      },
    ],
  };
}

export type CeramicShopFamilyCard = { slug: CategorySlug; name: string; image: string };

/** `@graph` for /sklep (the ceramics shop): `CollectionPage` + `ItemList` of the family pages + `BreadcrumbList`. */
export function ceramicShopSchema({ locale, name, description, families }: {
  locale: Locale;
  name: string;
  description?: string;
  families: CeramicShopFamilyCard[];
}): Graph {
  const shopUrl = absoluteUrl(locale, '/sklep');
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': shopUrl,
        url: shopUrl,
        name,
        ...(description && { description }),
        inLanguage: locale,
        isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE_URL },
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: families.length,
          itemListElement: families.map((f, i) => ({
            '@type': 'ListItem' as const,
            position: i + 1,
            url: absoluteUrl(locale, `/${f.slug}`),
            name: f.name,
            image: `${SITE_URL}${f.image}`,
          })),
        },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: absoluteUrl(locale, '/') },
          { '@type': 'ListItem', position: 2, name, item: shopUrl },
        ],
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
  /** The CMS-published shipping table checkout charges from (see getShippingRatesForDisplay). */
  shipping: ShippingRatesBundle;
};

/**
 * `@graph` for an individual product page: a `BreadcrumbList` (Home → category → product)
 * plus a `Product` node with images, description, and PLN offer.
 */
export function productSchema({ product, locale, t, tRaw, description: descriptionOverride, shipping }: ProductArgs): Graph {
  const category = getCategory(product.category);
  const singular = t(`product.${category.singularKey}`);
  const categoryName = t(category.nameKey);
  const name = productDisplayName(product, singular);
  const rawNotes = tRaw(`notes.${product.category}`);
  const description = resolveDescription(descriptionOverride, rawNotes, product.noteIndex);
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
        brand: { '@type': 'Brand', name: PRODUCT_BRAND_NAME },
        // Same use & care fact the PDP spec list shows (every ceramic family).
        additionalProperty: [
          { '@type': 'PropertyValue', name: t('lightbox.specUse'), value: t('lightbox.specUseVal') },
        ],
        offers: {
          '@type': 'Offer',
          price: locale === 'pl' ? product.price : PRICE_EUR[product.category],
          priceCurrency: locale === 'pl' ? 'PLN' : 'EUR',
          // Showroom pieces are not purchasable — never advertise them InStock.
          availability: availabilityFor(product.sold, product.onlineAvailable === true && !product.showroom),
          url: productUrl,
          shippingDetails: shippingDetailsFor(locale, shipping),
          hasMerchantReturnPolicy: merchantReturnPolicy(),
        },
      },
    ],
  };
}
