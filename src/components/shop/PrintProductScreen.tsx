/* ============================================================
   PrintProductScreen — fine-art print PDP layout (server component).
   Mirrors ProductPageScreen, but the buy action is the PrintConfigurator
   island (variant must be chosen) and the spec block covers print details,
   edition, delivery lead time and care.
   ============================================================ */
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { currencyFormatter } from '@/lib/format';
import { getCurrency } from '@/lib/currency.server';
import { toChargeableCurrency } from '@/lib/currency';
import { fromPriceOf, type PrintPricingConfig } from '@/lib/print-pricing';
import { getPrintDesigns, registryPrintById } from '@/lib/prints';
import { printListingImage, withRegistryMockups } from '@/lib/print-mockups';
import { SITE_NAME } from '@/lib/site';
import { srcSet } from '@/lib/images';
import { PrintPdpPurchase } from './PrintPdpPurchase';
import { PrintViewAnalytics } from './PrintViewAnalytics';
import type { PrintDesign } from '@/lib/types';

const SLUG = 'fine-art-prints';

export async function PrintProductScreen({
  design,
  noteOverride,
  usableVariantKeys,
  pricing,
}: {
  design: PrintDesign;
  noteOverride?: string;
  usableVariantKeys?: string[];
  /** Global print price list, loaded once by the PDP page (getPrintPricingConfig). */
  pricing: PrintPricingConfig;
}) {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const currency = await getCurrency(locale);
  const printCurrency = toChargeableCurrency(currency);
  const { fmt } = currencyFormatter(printCurrency);

  const categoryName = t('nav.fineArtPrints');
  const singular = t('product.print');
  const displayName = `${singular} Nº ${design.num}`;
  const rawNotes = t.raw(`notes.${SLUG}`) as unknown;
  const fallbackNote = Array.isArray(rawNotes) ? ((rawNotes[design.noteIndex] as string) ?? '') : '';
  const note = noteOverride ?? fallbackNote;
  const images = [design.image, ...(design.gallery ?? [])];

  // Size dimensions the design offers, e.g. "A4 · 21 × 29,7 cm".
  const sizeLines = design.sizes.map((s) => `${t(`print.size.${s}`)} · ${t(`print.sizeHint.${s}`)}`).join(' / ');

  const siblings = (await getPrintDesigns())
    .filter((d) => d.id !== design.id)
    .slice(0, 4);

  // Under CATALOG_SOURCE=db, `design` comes from mapPrintDesigns() (catalog
  // shadow tables), which doesn't carry `mockups` — merge it from the code
  // registry so the live-mockup hero is visible in production, not just in
  // `code` mode (image-drift guard + rationale in withRegistryMockups).
  const purchaseDesign = withRegistryMockups(design, registryPrintById(design.id));

  return (
    <>
    <PrintViewAnalytics design={design} pricing={pricing} />
    <article className="pdp">
      <div className="pdp-inner">
        <nav className="pdp-breadcrumb" aria-label="breadcrumb">
          <Link href="/">{SITE_NAME}</Link>
          <span className="pdp-breadcrumb-sep" aria-hidden="true">/</span>
          <Link href={`/${SLUG}`}>{categoryName}</Link>
          <span className="pdp-breadcrumb-sep" aria-hidden="true">/</span>
          <span aria-current="page">{displayName}</span>
        </nav>

        <div className="pdp-layout">
          <PrintPdpPurchase
            design={purchaseDesign}
            images={images}
            alt={displayName}
            usableVariantKeys={usableVariantKeys}
            pricing={pricing}
            header={
              <>
                <div className="eyebrow">{categoryName}</div>
                <h1>
                  {singular} <em>Nº {design.num}</em>
                </h1>
                {note && <p className="pdp-note">{note}</p>}
              </>
            }
            footer={
              <div className="lb-specs print-specs">
                <div className="lb-spec">
                  <span className="k">{t('print.sectionDetails')}</span>
                  <span className="v">{t('print.technique')}<br />{sizeLines}</span>
                </div>
                <div className="lb-spec">
                  <span className="k">{t('print.sectionEdition')}</span>
                  <span className="v">{t('print.editionOpen')}</span>
                </div>
                <div className="lb-spec">
                  <span className="k">{t('print.sectionDelivery')}</span>
                  <span className="v">{t('print.deliveryNote')}</span>
                </div>
                <div className="lb-spec">
                  <span className="k">{t('print.sectionCare')}</span>
                  <span className="v">{t('print.careNote')}</span>
                </div>
              </div>
            }
          />
        </div>
      </div>

      {siblings.length > 0 && (
        <section className="pdp-more">
          <div className="pdp-more-inner">
            <h2>{t('print.moreFrom')}</h2>
            <div className="gallery" data-count={siblings.length}>
              {siblings.map((d) => {
                const from = fmt(fromPriceOf(d, printCurrency, pricing));
                const name = `${singular} Nº ${d.num}`;
                const image = printListingImage(d, registryPrintById(d.id));
                return (
                  <Link key={d.id} href={`/${SLUG}/${d.id}`} className="tile tile-print" aria-label={name}>
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
            <div className="pdp-more-cta">
              <Link href={`/${SLUG}`} className="btn btn-ghost">
                {t('product.seeAll')} — {categoryName}
              </Link>
            </div>
          </div>
        </section>
      )}
    </article>
    </>
  );
}
