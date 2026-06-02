'use client';

import { useTranslations } from 'next-intl';
import { useCart } from '@/store/cart';
import { resolveCartProducts } from '@/lib/products';
import { euro } from '@/lib/format';
import { Link } from '@/i18n/navigation';
import { Icon } from '@/components/ui/Icon';

/** Sticky bottom bar summarising the current selection. */
export function SelectionBar() {
  const t = useTranslations();
  const ids = useCart((s) => s.ids);
  const clear = useCart((s) => s.clear);

  const products = resolveCartProducts(ids);
  const n = products.length;
  const total = products.reduce((sum, p) => sum + p.price, 0);

  return (
    <div className={`selbar${n > 0 ? ' show' : ''}`}>
      <div className="selbar-inner">
        <div className="selbar-info">
          <span className="cnt">
            <em>{n}</em> {t('selbar.word', { count: n })}
          </span>
          <span className="sum">{`${t('selbar.total')} ${euro(total)}`}</span>
        </div>
        <div className="selbar-actions">
          <button className="clear" onClick={clear}>
            {t('selbar.clear')}
          </button>
          <Link className="go" href="/koszyk">
            {t('selbar.go')} <Icon name="arrow" />
          </Link>
        </div>
      </div>
    </div>
  );
}
