'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { srcSet } from '@/lib/images';
import { Icon } from '@/components/ui/Icon';

type Props = {
  images: string[];
  alt: string;
  index: number;
  open: boolean;
  onClose: () => void;
  onStep: (delta: number) => void;
  onSelect: (index: number) => void;
  /** The element that triggered opening; focus returns here on close. */
  triggerRef: React.RefObject<HTMLElement | null>;
};

const SWIPE_THRESHOLD = 50;

/** Full-screen image-only paging viewer for the PDP gallery (enlarge + swipe/arrow nav). */
export function GalleryLightbox({ images, alt, index, open, onClose, onStep, onSelect, triggerRef }: Props) {
  const t = useTranslations();
  const cardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const hasMultiple = images.length > 1;
  const current = images[index] ?? images[0];

  function handleClose() {
    onClose();
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  // Keyboard (Escape, arrows) + scroll lock + focus management — same pattern as Lightbox.tsx.
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); handleClose(); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); onStep(-1); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); onStep(1); return; }
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

    requestAnimationFrame(() => closeRef.current?.focus());

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
    // handleClose/onStep are stable enough for this effect's lifetime (open-gated)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      <div className={`lb-scrim${open ? ' open' : ''}`} onClick={handleClose} />
      <div
        className={`lb${open ? ' open' : ''}`}
        onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
        {...(open
          ? { role: 'dialog', 'aria-modal': 'true', 'aria-label': alt }
          : { 'aria-hidden': 'true' }
        )}
      >
        <div ref={cardRef} className="lb-card lb-card-image-only">
          <div
            className="lb-img"
            // Touch-only swipe: gated on pointerType to avoid accidental mouse drags.
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
              if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
                onStep(dx < 0 ? 1 : -1);
              }
            }}
            onPointerCancel={() => { pointerStart.current = null; }}
          >
            <button ref={closeRef} className="lb-close" onClick={handleClose} aria-label={t('aria.close')}>
              <Icon name="close" />
            </button>
            {hasMultiple && (
              <>
                <button
                  className="lb-nav lb-prev"
                  onClick={() => onStep(-1)}
                  disabled={index === 0}
                  aria-label={t('aria.prev')}
                >
                  <Icon name="chevron-left" />
                </button>
                <button
                  className="lb-nav lb-next"
                  onClick={() => onStep(1)}
                  disabled={index === images.length - 1}
                  aria-label={t('aria.next')}
                >
                  <Icon name="chevron-right" />
                </button>
              </>
            )}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={current}
              src={current}
              srcSet={srcSet(current)}
              sizes="(min-width:861px) min(90vw, 1000px), 100vw"
              alt={index === 0 ? alt : ''}
              draggable={false}
            />
            {hasMultiple && (
              <div className="lb-dots">
                {images.map((img, i) => (
                  <button
                    key={img}
                    className={`lb-dot${i === index ? ' active' : ''}`}
                    onClick={(e) => { e.stopPropagation(); onSelect(i); }}
                    aria-label={`${t('aria.photo')} ${i + 1}`}
                    aria-current={i === index}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
