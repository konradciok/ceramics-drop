'use client';

/* ============================================================
   PrintShop — the /sklep toolbar + grid island.
   The server renders EVERY design (so all PDP links are in the HTML for
   crawlers and the page works without JS) and passes the view parsed from the
   query string; this island applies the same pure applyShopView() and keeps
   the URL in sync with history.replaceState (no history spam, shareable
   links). Editorial bands (how it works, gift card) arrive as server-rendered
   nodes and only show while nothing is filtered.
   ============================================================ */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useCurrency } from '@/components/currency/CurrencyProvider';
import { toChargeableCurrency } from '@/lib/currency';
import { currencyFormatter } from '@/lib/format';
import { fromPriceOf, type PrintPricingConfig } from '@/lib/print-pricing';
import { variantLabel } from '@/lib/print-cart';
import type { PrintCollectionDefinition } from '@/lib/print-curation';
import { buildEngagementEvent, pushDataLayer } from '@/lib/analytics';
import {
  applyShopView,
  hasActiveFilters,
  serializeShopView,
  SHOP_COLOURS,
  SHOP_SORTS,
  type ShopColour,
  type ShopSort,
  type ShopView,
} from '@/lib/print-shop';
import type { PrintVariantSelection } from '@/lib/types';
import type { Locale } from '@/i18n/routing';
import { PrintCollectionAnalytics, type PrintListItem } from './PrintCollectionAnalytics';
import { PrintShopCard, type PrintShopItem } from './PrintShopCard';

export type { PrintShopItem } from './PrintShopCard';

export interface ShopCollectionOption {
  slug: string;
  name: string;
  count: number;
}

export interface ShopPromo {
  key: string;
  /** Rendered after this many cards (only while no filter is active and the list is at least that long). */
  after: number;
  node: ReactNode;
}

