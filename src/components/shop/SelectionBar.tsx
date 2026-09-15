'use client';

import { useTranslations } from 'next-intl';
import { useCart } from '@/store/cart';
import { useCartLines } from '@/lib/use-cart-lines';
import { isGiftCardToken } from '@/lib/gift-cards';
import { isPrintToken } from '@/lib/print-cart';
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
  const { fmt, code: analyticsCurrency } = currencyFormatter(currency);
  const ids = useCart((s) => s.ids);
  const clear = useCart((s) => s.clear);
  const { lines, status } = useCartLines(ids);

  // Selection scope is ceramics only — prints/gift cards aren't added from
  // the gallery/PDP selection flow this bar summarises. Sold/showroom pieces
  // are excluded too (registryResolveCartProducts did the same): the DTO
  // deliberately keeps them in `lines` for CartView's own sold-badge display,
  // but a piece that sold while the buyer was browsing shouldn't inflate this
  // bar's count/total ahead of the /koszyk inventory-prune-with-notice.
  const products = lines
    .filter((l) => l.kind === 'ceramic')
    .map((l) => l.product)
    .filter((p) => !p.sold && !p.showroom);
  // While the DTO is loading or failed, `lines` is empty — fall back to the
  // cart store's own (synchronous) ceramic-shaped id count instead of 0, so
  // an in-flight fetch or a transient error never flashes the bar away or
  // strands it at "0 items" mid-browse. Only the total genuinely needs the
  // resolved products; it settles to the real figure once `status` is ready.
  const ceramicIdCount = ids.filter((id) => !isGiftCardToken(id) && !isPrintToken(id)).length;
  const n = status === 'ready' ? products.length : ceramicIdCount;
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
                  currency: analyticsCurrency,
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
                  currency: analyticsCurrency,
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
