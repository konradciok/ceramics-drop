import type { Graph, Organization, WithContext } from 'schema-dts';
import type { Locale } from '@/i18n/routing';
import type { CategorySlug } from '@/lib/types';
import { getCategory, getProductsByCategory } from '@/lib/products';
import { SITE_NAME, SITE_URL } from '@/lib/site';
import { absoluteUrl } from '@/lib/seo/urls';

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
    email: 'hej@annaciok.pl',
  };
}

type CollectionArgs = {
  slug: CategorySlug;
  locale: Locale;
  /** A next-intl translator bound to the request locale. */
  t: (key: string) => string;
  /**
   * Live sold piece ids (from `getSoldIds()`), so JSON-LD availability matches the
   * Supabase-backed gallery. Defaults to none sold — the static catalog flag alone
   * would otherwise always report `InStock`.
   */
  soldIds?: readonly string[];
};

/**
 * `@graph` for a collection page: a `BreadcrumbList` (Home → category) plus an
 * `ItemList` of every piece in the family as `Product` nodes with PLN offers.
 * Pieces are one-of-a-kind, so the price is the shared family price and
 * availability degrades to `SoldOut` once a piece sells.
 */
export function collectionSchema({ slug, locale, t, soldIds = [] }: CollectionArgs): Graph {
  const category = getCategory(slug);
  const products = getProductsByCategory(slug);
  const sold = new Set(soldIds);
  const singular = t(`product.${category.singularKey}`);
  const categoryName = t(category.nameKey);
  const homeUrl = absoluteUrl(locale, '/');
  const collectionUrl = absoluteUrl(locale, `/${slug}`);

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
            image: `${SITE_URL}${p.image}`,
            category: categoryName,
            offers: {
              '@type': 'Offer',
              price: category.price,
              priceCurrency: 'PLN',
              availability: availabilityFor(p.sold || sold.has(p.id)),
              url: collectionUrl,
            },
          },
        })),
      },
    ],
  };
}
