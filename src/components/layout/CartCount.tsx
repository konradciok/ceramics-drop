'use client';

import { useCart } from '@/store/cart';
import { useMounted } from '@/lib/use-mounted';

/** Terracotta badge on the header cart icon; shows the piece count. */
export function CartCount() {
  // Server HTML always renders 0/hidden; showing the persisted count before
  // hydration completes would be a hydration mismatch (SSR has no localStorage).
  const mounted = useMounted();
  const count = useCart((s) => s.ids.length);
  const shown = mounted ? count : 0;
  return (
    <span className={`cart-count${shown > 0 ? ' show' : ''}`} data-cart-count>
      {shown}
    </span>
  );
}
