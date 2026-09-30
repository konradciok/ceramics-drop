import { printDisplayName } from '@/lib/print-curation';
import type { Metadata, ResolvingMetadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Icon } from '@/components/ui/Icon';
import { richTags } from '@/components/ui/richTags';
import { JsonLd } from '@/components/seo/JsonLd';
import { PrintShop, type PrintShopItem, type ShopCollectionOption, type ShopPromo } from '@/components/shop/PrintShop';
import { PrintShopStrip } from '@/components/shop/PrintShopStrip';
import { AboutArtistSection } from '@/components/shop/AboutArtistSection';
import { PdpAccordions } from '@/components/shop/PdpAccordions';
import { ExpandableText } from '@/components/shop/ExpandableText';
import { printCollectionSchema } from '@/lib/seo/structured-data';
import { alternatesFor } from '@/lib/seo/urls';
import { getProductNotes } from '@/lib/cms/messages';
import { getPrintPdpContent } from '@/lib/cms/print-pdp';
import { getPrintPricingConfig } from '@/lib/print-pricing-config/get';
import { getPrintDesigns, registryPrintById } from '@/lib/prints';
import { printListingImage, withRegistryMockups } from '@/lib/print-mockups';
import { groupPrintDesigns, loadPrintCollectionDefinitions, UNASSIGNED_COLLECTION } from '@/lib/print-collections';
import { buildShopRanks, newestIds, parseShopView } from '@/lib/print-shop';
import { PRINT_SHOP_CONFIG, shopColoursFor } from '@/lib/print-shop-config';
import { getUsableVariantKeysByProduct } from '@/server/print-assets/repository';
import { readWithFallback } from '@/lib/supabase-timeout';
import { PRINT_PDP_ARTIST_IMAGE } from '@/lib/editorial-images';
import { SITE_URL } from '@/lib/site';
import type { Locale } from '@/i18n/routing';

// Published designs and global pricing are mutable database state. This route
// must invoke their runtime loaders instead of shipping an immutable code-mode
// prerender produced during the Worker build.
export const dynamic = 'force-dynamic';

const PRINTS_SLUG = 'fine-art-prints';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata(
  { params }: Props,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  // Representative OG/Twitter image: the first curated design's listing
  // mockup, in the same order the collection itself renders — without this,
  // the page inherits the global ceramic mug fallback (SEO-010).
  const definitions = await loadPrintCollectionDefinitions();
  const [hero] = groupPrintDesigns(await getPrintDesigns(), definitions).flatMap((g) => g.designs);
  const heroImage = hero ? printListingImage(hero, registryPrintById(hero.id)) : undefined;
  // Spread the parent's openGraph (type, siteName) — a child openGraph object
  // replaces the parent's wholesale, not merges with it (Next.js metadata is
  // only shallow-merged), so overriding just `images` here would silently
  // drop those fields.
  const previousOpenGraph = (await parent).openGraph ?? {};
  return {
    title: t('shop.metaTitle'),
    description: t('shop.metaDescription'),
    // Filtered/sorted views (?kolor=…) are one page for search engines: the
    // canonical never carries the query.
    alternates: alternatesFor(locale as Locale, '/sklep'),
    openGraph: {
      ...previousOpenGraph,
      ...(heroImage && {
        images: [
          {
            url: `${SITE_URL}${heroImage}`,
            width: 1200,
            height: 1714,
            alt: printDisplayName(hero!, t('product.print'), definitions),
          },
        ],
      }),
    },
  };
}

