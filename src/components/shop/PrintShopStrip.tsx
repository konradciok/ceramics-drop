/* ============================================================
   PrintShopStrip — trust facts + price ladder above the /sklep grid.
   Every print shares one price list, so the ladder states the real price of
   each size (and the frame surcharge) up front instead of hiding it behind a
   PDP click. Values come from the same PrintPricingConfig the PDP and
   checkout use, in the visitor's currency — never hard-coded copy.
   ============================================================ */
import { getTranslations } from 'next-intl/server';
import { getCurrency } from '@/lib/currency.server';
import { toChargeableCurrency } from '@/lib/currency';
import { currencyFormatter } from '@/lib/format';
import { derivePrice, type PrintPricingConfig } from '@/lib/print-pricing';
import { PRINT_SIZES } from '@/lib/print-cart';
import type { Locale } from '@/i18n/routing';

export async function PrintShopStrip({ locale, pricing }: { locale: Locale; pricing: PrintPricingConfig }) {
  const t = await getTranslations();
  const currency = toChargeableCurrency(await getCurrency(locale));
  const { fmt } = currencyFormatter(currency);

  const frames = PRINT_SIZES.map((s) => derivePrice(pricing.frameEur[s], currency, pricing));
  const frameMin = Math.min(...frames);
  const frameMax = Math.max(...frames);
  const framePrice = frameMin === frameMax ? fmt(frameMin) : `${fmt(frameMin)}–${fmt(frameMax)}`;

  return (
    <section className="shop-strip" aria-label={t('shop.priceNote')}>
      <div className="shop-strip-inner">
        <ul className="shop-strip-facts">
          {(t.raw('home.printsFacts') as string[]).map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
        <div className="shop-strip-prices">
          <ul>
            {PRINT_SIZES.map((size) => (
              <li key={size}>
                {t('shop.priceLadder', {
                  size: t(`print.size.${size}`),
                  price: fmt(derivePrice(pricing.baseEur[size], currency, pricing)),
                })}
              </li>
            ))}
            <li>{t('shop.frameFrom', { price: framePrice })}</li>
          </ul>
          <p>{t('shop.priceNote')}</p>
        </div>
      </div>
    </section>
  );
}
