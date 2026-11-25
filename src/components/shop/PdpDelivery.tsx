import { getTranslations } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { currencyFormatter } from '@/lib/format';
import { deliveryRatesForZone, priceOfCurrency, shippingOfCurrency, COURIER_ENABLED, STUDIO_PICKUP_ENABLED, type ShippingZone } from '@/lib/pricing';
import { checkoutCountries, defaultCheckoutCountry, DELIVERY_COUNTRY_COOKIE, DESTINATIONS } from '@/lib/delivery/destinations';
import { deliveryRatesFor } from '@/lib/shipping-rates/delivery-rates';
import type { ShippingRatesBundle } from '@/lib/shipping-rates/last-known-good';
import type { Currency } from '@/lib/currency';
import type { Product } from '@/lib/types';

/**
 * Server-rendered all-in cost transparency for a ceramic PDP.
 *
 * Lists the locker price of each zone checkout offers (Spain, every other
 * country) and estimates the total for the visitor's country — the same
 * preselection the cart makes (the country saved in the cart, then
 * CF-IPCountry, then the locale), so the estimate matches the cart the buyer
 * lands on.
 */
export async function PdpDelivery({
  product,
  currency,
  locale,
  shipping,
}: {
  product: Product;
  currency: Currency;
  locale: string;
  /** The CMS-published tables checkout charges from (getShippingRatesForDisplay). */
  shipping: ShippingRatesBundle;
}) {
  const [t, requestHeaders, cookieStore] = await Promise.all([getTranslations(), headers(), cookies()]);
  const { fmt } = currencyFormatter(currency);
  const item = priceOfCurrency(product, currency);

  const countries = checkoutCountries();
  const visitorCountry = defaultCheckoutCountry(countries, {
    saved: cookieStore.get(DELIVERY_COUNTRY_COOKIE)?.value,
    ipCountry: requestHeaders.get('cf-ipcountry'),
    locale,
  });
  const visitorRates = deliveryRatesFor(shipping, visitorCountry);
  const locker = shippingOfCurrency(currency, 'paczkomat', visitorRates);
  const courier = shippingOfCurrency(currency, 'kurier', visitorRates);
  // Studio pickup is free unless the operator publishes a price for it (odbior is editable, like the cart label).
  const pickup = shippingOfCurrency(currency, 'odbior', visitorRates);

  // One row per zone on offer; a single zone keeps the plain locker label.
  const zones = [...new Set(countries.map((c) => DESTINATIONS[c].zone))];
  const zoneLabel: Record<ShippingZone, string> = { es: t('pdp.lockerEs'), eu: t('pdp.lockerEu') };
  const lockerRows = zones.map((zone) => ({
    zone,
    label: zones.length > 1 ? zoneLabel[zone] : t('ship.paczkomatT'),
    price: shippingOfCurrency(currency, 'paczkomat', deliveryRatesForZone(shipping.domestic, shipping.lockers, zone)),
  }));

  return (
    <div className="pdp-delivery" data-testid="pdp-delivery">
      <div className="pdp-delivery-est">
        <span className="k">{t('pdp.estimatedFrom')}</span>
        <span className="v" data-testid="pdp-est-total">{fmt(item + locker)}</span>
      </div>
      <ul className="pdp-delivery-opts">
        {STUDIO_PICKUP_ENABLED && (
          <li><span>{t('ship.pickupT')}</span><span>{pickup > 0 ? fmt(pickup) : t('cart.free')}</span></li>
        )}
        {lockerRows.map((row) => (
          <li key={row.zone} data-testid={`pdp-locker-${row.zone}`}><span>{row.label}</span><span>{fmt(row.price)}</span></li>
        ))}
        {COURIER_ENABLED && <li><span>{t('ship.courierT')}</span><span>{fmt(courier)}</span></li>}
      </ul>
      <p className="pdp-delivery-trust">{t('pdp.trust')}</p>
    </div>
  );
}