export function PrintShop({
  items,
  initialView,
  collections,
  promos,
  pricing,
  definitions,
}: {
  items: PrintShopItem[];
  initialView: ShopView;
  collections: ShopCollectionOption[];
  promos: ShopPromo[];
  pricing: PrintPricingConfig;
  definitions: PrintCollectionDefinition[];
}) {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const currency = useCurrency();
  const printCurrency = toChargeableCurrency(currency);
  const { fmt, code: analyticsCurrency } = currencyFormatter(printCurrency);

  const [view, setView] = useState<ShopView>(initialView);
  const visible = useMemo(() => applyShopView(items, view), [items, view]);
  const filtered = hasActiveFilters(view);

  const commit = useCallback((next: ShopView, event: { name: 'shop_filter' | 'shop_sort'; type: string; value: string }) => {
    setView(next);
    const qs = serializeShopView(next);
    window.history.replaceState(window.history.state, '', qs ? `?${qs}` : window.location.pathname);
    pushDataLayer(buildEngagementEvent(event.name, { filter_type: event.type, filter_value: event.value }));
  }, []);

  const toggleColour = (colour: ShopColour) => {
    const on = view.colours.includes(colour);
    commit(
      { ...view, colours: on ? view.colours.filter((c) => c !== colour) : [...view.colours, colour] },
      { name: 'shop_filter', type: 'colour', value: on ? `-${colour}` : colour },
    );
  };
  const setCollection = (slug: string) =>
    commit(
      { ...view, collection: slug || undefined },
      { name: 'shop_filter', type: 'collection', value: slug || 'all' },
    );
  const setSort = (sort: ShopSort) => commit({ ...view, sort }, { name: 'shop_sort', type: 'sort', value: sort });
  const clear = () => commit({ sort: view.sort, colours: [] }, { name: 'shop_filter', type: 'clear', value: 'all' });

  // Colour chip counts respect the collection filter (a chip that would show
  // nothing is disabled) but not the colour selection itself.
  const colourCounts = useMemo(() => {
    const scoped = view.collection ? items.filter((i) => i.collectionSlug === view.collection) : items;
    return Object.fromEntries(SHOP_COLOURS.map((c) => [c, scoped.filter((i) => i.colours.includes(c)).length])) as Record<ShopColour, number>;
  }, [items, view.collection]);
  const offeredColours = SHOP_COLOURS.filter((c) => items.some((i) => i.colours.includes(c)));

  // Analytics index space = what is on screen right now (select_item reads it at click time).
  const analyticsItems: PrintListItem[] = visible.map((i) => {
    const sel: PrintVariantSelection = { size: i.design.sizes[0], framed: false, mount: false, frameColour: 'none' };
    return {
      id: i.id,
      num: i.design.num,
      variantLabel: variantLabel(sel, locale),
      price: fromPriceOf(i.design, printCurrency, pricing),
      itemName: i.name,
    };
  });

  const showPromos = !filtered;
  const cards: ReactNode[] = [];
  visible.forEach((item, index) => {
    cards.push(
      <PrintShopCard
        key={item.id}
        item={item}
        priceLabel={t('print.from', { price: fmt(fromPriceOf(item.design, printCurrency, pricing)) })}
        pricing={pricing}
        definitions={definitions}
      />,
    );
    if (showPromos) {
      for (const promo of promos) {
        if (promo.after === index + 1) {
          cards.push(
            <div key={promo.key} className="shop-promo" data-testid={`shop-promo-${promo.key}`}>
              {promo.node}
            </div>,
          );
        }
      }
    }
  });

  return (
    // The wrapper scopes the sticky toolbar to the listing: it un-sticks when
    // the grid ends instead of trailing the editorial sections below.
    <div className="shop-listing">
      <div id="shop-toolbar" className="shop-nav-sticky shop-toolbar" role="region" aria-label={t('shop.filtersLabel')}>
        <div className="shop-nav-track shop-toolbar-inner">
          <div className="shop-toolbar-colours">
            <span className="shop-toolbar-label" id="shop-colour-label">{t('shop.colourLabel')}</span>
            <div className="shop-switch" role="group" aria-labelledby="shop-colour-label">
              {offeredColours.map((c) => {
                const on = view.colours.includes(c);
                const disabled = !on && colourCounts[c] === 0;
                return (
                  <button
                    key={c}
                    type="button"
                    className={`shop-chip${on ? ' on' : ''}`}
                    aria-pressed={on}
                    disabled={disabled}
                    data-testid={`filter-colour-${c}`}
                    onClick={() => toggleColour(c)}
                  >
                    <i className="shop-dot" data-colour={c} aria-hidden="true" />
                    {t(`shop.colour.${c}`)}
                    <span className="shop-chip-count">{colourCounts[c]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="shop-toolbar-controls">
            <label className="shop-select">
              <span className="shop-toolbar-label">{t('shop.collectionLabel')}</span>
              <select
                value={view.collection ?? ''}
                onChange={(e) => setCollection(e.target.value)}
                data-testid="filter-collection"
              >
                <option value="">{t('shop.allCollections')}</option>
                {collections.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.name} ({c.count})
                  </option>
                ))}
              </select>
            </label>
            <label className="shop-select">
              <span className="shop-toolbar-label">{t('shop.sortLabel')}</span>
              <select value={view.sort} onChange={(e) => setSort(e.target.value as ShopSort)} data-testid="sort-select">
                {SHOP_SORTS.map((s) => (
                  <option key={s} value={s}>
                    {t(`shop.sort.${s}`)}
                  </option>
                ))}
              </select>
            </label>
            <span className="shop-count" role="status" aria-live="polite" data-testid="shop-count">
              {t('home.collectionsCount', { count: visible.length })}
            </span>
            {filtered && (
              <button type="button" className="shop-clear" onClick={clear} data-testid="filter-clear">
                {t('shop.clear')}
              </button>
            )}
          </div>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="shop-empty" data-testid="shop-empty">
          <p>{t('shop.empty')}</p>
          <div className="shop-empty-actions">
            <button type="button" className="btn btn-primary" onClick={clear}>
              {t('shop.clear')}
            </button>
            <Link href="/kolekcje" className="btn btn-ghost">
              {t('shop.emptyCta')}
            </Link>
          </div>
        </div>
      ) : (
        <PrintCollectionAnalytics items={analyticsItems} listId="fine-art-prints" listName="fine-art-prints" currency={analyticsCurrency}>
          <div className="gallery shop-grid" data-count={visible.length}>
            {cards}
          </div>
        </PrintCollectionAnalytics>
      )}
    </div>
  );
}
