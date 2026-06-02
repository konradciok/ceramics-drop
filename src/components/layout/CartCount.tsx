'use client';

import { useCart } from '@/store/cart';

/** Terracotta badge on the header cart icon; shows the piece count. */
export function CartCount() {
  const count = useCart((s) => s.ids.length);
  return (
    <span className={`cart-count${count > 0 ? ' show' : ''}`} data-cart-count>
      {count}
    </span>
  );
}
