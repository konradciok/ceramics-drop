'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { buildPrintSelectItemEvent, buildPrintViewItemListEvent, pushDataLayer } from '@/lib/analytics';
import type { CurrencyCode } from '@/lib/format';

export type PrintListItem = { id: string; num: string; variantLabel: string; price: number };

/** Client wrapper for the server-rendered print tile grid: view_item_list once
 *  on mount, select_item on tile click. Tiles stay server <Link>s; this only
 *  adds analytics via the container + data-product-id (event delegation). */
export function PrintCollectionAnalytics({
  items,
  listId,
  listName,
  currency,
  children,
}: {
  items: PrintListItem[];
  listId: string;
  listName: string;
  currency: CurrencyCode;
  children: ReactNode;
}) {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current || items.length === 0) return;
    fired.current = true;
    pushDataLayer(buildPrintViewItemListEvent(items, { itemListId: listId, itemListName: listName, currency }));
  }, [items, listId, listName, currency]);

  return (
    <div
      className="print-groups"
      onClick={(e) => {
        const tile = (e.target as HTMLElement).closest('[data-product-id]');
        const id = tile?.getAttribute('data-product-id');
        if (!id) return;
        const index = items.findIndex((i) => i.id === id);
        const item = items[index];
        if (!item) return;
        pushDataLayer(buildPrintSelectItemEvent(item, { index, itemListId: listId, itemListName: listName, currency }));
      }}
    >
      {children}
    </div>
  );
}
