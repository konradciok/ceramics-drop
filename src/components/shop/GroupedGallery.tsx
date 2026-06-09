'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Product, CategorySlug } from '@/lib/types';
import { CATEGORIES, CATEGORY_ORDER } from '@/lib/products';
import { buildSelectItemEvent, buildViewItemListEvent, pushDataLayer } from '@/lib/analytics';
import { ProductTile } from './ProductTile';
import { Lightbox } from './Lightbox';
import { SelectionBar } from './SelectionBar';

type Props = {
  /** All products, already in CATEGORY_ORDER / num order, sold flag merged. */
  products: Product[];
};

/**
 * All-pieces gallery: one grid per category, but a single flat lightbox +
 * selection bar so the lightbox steps across the whole catalogue. The sticky
 * category nav (#shop-nav, rendered by AllPiecesScreen) is driven via a
 * scroll-spy that toggles aria-current on its links.
 */
export function GroupedGallery({ products }: Props) {
  const t = useTranslations();

  // Flat list of purchasable pieces — index space shared by the lightbox and
  // the select_item analytics event (matches the per-category Gallery).
  const available = useMemo(() => products.filter((p) => !p.sold), [products]);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Group products by category, preserving CATEGORY_ORDER and dropping empty
  // categories (defensive — the June catalogue fills all eight).
  const groups = useMemo(() => {
    const byCat = new Map<CategorySlug, Product[]>();
    for (const p of products) {
      const list = byCat.get(p.category) ?? [];
      list.push(p);
      byCat.set(p.category, list);
    }
    return CATEGORY_ORDER
      .map((slug) => ({ slug, items: byCat.get(slug) ?? [] }))
      .filter((g) => g.items.length > 0);
  }, [products]);

  useEffect(() => {
    if (available.length === 0) return;
    pushDataLayer(
      buildViewItemListEvent(available, { itemListId: 'sklep', itemListName: 'sklep' }),
    );
  }, [available]);

  // Scroll-spy: mark the category whose section is nearest the top as current.
  useEffect(() => {
    const sections = groups
      .map((g) => document.getElementById(g.slug))
      .filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;

    const setCurrent = (slug: string) => {
      document.querySelectorAll('#shop-nav a').forEach((a) => {
        const isCurrent = a.getAttribute('href') === `#${slug}`;
        if (isCurrent) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      });
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setCurrent(visible[0].target.id);
      },
      // Bias the "active" band to just under the sticky header + nav.
      { rootMargin: '-160px 0px -60% 0px', threshold: 0 },
    );
    sections.forEach((s) => observer.observe(s));
    return () => observer.disconnect();
  }, [groups]);

  const step = (delta: number) =>
    setOpenIndex((i) =>
      i === null ? i : (i + delta + available.length) % available.length,
    );

  const openTile = (prod: Product) => {
    triggerRef.current = document.activeElement as HTMLElement;
    const index = available.findIndex((a) => a.id === prod.id);
    pushDataLayer(
      buildSelectItemEvent(prod, { index, itemListId: 'sklep', itemListName: 'sklep' }),
    );
    setOpenIndex(index);
  };

  return (
    <>
      {groups.map(({ slug, items }) => (
        <section key={slug} id={slug} className="gallery-group">
          <h2 className="gallery-group-head">{t(CATEGORIES[slug].nameKey)}</h2>
          <div className="gallery" data-count={items.length}>
            {items.map((p) => (
              <ProductTile key={p.id} product={p} onOpen={openTile} />
            ))}
          </div>
        </section>
      ))}

      <Lightbox
        products={available}
        index={openIndex}
        onClose={() => setOpenIndex(null)}
        onStep={step}
        triggerRef={triggerRef}
      />
      <SelectionBar />
    </>
  );
}
