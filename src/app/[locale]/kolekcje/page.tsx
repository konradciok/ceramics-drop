import type { Metadata, ResolvingMetadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { JsonLd } from '@/components/seo/JsonLd';
import { CollectionCard } from '@/components/shop/CollectionCard';
import { Icon } from '@/components/ui/Icon';
import { richTags } from '@/components/ui/richTags';
import { printCollectionsHubSchema } from '@/lib/seo/structured-data';
import { alternatesFor } from '@/lib/seo/urls';
import { getPrintDesigns, registryPrintById } from '@/lib/prints';
import { printListingImage } from '@/lib/print-mockups';
import {
  collectionDescription,
  collectionTeaser,
  groupPrintDesigns,
  loadPrintCollectionDefinitions,
  UNASSIGNED_COLLECTION,
} from '@/lib/print-collections';
import { SITE_URL } from '@/lib/site';
import type { Locale } from '@/i18n/routing';

// Published designs and CMS collection copy are database state — resolve per request.
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: string }> };

/** Real collections (never the 'inne' fallback bucket) that have published prints, in curated order. */
async function loadCards(locale: string) {
  const [designs, definitions] = await Promise.all([getPrintDesigns(), loadPrintCollectionDefinitions()]);
  const byslug = new Map(definitions.map((d) => [d.slug, d]));
  return groupPrintDesigns(designs, definitions)
    .filter((g) => g.slug !== UNASSIGNED_COLLECTION && g.name)
    .map((g) => {
      const cover = g.designs[0];
      const def = byslug.get(g.slug);
      const description = def ? collectionDescription(def, locale) : undefined;
      return {
        slug: g.slug,
        name: g.name!,
        image: printListingImage(cover, registryPrintById(cover.id)),
        count: g.designs.length,
        description,
        teaser: collectionTeaser(description),
      };
    });
}

export async function generateMetadata({ params }: Props, parent: ResolvingMetadata): Promise<Metadata> {
  const { locale } = await params;
  const [t, cards] = await Promise.all([getTranslations({ locale }), loadCards(locale)]);
  const previousOpenGraph = (await parent).openGraph ?? {};
  const title = t('collectionsHub.metaTitle');
  const description = t('collectionsHub.metaDescription', { count: cards.length });
  const [first] = cards;
  return {
    title,
    description,
    alternates: alternatesFor(locale as Locale, '/kolekcje'),
    openGraph: {
      ...previousOpenGraph,
      title,
      description,
      ...(first && { images: [{ url: `${SITE_URL}${first.image}`, width: 1200, height: 1714, alt: first.name }] }),
    },
  };
}

export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, cards] = await Promise.all([getTranslations({ locale }), loadCards(locale)]);

  const schema = printCollectionsHubSchema({
    locale: locale as Locale,
    t: (key) => t(key),
    cards,
    description: t('collectionsHub.metaDescription', { count: cards.length }),
  });

  return (
    <main>
      <JsonLd data={schema} />
      <section className="shop-head">
        <div className="shop-head-inner">
          <div>
            <div className="eyebrow">{t('collectionsHub.eyebrow')}</div>
            <h1>{t.rich('collectionsHub.title', richTags)}</h1>
            <p className="lead">{t('collectionsHub.lead')}</p>
          </div>
        </div>
      </section>

      <section className="section collections-hub">
        <div className="section-inner">
          <div className="collections-hub-grid">
            {cards.map((c) => (
              <CollectionCard
                key={c.slug}
                slug={c.slug}
                name={c.name}
                image={c.image}
                countLabel={t('home.collectionsCount', { count: c.count })}
                teaser={c.teaser}
                sizes="(min-width:1101px) 25vw, (min-width:561px) 33vw, 50vw"
              />
            ))}
          </div>
          <div className="collections-hub-cta">
            <Link className="section-link" href="/sklep">
              <span>{t('collectionsHub.shopCta')}</span> <Icon name="arrow" />
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
