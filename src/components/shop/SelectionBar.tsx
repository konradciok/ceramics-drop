'use client';

import { useCart } from '@/store/cart';
import { getProductById } from '@/lib/products';
import { euro } from '@/lib/format';
import { Link } from '@/i18n/navigation';
import { Icon } from '@/components/ui/Icon';

/** Sticky bottom bar summarising the current selection. */
export function SelectionBar() {
  const ids = useCart((s) => s.ids);
  const clear = useCart((s) => s.clear);

  const n = ids.length;
  const total = ids.reduce((sum, id) => sum + (getProductById(id)?.price ?? 0), 0);

  return (
    <div className={`selbar${n > 0 ? ' show' : ''}`}>
      <div className="selbar-inner">
        <div className="selbar-info">
          {/* TODO (content): pluralised "n pieces" label */}
          <span className="cnt">
            <em>{n}</em>
          </span>
          <span className="sum">{euro(total)}</span>
        </div>
        <div className="selbar-actions">
          <button className="clear" onClick={clear}>
            Wyczyść
          </button>
          <Link className="go" href="/koszyk">
            Do koszyka <Icon name="arrow" />
          </Link>
        </div>
      </div>
    </div>
  );
}
