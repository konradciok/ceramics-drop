/* Server-rendered grid of print tiles, shared by /sklep and the collection subpages. */
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { printDisplayName } from '@/lib/print-curation';
import type { PrintCollectionDefinition } from '@/lib/print-curation';
import { registryPrintById } from '@/lib/prints';
import { printListingImage } from '@/lib/print-mockups';
import { fromPriceOf, type PrintPricingConfig } from '@/lib/print-pricing';
import { srcSet } from '@/lib/images';
import type { PrintDesign } from '@/lib/types';
import type { toChargeableCurrency } from '@/lib/currency';

/** Server-rendered grid of print tiles for the collection pages (the shop uses PrintShopCard). */
export async function PrintTileGrid({
  designs,
  currency,
  fmt,
  pricing,
  definitions,
}: {
  designs: PrintDesign[];
  currency: ReturnType<typeof toChargeableCurrency>;
  fmt: (n: number) => string;
  pricing: PrintPricingConfig;
  definitions: PrintCollectionDefinition[];
}) {
  const t = await getTranslations();
  return (
    <div className="gallery" data-count={designs.length}>
      {designs.map((d) => {
        const from = fmt(fromPriceOf(d, currency, pricing));
        const name = printDisplayName(d, t('product.print'), definitions);
        const image = printListingImage(d, registryPrintById(d.id));
        return (
          <Link
            key={d.id}
            href={`/fine-art-prints/${d.id}`}
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
              width={700}
              height={1000}
            />
            <div className="tile-meta">
              <span className="nm">{name}</span>
              <span className="pr">{t('print.from', { price: from })}</span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
