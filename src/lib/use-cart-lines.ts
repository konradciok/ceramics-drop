'use client';

import { useEffect, useState } from 'react';
import type { CartLine } from './cart-lines-server';
import type { Locale } from '@/i18n/routing';

export type CartLinesState = { status: 'loading' | 'ready' | 'error'; lines: CartLine[] };

/**
 * Server-side, DB-aware resolution of cart ids to renderable line data (S2b)
 * — replaces the old synchronous client-side resolveCartLines() + a
 * manually prop-drilled knownProducts fallback map. `ids` is expected to be
 * the useCart store's own ids array (referentially stable across renders
 * unless the cart actually changes); keyed on the joined string rather than
 * the array reference so this stays robust either way, matching this
 * codebase's own `cartKey`/`promoSyncKey` convention (see CartView.tsx).
 */
const EMPTY_STATE: CartLinesState = { status: 'ready', lines: [] };
const INITIAL_LOADING_STATE: CartLinesState = { status: 'loading', lines: [] };

export function useCartLines(ids: string[], locale: Locale = 'pl'): CartLinesState {
  const key = `${ids.join('|')}|${locale}`;
  const hasIds = ids.length > 0;
  const [asyncState, setAsyncState] = useState<CartLinesState>(INITIAL_LOADING_STATE);
  // Reset to 'loading' the moment `key` changes, adjusting state during
  // render (React's prescribed pattern — see ProductPageGallery.tsx's
  // identical syncKey reset) instead of useEffect: avoids the extra commit
  // an effect-based reset would cost and satisfies react-hooks/set-state-in-effect.
  const [prevKey, setPrevKey] = useState(key);
  if (key !== prevKey) {
    setPrevKey(key);
    setAsyncState(INITIAL_LOADING_STATE);
  }
  useEffect(() => {
    // An empty cart needs no fetch — its state is the constant EMPTY_STATE,
    // computed below during render, not stored/set here.
    if (!hasIds) return;
    let cancelled = false;
    fetch(`/api/cart-lines?ids=${ids.map(encodeURIComponent).join(',')}&locale=${encodeURIComponent(locale)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('cart_lines_unavailable'))))
      .then(({ lines }: { lines: CartLine[] }) => {
        if (cancelled) return;
        setAsyncState({ status: 'ready', lines });
      })
      .catch(() => {
        if (cancelled) return;
        setAsyncState({ status: 'error', lines: [] });
      });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on `key`, not `ids` (see doc comment)
  }, [key, hasIds]);
  return hasIds ? asyncState : EMPTY_STATE;
}
