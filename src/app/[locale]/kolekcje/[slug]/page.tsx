import type { Metadata, ResolvingMetadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { JsonLd } from '@/components/seo/JsonLd';
import { PrintTileGrid } from '@/components/shop/PrintTileGrid';
import { PrintCollectionAnalytics, type PrintListItem } from '@/components/shop/PrintCollectionAnalytics';
import { printCollectionPageSchema } from '@/lib/seo/structured-data';
import { alternatesForIndexableLocales } from '@/lib/seo/urls';
import { getProductNotes } from '@/lib/cms/messages';
import { getPrintPricingConfig } from '@/lib/print-pricing-config/get';
import { getPrintDesigns, registryPrintById } from '@/lib/prints';
import { printListingImage } from '@/lib/print-mockups';
import { printDisplayName } from '@/lib/print-curation';
import {
  collectionMetaDescription,
  groupPrintDesigns,
  indexableCollectionLocales,
  loadPrintCollectionDefinitions,
  resolvePrintCollectionPage,
  splitCollectionDescription,
  UNASSIGNED_COLLECTION,
} from '@/lib/print-collections';
import { fromPriceOf } from '@/lib/print-pricing';
import { variantLabel } from '@/lib/print-cart';
import { currencyFormatter } from '@/lib/format';
import { getCurrency } from '@/lib/currency.server';
import { toChargeableCurrency } from '@/lib/currency';
import { SITE_NAME, SITE_URL } from '@/lib/site';
import type { Locale } from '@/i18n/routing';
import type { PrintVariantSelection } from '@/lib/types';

// Published designs, pricing and CMS descriptions are database state.
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: string; slug: string }> };

/**
 * Resolve one collection page for a locale. Undefined (→ 404) for an unknown
 * slug, the "inne" fallback bucket, or a collection with nothing published.
 */
async function load(locale: string, slug: string) {
  if (slug === UNASSIGNED_COLLECTION) return undefined;
  const [designs, definitions] = await Promise.all([getPrintDesigns(), loadPrintCollectionDefinitions()]);
  const page = resolvePrintCollectionPage(slug, locale, designs, definitions);
  return page && { page, definitions, designs };
}

/**
 * Title, description and OG plus indexability: a page without real copy in this
 * locale, or with too few prints, is `noindex` and declares no hreflang.
 */
export async function generateMetadata({ params }: Props, parent: ResolvingMetadata): Promise<Metadata> {
  const { locale, slug } = await params;
  const loaded = await load(locale, slug);
  if (!loaded) return {};
  const { page, designs, definitions } = loaded;
  const t = await getTranslations({ locale });
  const [hero] = page.designs;
  const previousOpenGraph = (await parent).openGraph ?? {};
  const title = t('collectionPage.metaTitle', { name: page.name });
  // Whole sentences only — a hard slice would cut the snippet mid-sentence.
  const description = page.description
    ? collectionMetaDescription(page.description)
    : t('collectionPage.metaDescriptionFallback', { name: page.name });
  const image = hero ? printListingImage(hero, registryPrintById(hero.id)) : undefined;
  return {
    title,
    description,
    // hreflang only across locales where this page is indexable — a noindex
    // sibling would make the cluster inconsistent (and would disagree with the sitemap).
    alternates: alternatesForIndexableLocales(locale as Locale, `/kolekcje/${slug}`, indexableCollectionLocales(slug, designs, definitions)),
    // Thin (few prints) or copy-less pages stay reachable but out of the index.
    ...(!page.indexable && { robots: { index: false, follow: true } }),
    openGraph: {
      ...previousOpenGraph,
      title,
      description,
      ...(image && { images: [{ url: `${SITE_URL}${image}`, width: 1200, height: 1714, alt: printDisplayName(hero, t('product.print'), loaded.definitions) }] }),
    },
  };
}

/** One collection: breadcrumb, its description, its prints and links to the sibling collections. */
export default async function Page({ params }: Props) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const loaded = await load(locale, slug);
  if (!loaded) notFound();
  const { page, definitions, designs } = loaded;

  const [t, notes, pricing, currency] = await Promise.all([
    getTranslations({ locale }),
    getProductNotes('fine-art-prints', locale as Locale).catch(() => ({}) as Record<string, string>),
    getPrintPricingConfig(),
    getCurrency(locale as Locale),
  ]);
  const printCurrency = toChargeableCurrency(currency);
  const { fmt, code } = currencyFormatter(printCurrency);
  // Only collections that actually have published prints — never link to a 404.
  const others = groupPrintDesigns(designs, definitions).filter((g) => g.slug !== slug && g.slug !== UNASSIGNED_COLLECTION && g.name);

  const items: PrintListItem[] = page.designs.map((d) => {
    const sel: PrintVariantSelection = { size: d.sizes[0], framed: false, mount: false, frameColour: 'none' };
    return {
      id: d.id,
      num: d.num,
      variantLabel: variantLabel(sel, locale as Locale),
      price: fromPriceOf(d, printCurrency, pricing),
      itemName: printDisplayName(d, t('product.print'), definitions),
    };
  });

  // First sentence = lead (also the hub teaser); the rest reads as body copy beside/below it.
  const { lead, rest } = page.description ? splitCollectionDescription(page.description) : { lead: undefined, rest: undefined };

  const schema = printCollectionPageSchema({
    locale: locale as Locale,
    t: (key) => t(key),
    tRaw: (key) => t.raw(key),
    notes,
    pricing,
    definitions,
    slug,
    name: page.name,
    description: page.description,
    designs: page.designs,
  });

  return (
    <main>
      <JsonLd data={schema} />
      <nav className="pdp-breadcrumb" aria-label="breadcrumb" style={{ padding: '24px var(--gut) 0', maxWidth: 'var(--max)', margin: '0 auto' }}>
        <Link href="/">{SITE_NAME}</Link>
        <span className="pdp-breadcrumb-sep" aria-hidden="true">/</span>
        <Link href="/kolekcje">{t('nav.kolekcje')}</Link>
        <span className="pdp-breadcrumb-sep" aria-hidden="true">/</span>
        <span aria-current="page">{page.name}</span>
      </nav>
      <section className="shop-head">
        <div className="shop-head-inner">
          <div>
            <div className="eyebrow">{t('collectionPage.eyebrow', { count: page.designs.length })}</div>
            <h1>{page.name}</h1>
            {lead && <p className="lead">{lead}</p>}
          </div>
          {rest && <p className="collection-body">{rest}</p>}
        </div>
      </section>
      <PrintCollectionAnalytics items={items} listId={`collection-${slug}`} listName={page.name} currency={code}>
        <section className="gallery-group">
          <PrintTileGrid designs={page.designs} currency={printCurrency} fmt={fmt} pricing={pricing} definitions={definitions} />
        </section>
      </PrintCollectionAnalytics>
      <section className="gallery-group collection-more">
        {others.length > 0 && (
          <>
            <h2 className="gallery-group-head">{t('collectionPage.otherCollections')}</h2>
            <div className="collection-more-inner">
              <div className="shop-switch">
                {others.map((o) => (
                  <Link key={o.slug} href={`/kolekcje/${o.slug}`}>{o.name}</Link>
                ))}
              </div>
            </div>
          </>
        )}
        <div className="collection-more-inner collection-more-cta">
          <Link href="/kolekcje" className="btn btn-ghost">{t('collectionPage.allCollections')}</Link>
          <Link href="/sklep" className="btn btn-primary">{t('collectionPage.shopCta')}</Link>
        </div>
      </section>
    </main>
  );
}
