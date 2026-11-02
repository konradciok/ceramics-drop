import { getTranslations } from 'next-intl/server';
import { currencyFormatter } from '@/lib/format';
import { priceOfCurrency, shippingOfCurrency, type DomesticShippingRates } from '@/lib/pricing';
import type { Currency } from '@/lib/currency';
import type { Product } from '@/lib/types';

/** Server-rendered all-in cost transparency for a ceramic PDP. */
export async function PdpDelivery({
  product,
  currency,
  domesticShippingRates,
}: {
  product: Product;
  currency: Currency;
  /** The CMS-published InPost table checkout charges from (getShippingRatesForDisplay). */
  domesticShippingRates: DomesticShippingRates;
}) {
  const t = await getTranslations();
  const { fmt } = currencyFormatter(currency);
  const item = priceOfCurrency(product, currency);
  const locker = shippingOfCurrency(currency, 'paczkomat', domesticShippingRates);
  const courier = shippingOfCurrency(currency, 'kurier', domesticShippingRates);

  return (
    <div className="pdp-delivery" data-testid="pdp-delivery">
      <div className="pdp-delivery-est">
        <span className="k">{t('pdp.estimatedFrom')}</span>
        <span className="v" data-testid="pdp-est-total">{fmt(item + locker)}</span>
      </div>
      <ul className="pdp-delivery-opts">
        <li><span>{t('ship.pickupT')}</span><span>{t('cart.free')}</span></li>
        <li><span>{t('ship.paczkomatT')}</span><span>{fmt(locker)}</span></li>
        <li><span>{t('ship.courierT')}</span><span>{fmt(courier)}</span></li>
      </ul>
      <p className="pdp-delivery-trust">
        {t(currency === 'gbp' ? 'pdp.trustGbp' : 'pdp.trust')}
      </p>
    </div>
  );
}
