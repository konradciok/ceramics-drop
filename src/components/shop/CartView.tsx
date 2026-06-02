'use client';

import { useCart } from '@/store/cart';

/**
 * Cart / checkout screen.
 * Content phase: item rows, order summary, shipping options, the
 * (stubbed) checkout flow and confirmation — see design/assets/shop.js.
 */
export function CartView() {
  const count = useCart((s) => s.ids.length);

  return (
    <div className="cart-wrap">
      <div>
        <div className="cart-head">
          <div className="eyebrow" />
          {/* TODO (content): "Koszyk — n prac" */}
          <h1>Koszyk</h1>
        </div>
        <div className="cart-list" data-count={count} />
      </div>
      <aside className="summary" />
    </div>
  );
}
