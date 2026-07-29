/* ============================================================
   PrintCollectionScreen — fine-art-prints listing (server component).
   ------------------------------------------------------------
   Unlike the ceramic Gallery, print tiles do NOT add to cart directly:
   a variant (size/paper/frame) must be chosen first, so each tile links
   straight to the print PDP. Prices are shown as "from X / from Y".
   ============================================================ */
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { getPrintDesigns } from '@/lib/prints';
import { fromPriceOf } from '@/lib/print-pricing';
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

export async function PrintCollectionScreen({ locale }: { locale: Locale }) {
  const t = await getTranslations();
  const designs = await getPrintDesigns();
  const currency = await getCurrency(locale);
  const printCurrency = toChargeableCurrency(currency);
  const { fmt, code: analyticsCurrency } = currencyFormatter(printCurrency);

  // Entry variant (first size, unframed) — matches the tile's displayed "from X"
  // and the configurator's initial selection on the PDP the tile links to.
  const analyticsItems: PrintListItem[] = designs.map((d) => {
    const sel: PrintVariantSelection = { size: d.sizes[0], framed: false, mount: false, frameColour: 'none' };
    return { id: d.id, num: d.num, variantLabel: variantLabel(sel, locale), price: fromPriceOf(d, printCurrency) };
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

      <PrintCollectionAnalytics
        items={analyticsItems}
        listId={SLUG}
        listName={SLUG}
        currency={analyticsCurrency}
      >
        {designs.map((d) => {
          const from = fmt(fromPriceOf(d, printCurrency));
          const name = `${t('product.print')} Nº ${d.num}`;
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
                src={d.image}
                srcSet={srcSet(d.image)}
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
      </PrintCollectionAnalytics>
    </>
  );
}