export default async function Page({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, notes, pricing, definitions, designs, pdpContent] = await Promise.all([
    getTranslations({ locale }),
    getProductNotes(PRINTS_SLUG, locale as Locale).catch(() => ({}) as Record<string, string>),
    getPrintPricingConfig(),
    loadPrintCollectionDefinitions(),
    getPrintDesigns(),
    getPrintPdpContent(locale as Locale),
  ]);

  // Group once: drives collection labels, filter options and both rank orders.
  const groups = groupPrintDesigns(designs, definitions);
  const named = groups.filter((g) => g.slug !== UNASSIGNED_COLLECTION && g.name);
  const collectionOf = new Map(named.flatMap((g) => g.designs.map((d) => [d.id, { slug: g.slug, name: g.name! }] as const)));
  const ranks = buildShopRanks(groups, PRINT_SHOP_CONFIG.featured);
  const newIds = newestIds(designs.map((d) => d.id), PRINT_SHOP_CONFIG.newCount);
  const featured = new Set(PRINT_SHOP_CONFIG.featured);

  // Best-effort variant gating for the quick picker — same fail-open rule as
  // the PDP (undefined = don't gate); /api/checkout stays the hard gate.
  const usable = await readWithFallback<Record<string, string[]> | null>(
    'printAssetUsableKeys',
    () => getUsableVariantKeysByProduct(designs.map((d) => d.id)),
    null,
    { locale },
  );

  const items: PrintShopItem[] = designs.map((d) => {
    const registry = registryPrintById(d.id);
    const collection = collectionOf.get(d.id);
    return {
      id: d.id,
      design: d,
      name: printDisplayName(d, t('product.print'), definitions),
      image: printListingImage(d, registry),
      hoverImage: withRegistryMockups(d, registry).editorialGallery?.[0],
      collectionSlug: collection?.slug,
      collectionName: collection?.name,
      colours: shopColoursFor(d.id),
      rank: ranks.get(d.id) ?? { featured: 0, new: 0, collection: 0 },
      isNew: newIds.has(d.id),
      isFeatured: featured.has(d.id),
      usableKeys: usable?.[d.id],
    };
  });

  const collectionOptions: ShopCollectionOption[] = named.map((g) => ({ slug: g.slug, name: g.name!, count: g.designs.length }));
  const initialView = parseShopView((await searchParams) ?? {}, collectionOptions.map((c) => c.slug));

  const schema = await printCollectionSchema({ locale: locale as Locale, t, tRaw: (key) => t.raw(key), notes, pricing, definitions });

  // Editorial bands, server-rendered (copy stays in the message files) and
  // dropped into the grid by the island while no filter is active.
  const promos: ShopPromo[] = [
    {
      key: 'how',
      after: 8,
      node: (
        <div className="shop-band shop-band-how">
          <ol>
            {([1, 2, 3] as const).map((n) => (
              <li key={n}>
                <span className="num">0{n}</span>
                <h3>{t.rich(`home.craft${n}H`, richTags)}</h3>
                <p>{t(`home.craft${n}P`)}</p>
              </li>
            ))}
          </ol>
        </div>
      ),
    },
    {
      key: 'gift',
      after: 20,
      node: (
        <div className="shop-band shop-band-gift">
          <div>
            <h3>{t('shop.giftTitle')}</h3>
            <p>{t('shop.giftLead')}</p>
          </div>
          <Link className="btn btn-ghost" href="/karta-podarunkowa">
            {t('nav.giftCard')}
          </Link>
        </div>
      ),
    },
  ];

  return (
    <main>
      <JsonLd data={schema} />
      <section className="shop-head">
        <div className="shop-head-inner">
          <div>
            <div className="eyebrow">{t('shop.eyebrow')}</div>
            <h1>{t.rich('shop.title', richTags)}</h1>
            <p className="lead">{t('shop.lead')}</p>
          </div>
        </div>
      </section>

      <PrintShopStrip locale={locale as Locale} pricing={pricing} />

      <PrintShop
        items={items}
        initialView={initialView}
        collections={collectionOptions}
        promos={promos}
        pricing={pricing}
        definitions={definitions}
      />

      {collectionOptions.length > 0 && (
        <section className="section shop-collections">
          <div className="section-inner">
            <h2 className="gallery-group-head">{t('shop.collectionsTitle')}</h2>
            <div className="shop-switch shop-collections-chips">
              {collectionOptions.map((c) => (
                <Link key={c.slug} href={`/kolekcje/${c.slug}`}>
                  {c.name}
                </Link>
              ))}
            </div>
            <Link className="section-link" href="/kolekcje">
              <span>{t('shop.collectionsCta')}</span> <Icon name="arrow" />
            </Link>
          </div>
        </section>
      )}

      <section className="section shop-about">
        <div className="section-inner">
          <h2 className="section-title">{t('shop.aboutTitle')}</h2>
          <ExpandableText
            className="shop-about-text"
            text={t('shop.aboutBody')}
            lines={3}
            moreLabel={t('shop.aboutMore')}
            lessLabel={t('shop.aboutLess')}
          />
          <PdpAccordions
            items={[
              { key: 'productDetails', title: t('printPdp.accordionProductDetailsTitle'), body: pdpContent.accordions.productDetails },
              { key: 'framing', title: t('printPdp.accordionFramingTitle'), body: pdpContent.accordions.framing },
              { key: 'shipping', title: t('printPdp.accordionShippingTitle'), body: pdpContent.accordions.shipping },
            ]}
          />
        </div>
      </section>

      <AboutArtistSection
        title={t('printPdp.aboutArtistTitle')}
        name={pdpContent.artist.name}
        bio={pdpContent.artist.bio}
        image={PRINT_PDP_ARTIST_IMAGE}
      />
    </main>
  );
}
