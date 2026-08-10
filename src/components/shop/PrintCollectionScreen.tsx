/* ============================================================
   PrintCollectionScreen — fine-art-prints listing (server component).
   ------------------------------------------------------------
   Unlike the ceramic Gallery, print tiles do NOT add to cart directly:
   a variant (size/paper/frame) must be chosen first, so each tile links
   straight to the print PDP. Prices are shown as "from X / from Y".
   ============================================================ */
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { getPrintDesigns, registryPrintById } from '@/lib/prints';
import { printListingImage } from '@/lib/print-mockups';
import { groupPrintDesigns } from '@/lib/print-collections';
import { fromPriceOf, type PrintPricingConfig } from '@/lib/print-pricing';
import { currencyFormatter } from '@/lib/format';
import { getCurrency } from '@/lib/currency.server';
import { toChargeableCurrency } from '@/lib/currency';
import { srcSet } from '@/lib/images';
import { variantLabel } from '@/lib/print-cart';
import { richTags } from '@/components/ui/richTags';
import { PrintCollectionAnalytics, type PrintListItem } from './PrintCollectionAnalytics';
import type { Locale } from '@/i18n/routing';
import type { PrintVariantSelection } from '@/lib/types';

const SLUG = 'fine-art-prints';

export async function PrintCollectionScreen({
  locale,
  pricing,
}: {
  locale: Locale;
  /** Global print price list, loaded once by the page (getPrintPricingConfig). */
  pricing: PrintPricingConfig;
}) {
  const t = await getTranslations();
  const designs = await getPrintDesigns();
  const currency = await getCurrency(locale);
  const printCurrency = toChargeableCurrency(currency);
  const { fmt, code: analyticsCurrency } = currencyFormatter(printCurrency);

  // Curated collections; grouped display order also drives analytics indices.
  const groups = groupPrintDesigns(designs);
  const ordered = groups.flatMap((g) => g.designs);

  // Entry variant (first size, unframed) — matches the tile's displayed "from X"
  // and the configurator's initial selection on the PDP the tile links to.
  const analyticsItems: PrintListItem[] = ordered.map((d) => {
    const sel: PrintVariantSelection = { size: d.sizes[0], framed: false, mount: false, frameColour: 'none' };
    return { id: d.id, num: d.num, variantLabel: variantLabel(sel, locale), price: fromPriceOf(d, printCurrency, pricing) };
  });

  return (
    <>
      <section className="shop-head">
        <div className="shop-head-inner">
          <div>
            <div className="eyebrow">{t(`collection.${SLUG}.eyebrow`)}</div>
            <h1>{t.rich(`collection.${SLUG}.title`, richTags)}</h1>
            <p className="lead">{t(`collection.${SLUG}.lead`)}</p>
          </div>
        </div>
      </section>

      {/* Sticky collection jump-nav — same pattern as /sklep (AllPiecesScreen),
          static anchors only (no scroll-spy; .gallery-group scroll-margin-top
          keeps the jump target clear of the sticky header). */}
      <nav id="print-nav" className="shop-nav-sticky" aria-label={t('nav.fineArtPrints')}>
        <div className="shop-nav-track">
          <div className="shop-switch">
            {groups.map((g) => (
              <a key={g.slug} href={`#${g.slug}`}>
                {t(`printCollections.${g.slug}`)}
              </a>
            ))}
          </div>
        </div>
      </nav>

      <PrintCollectionAnalytics
        items={analyticsItems}
        listId={SLUG}
        listName={SLUG}
        currency={analyticsCurrency}
      >
        {groups.map((g) => (
          <section key={g.slug} id={g.slug} className="gallery-group">
            <h2 className="gallery-group-head">{t(`printCollections.${g.slug}`)}</h2>
            <div className="gallery" data-count={g.designs.length}>
              {g.designs.map((d) => {
                const from = fmt(fromPriceOf(d, printCurrency, pricing));
                const name = `${t('product.print')} Nº ${d.num}`;
                const image = printListingImage(d, registryPrintById(d.id));
                return (
                  <Link
                    key={d.id}
                    href={`/${SLUG}/${d.id}`}
                    className="tile tile-print"
                    data-product-id={d.id}
                    data-testid="print-tile"
                    aria-label={name}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={image}
                      srcSet={srcSet(image)}
                      sizes="(min-width:1101px) 25vw, (min-width:561px) 33vw, 50vw"
                      alt={name}
                      loading="lazy"
                    />
                    <div className="tile-meta">
                      <span className="nm">{name}</span>
                      <span className="pr">{t('print.from', { price: from })}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </PrintCollectionAnalytics>
    </>
  );
}
