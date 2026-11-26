import { getTranslations } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { currencyFormatter } from '@/lib/format';
import { priceOfCurrency, type ShippingZone } from '@/lib/pricing';
import { checkoutCountries, resolveCheckoutCountry, DELIVERY_COUNTRY_COOKIE } from '@/lib/delivery/destinations';
import { pdpDeliveryQuote, type PdpDeliveryRow } from '@/lib/pdp-delivery';
import type { ShippingRatesBundle } from '@/lib/shipping-rates/last-known-good';
import type { Currency } from '@/lib/currency';
import type { Product } from '@/lib/types';

/**
 * Server-rendered all-in cost transparency for a ceramic PDP.
 *
 * Resolves the visitor's country the way the cart preselects it (the country
 * saved in the cart, then CF-IPCountry, then the locale). When that is the
 * visitor's real country it names it with its locker price; when it is only a
 * guess it lists the locker price of each zone checkout offers. Either way it
 * says the fee covers the whole parcel and that parcels leave from Spain.
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

  const countries = checkoutCountries();
  const visitor = resolveCheckoutCountry(countries, {
    saved: cookieStore.get(DELIVERY_COUNTRY_COOKIE)?.value,
    ipCountry: requestHeaders.get('cf-ipcountry'),
    locale,
  });
  const quote = pdpDeliveryQuote({ item: priceOfCurrency(product, currency), currency, shipping, countries, visitor });

  const regionNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames([locale], { type: 'region' }) : null;
  const zoneLabel: Record<ShippingZone, string> = { es: t('pdp.lockerEs'), eu: t('pdp.lockerEu') };
  const row = (r: PdpDeliveryRow): { key: string; testId?: string; label: string; price: string } => {
    switch (r.kind) {
      case 'pickup':
        return { key: 'pickup', label: t('ship.pickupT'), price: r.price > 0 ? fmt(r.price) : t('cart.free') };
      case 'locker-country':
        return {
          key: `locker-${r.country}`,
          testId: 'pdp-locker-country',
          label: t('pdp.lockerTo', { country: regionNames?.of(r.country) ?? r.country }),
          price: fmt(r.price),
        };
      case 'locker-zone':
        return {
          key: `locker-${r.zone}`,
          testId: `pdp-locker-${r.zone}`,
          label: r.multiZone ? zoneLabel[r.zone] : t('ship.paczkomatT'),
          price: fmt(r.price),
        };
      case 'courier':
        return { key: 'courier', label: t('ship.courierT'), price: fmt(r.price) };
    }
  };

  return (
    <div className="pdp-delivery" data-testid="pdp-delivery" data-country-known={visitor.known ? 'true' : 'false'}>
      <ul className="pdp-delivery-opts">
        {quote.rows.map(row).map((r) => (
          <li key={r.key} data-testid={r.testId}><span>{r.label}</span><span>{r.price}</span></li>
        ))}
      </ul>
      <div className="pdp-delivery-est">
        <span className="k">{t(quote.exact ? 'pdp.totalWithDelivery' : 'pdp.estimatedFrom')}</span>
        <span className="v" data-testid="pdp-est-total">{fmt(quote.total)}</span>
      </div>
      <p className="pdp-delivery-note" data-testid="pdp-per-parcel">
        {t('pdp.perParcel')}{' '}
        {quote.transitDays !== null ? t('pdp.shipsFromDays', { days: quote.transitDays }) : t('pdp.shipsFrom')}
      </p>
      <p className="pdp-delivery-trust">{t('pdp.trust')}</p>
    </div>
  );
}
