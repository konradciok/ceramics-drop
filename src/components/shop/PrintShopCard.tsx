'use client';

/* ============================================================
   PrintShopCard — one print tile on /sklep.
   Link + image (framed mockup), an on-hover room shot (fetched on first
   hover/focus, never up front), badges, name/collection/"from" price and a
   "+" that opens the quick size/frame picker. The link and the picker
   button are siblings — a <button> must not sit inside an <a>.
   `data-testid="print-tile"` + `data-product-id` stay on the link: the
   list analytics delegate on them and e2e specs click them.
   ============================================================ */
import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { srcSet } from '@/lib/images';
import { buildEngagementEvent, pushDataLayer } from '@/lib/analytics';
import type { PrintPricingConfig } from '@/lib/print-pricing';
import type { PrintCollectionDefinition } from '@/lib/print-curation';
import type { PrintDesign } from '@/lib/types';
import type { ShopFilterable } from '@/lib/print-shop';

// Loaded on first open only: keeps the configurator + dialog out of the first paint.
const PrintQuickAdd = dynamic(() => import('./PrintQuickAdd'), { ssr: false });

export interface PrintShopItem extends ShopFilterable {
  id: string;
  /** Full design — the quick picker needs its sizes/frames/availability. */
  design: PrintDesign;
  name: string;
  /** Listing image (framed-natural mockup, or the plain artwork). */
  image: string;
  /** Room/lifestyle shot revealed on hover; absent = no swap. */
  hoverImage?: string;
  collectionName?: string;
  isNew: boolean;
  isFeatured: boolean;
  /** Variant keys with a usable asset; undefined = not gated (fail-open, checkout is the hard gate). */
  usableKeys?: string[];
}

export function PrintShopCard({
  item,
  priceLabel,
  pricing,
  definitions,
}: {
  item: PrintShopItem;
  priceLabel: string;
  pricing: PrintPricingConfig;
  definitions: PrintCollectionDefinition[];
}) {
  const t = useTranslations();
  const [hoverReady, setHoverReady] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const frames = item.design.frameColours;

  return (
    <>
    <article className="tile tile-print shop-card" data-testid="shop-card">
      <Link
        href={`/fine-art-prints/${item.id}`}
        className="shop-card-link"
        data-product-id={item.id}
        data-testid="print-tile"
        aria-label={item.name}
        onPointerEnter={() => setHoverReady(true)}
        onFocus={() => setHoverReady(true)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.image}
          srcSet={srcSet(item.image)}
          sizes="(min-width:1101px) 25vw, (min-width:561px) 33vw, 50vw"
          alt={item.name}
          loading="lazy"
          width={700}
          height={1000}
        />
        {item.hoverImage && hoverReady && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="shop-card-hover"
            src={item.hoverImage}
            srcSet={srcSet(item.hoverImage)}
            sizes="(min-width:1101px) 25vw, (min-width:561px) 33vw, 50vw"
            alt=""
            aria-hidden="true"
            loading="lazy"
          />
        )}
        {(item.isNew || item.isFeatured) && (
          <span className="shop-badges">
            {item.isFeatured && <span className="shop-badge shop-badge-pick">{t('shop.badgePick')}</span>}
            {item.isNew && <span className="shop-badge">{t('shop.badgeNew')}</span>}
          </span>
        )}
      </Link>

      <button
        type="button"
        className="shop-card-quick"
        aria-label={`${t('shop.quickAdd')}: ${item.name}`}
        aria-haspopup="dialog"
        data-testid="quick-add-open"
        onClick={() => {
          pushDataLayer(buildEngagementEvent('print_quick_add_open', { item_id: item.id }));
          setQuickOpen(true);
        }}
      >
        <span aria-hidden="true">+</span>
      </button>

      <div className="tile-meta shop-card-meta">
        <span className="nm">{item.name}</span>
        <span className="pr">{priceLabel}</span>
        {frames.length > 0 && (
          <span
            className="shop-frame-dots"
            role="img"
            aria-label={t('shop.frameColoursLabel', { colours: frames.map((c) => t(`print.colour_${c}`)).join(', ') })}
          >
            {frames.map((c) => (
              <i key={c} data-frame={c} aria-hidden="true" />
            ))}
          </span>
        )}
      </div>

    </article>
    {/* Sibling of the article, not a child: the tile clips overflow and uses
        content-visibility, neither of which the modal should inherit. */}
    {quickOpen && (
      <PrintQuickAdd
        design={item.design}
        name={item.name}
        image={item.image}
        usableVariantKeys={item.usableKeys}
        pricing={pricing}
        definitions={definitions}
        onClose={() => setQuickOpen(false)}
      />
    )}
    </>
  );
}
