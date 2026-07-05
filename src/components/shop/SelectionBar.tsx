'use client';

import { useTranslations } from 'next-intl';
import { useCart } from '@/store/cart';
import { resolveCartProducts } from '@/lib/products';
import { useCurrency } from '@/components/currency/CurrencyProvider';
import { currencyFormatter } from '@/lib/format';
import { priceOfCurrency } from '@/lib/pricing';
import { Link } from '@/i18n/navigation';
import { Icon } from '@/components/ui/Icon';
import { buildEngagementEvent, pushDataLayer } from '@/lib/analytics';

/** Sticky bottom bar summarising the current selection. */
export function SelectionBar() {
  const t = useTranslations();
  const currency = useCurrency();
  const { fmt } = currencyFormatter(currency);
  const ids = useCart((s) => s.ids);
  const clear = useCart((s) => s.clear);

  const products = resolveCartProducts(ids);
  const n = products.length;
  const total = products.reduce((sum, p) => sum + priceOfCurrency(p, currency), 0);

  return (
    <div className={`selbar${n > 0 ? ' show' : ''}`}>
      <div className="selbar-inner">
        <div className="selbar-info">
          <span className="cnt">
            <em>{n}</em> {t('selbar.word', { count: n })}
          </span>
          <span className="sum">{`${t('selbar.total')} ${fmt(total)}`}</span>
        </div>
        <div className="selbar-actions">
          <button
            className="clear"
            onClick={() => {
              pushDataLayer(
                buildEngagementEvent('cart_clear', {
                  item_ids: products.map((product) => product.id),
                  value: total,
                }),
              );
              clear();
            }}
          >
            {t('selbar.clear')}
          </button>
          <Link
            className="go"
            href="/koszyk"
            onClick={() => {
              pushDataLayer(
                buildEngagementEvent('cart_cta_click', {
                  location: 'selection_bar',
                  num_items: n,
                  value: total,
                }),
              );
            }}
          >
            {t('selbar.go')} <Icon name="arrow" />
          </Link>
        </div>
      </div>
    </div>
  );
}
