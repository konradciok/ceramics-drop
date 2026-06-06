'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useCart } from '@/store/cart';
import { Icon } from '@/components/ui/Icon';
import { pln } from '@/lib/format';
import { CATEGORIES } from '@/lib/products';
import {
  buildAddToCartEvent,
  buildRemoveFromCartEvent,
  buildViewItemEvent,
  pushDataLayer,
} from '@/lib/analytics';
import { srcSet } from '@/lib/images';
import type { Product } from '@/lib/types';

type Props = {
  /** Available (unsold) pieces the lightbox can page through. */
  products: Product[];
  /** Index into `products`, or null when closed. */
  index: number | null;
  onClose: () => void;
  onStep: (delta: number) => void;
  /** The element that triggered opening; focus returns here on close. */
  triggerRef: React.RefObject<HTMLElement | null>;
};

/** Product detail popup with keyboard, swipe, and focus-trap support. */
export function Lightbox({ products, index, onClose, onStep, triggerRef }: Props) {
  const t = useTranslations();
  const ids = useCart((s) => s.ids);
  const add = useCart((s) => s.add);
  const remove = useCart((s) => s.remove);

  const open = index !== null;
  const product = open ? products[index] : undefined;
  const inCart = product ? ids.includes(product.id) : false;

  const cat = product ? CATEGORIES[product.category] : undefined;
  const name = cat ? t(`product.${cat.singularKey}`) : '';
  const rawNotes = product ? (t.raw(`notes.${product.category}`) as unknown) : undefined;
  const note = product && Array.isArray(rawNotes) ? (rawNotes[product.noteIndex] as string) ?? '' : '';

  const cardRef = useRef<HTMLDivElement>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);

  // Analytics: fire view_item on each index change
  useEffect(() => {
    if (!product) return;
    pushDataLayer(
      buildViewItemEvent(product, {
        index: index ?? undefined,
        itemListId: product.category,
        itemListName: product.category,
      }),
    );
  }, [index, product]);

  // Keyboard (Escape) + scroll lock + focus management
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); handleClose(); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); onStep(-1); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); onStep(1); return; }
      // Focus trap
      if (e.key !== 'Tab' || !cardRef.current) return;
      const focusable = cardRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const els = Array.from(focusable);
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);

    // Move focus into the card
    requestAnimationFrame(() => {
      const firstBtn = cardRef.current?.querySelector<HTMLElement>('button');
      firstBtn?.focus();
    });

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
    // handleClose is stable (defined below with useCallback pattern via ref)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleClose() {
    onClose();
    // Return focus to the triggering tile button
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <>
      <div className={`lb-scrim${open ? ' open' : ''}`} onClick={handleClose} />
      <div
        className={`lb${open ? ' open' : ''}`}
        onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
        {...(open
          ? { role: 'dialog', 'aria-modal': 'true', 'aria-label': product ? `${name} Nº ${product.num}` : '' }
          : { 'aria-hidden': 'true' }
        )}
      >
        {product && (
          <div ref={cardRef} className="lb-card">
            <div
              className="lb-img"
              // Touch-only swipe: gated on pointerType to avoid accidental mouse drags
              onPointerDown={(e) => {
                if (e.pointerType !== 'touch') return;
                if ((e.target as HTMLElement).closest('button')) return;
                pointerStart.current = { x: e.clientX, y: e.clientY };
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              }}
              onPointerUp={(e) => {
                if (e.pointerType !== 'touch' || !pointerStart.current) return;
                const dx = e.clientX - pointerStart.current.x;
                const dy = e.clientY - pointerStart.current.y;
                pointerStart.current = null;
                if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
                  onStep(dx < 0 ? 1 : -1);
                }
              }}
              onPointerCancel={() => { pointerStart.current = null; }}
            >
              <button className="lb-close" onClick={handleClose} aria-label={t('aria.close')}>
                <Icon name="close" />
              </button>
              <button className="lb-nav lb-prev" onClick={() => onStep(-1)} aria-label={t('aria.prev')}>
                <Icon name="chevron-left" />
              </button>
              <button className="lb-nav lb-next" onClick={() => onStep(1)} aria-label={t('aria.next')}>
                <Icon name="chevron-right" />
              </button>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={product.image} srcSet={srcSet(product.image)} sizes="(min-width:861px) min(50vw, 460px), 100vw" alt={`${name} Nº ${product.num}`} draggable={false} />
            </div>
            <div className="lb-body">
              <div className="eyebrow lb-eyebrow">
                {cat ? `${t(cat.nameKey)} — ${t('lightbox.drop')}` : ''}
              </div>
              <h3>{name} <em>Nº {product.num}</em></h3>
              <div className="lb-price">{pln(product.price)}</div>
              <p className="lb-note">{note}</p>
              <div className="lb-specs">
                <div className="lb-spec">
                  <span className="k">{t('lightbox.specDims')}</span>
                  <span className="v">{`${t('lightbox.approx')} ${product.measure}`}</span>
                </div>
                <div className="lb-spec">
                  <span className="k">{t('lightbox.specTech')}</span>
                  <span className="v">{t('lightbox.specTechVal')}</span>
                </div>
                <div className="lb-spec">
                  <span className="k">{t('lightbox.specCopy')}</span>
                  <span className="v">{t('lightbox.specCopyVal')}</span>
                </div>
              </div>
              <button
                className={`btn btn-primary lb-add${inCart ? ' in' : ''}`}
                onClick={() => {
                  const wasPresent = useCart.getState().ids.includes(product.id);
                  if (inCart) { remove(product.id); } else { add(product.id); }
                  const isPresent = useCart.getState().ids.includes(product.id);
                  if (wasPresent !== isPresent) {
                    pushDataLayer(isPresent ? buildAddToCartEvent(product) : buildRemoveFromCartEvent(product));
                  }
                }}
              >
                {inCart ? t('lightbox.in') : t('lightbox.add')}
                <Icon name={inCart ? 'check' : 'arrow'} className="btn-arrow" />
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
