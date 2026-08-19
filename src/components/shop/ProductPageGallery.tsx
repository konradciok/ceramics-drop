'use client';

import { useRef, useState } from 'react';
import { srcSet } from '@/lib/images';
import { stepGalleryIndex } from '@/lib/gallery-nav';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import { GalleryLightbox } from './GalleryLightbox';

type Props = {
  images: string[];
  alt: string;
  /** When this changes, the gallery snaps back to slide 0 (the configurator
      hero) so a variant change is visible from any slide. */
  syncKey?: string;
};

const SWIPE_THRESHOLD = 50;

/** Image gallery for the product detail page: dot nav, swipe (touch), arrow
    keys / chevrons (desktop), and a lightbox for enlarging the current photo. */
export function ProductPageGallery({ images, alt, syncKey }: Props) {
  const t = useTranslations();
  const [index, setIndex] = useState(0);
  // Reset to slide 0 when syncKey changes, adjusting state during render
  // (React's prescribed pattern) instead of useEffect — avoids the extra
  // commit an effect-based reset would cost and satisfies
  // react-hooks/set-state-in-effect.
  const [prevSyncKey, setPrevSyncKey] = useState(syncKey);
  if (syncKey !== prevSyncKey) {
    setPrevSyncKey(syncKey);
    setIndex(0);
  }
  const current = images[index] ?? images[0];
  const hasMultiple = images.length > 1;

  const [lightboxOpen, setLightboxOpen] = useState(false);
  const expandRef = useRef<HTMLButtonElement>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);

  function step(delta: number) {
    setIndex((i) => stepGalleryIndex(i, delta, images.length));
  }

  return (
    <div className="pdp-images">
      <div
        className="pdp-img-main"
        tabIndex={hasMultiple ? 0 : undefined}
        role={hasMultiple ? 'group' : undefined}
        aria-label={hasMultiple ? t('aria.photo') : undefined}
        onKeyDown={(e) => {
          if (!hasMultiple) return;
          if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
          if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
        }}
        // Touch-only swipe: gated on pointerType to avoid accidental mouse drags.
        onPointerDown={(e) => {
          if (!hasMultiple || e.pointerType !== 'touch') return;
          pointerStart.current = { x: e.clientX, y: e.clientY };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerUp={(e) => {
          if (!hasMultiple || e.pointerType !== 'touch' || !pointerStart.current) return;
          const dx = e.clientX - pointerStart.current.x;
          const dy = e.clientY - pointerStart.current.y;
          pointerStart.current = null;
          if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
            step(dx < 0 ? 1 : -1);
          }
        }}
        onPointerCancel={() => { pointerStart.current = null; }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={current}
          src={current}
          srcSet={srcSet(current)}
          sizes="(min-width:861px) min(55vw, 720px), 100vw"
          alt={index === 0 ? alt : ''}
          aria-hidden={index !== 0}
          className="pdp-img-zoomable"
          onClick={() => setLightboxOpen(true)}
        />
        <button
          ref={expandRef}
          type="button"
          className="pdp-img-expand"
          onClick={() => setLightboxOpen(true)}
          aria-label={t('aria.zoom')}
        >
          <Icon name="expand" />
        </button>
        {hasMultiple && (
          <>
            <button
              type="button"
              className="lb-nav lb-prev pdp-img-nav"
              onClick={() => step(-1)}
              disabled={index === 0}
              aria-label={t('aria.prev')}
            >
              <Icon name="chevron-left" />
            </button>
            <button
              type="button"
              className="lb-nav lb-next pdp-img-nav"
              onClick={() => step(1)}
              disabled={index === images.length - 1}
              aria-label={t('aria.next')}
            >
              <Icon name="chevron-right" />
            </button>
          </>
        )}
      </div>
      {hasMultiple && (
        <div className="pdp-img-dots" role="group" aria-label={t('aria.photo')}>
          {images.map((img, i) => (
            <button
              key={img}
              className={`pdp-img-dot${i === index ? ' active' : ''}`}
              onClick={() => setIndex(i)}
              aria-label={`${t('aria.photo')} ${i + 1}`}
              aria-current={i === index}
            />
          ))}
        </div>
      )}
      <GalleryLightbox
        images={images}
        alt={alt}
        index={index}
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        onStep={step}
        onSelect={setIndex}
        triggerRef={expandRef}
      />
    </div>
  );
}
