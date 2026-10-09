'use client';

/* ============================================================
   El Médano landing page — client shell.
   - Lightbox gallery for the showroom pieces (detail card, like the
     shop Lightbox) and the lookbook photos (image-only, like the PDP
     GalleryLightbox). Same lb-* classes, keyboard, focus-trap, scroll
     lock and touch-swipe pattern as those two components.
   - Delegated click tracking: any descendant carrying
     `data-market-track="<engagement_type>"` pushes a `site_engagement`
     event (docs/analytics-stack.md) when clicked.
   ============================================================ */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { buildEngagementEvent, pushDataLayer } from '@/lib/analytics';
import { srcSet } from '@/lib/images';
import { MARKET_ENGAGEMENT } from '@/lib/market-event';
import { Icon } from '@/components/ui/Icon';

export type MarketGalleryItem = {
  /** Stable analytics id (`item_id`). */
  id: string;
  src: string;
  width: number;
  height: number;
  alt: string;
  /** Eyebrow (showroom category) or caption label (photos). */
  label: string;
  /** Showroom piece name. */
  title?: string;
  /** Photo caption. */
  caption?: string;
  /** Showroom detail rows. */
  specs?: { label: string; value: string }[];
};

export type MarketGalleries = {
  showroom: MarketGalleryItem[];
  photos: MarketGalleryItem[];
};

type GalleryKey = keyof MarketGalleries;

const GalleryContext = createContext<((gallery: GalleryKey, index: number, trigger: HTMLElement) => void) | null>(null);

const SWIPE_THRESHOLD = 50;

type Props = {
  galleries: MarketGalleries;
  /** Short note shown under a showroom piece's name in the lightbox. */
  showroomNote: string;
  /** Translated button labels for the lightbox controls. */
  labels: { close: string; prev: string; next: string; photo: string };
  children: ReactNode;
};

export function MarketGalleryProvider({ galleries, showroomNote, labels, children }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const viewed = useRef(new Set<string>());
  const [open, setOpen] = useState(false);
  // Kept after close so the card doesn't empty out during the fade.
  const [current, setCurrent] = useState<{ gallery: GalleryKey; index: number }>({ gallery: 'showroom', index: 0 });

  const items = galleries[current.gallery];
  const item: MarketGalleryItem | undefined = items[current.index] ?? items[0];
  const photoMode = current.gallery === 'photos';

  const trackView = useCallback(
    (gallery: GalleryKey, index: number) => {
      const viewedItem = galleries[gallery][index];
      if (!viewedItem || viewed.current.has(viewedItem.id)) return;
      viewed.current.add(viewedItem.id);
      pushDataLayer(
        buildEngagementEvent(MARKET_ENGAGEMENT.photoView, {
          item_id: viewedItem.id,
          item_name: viewedItem.title ?? viewedItem.label,
          item_category: gallery,
          page_path: window.location.pathname,
        }),
      );
    },
    [galleries],
  );

  const openAt = useCallback(
    (gallery: GalleryKey, index: number, trigger: HTMLElement) => {
      triggerRef.current = trigger;
      setCurrent({ gallery, index });
      setOpen(true);
      trackView(gallery, index);
    },
    [trackView],
  );

  function go(index: number) {
    const n = items.length;
    const next = ((index % n) + n) % n;
    setCurrent({ gallery: current.gallery, index: next });
    trackView(current.gallery, next);
  }

  function close() {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  // Latest handlers for the open-gated keydown listener below.
  const handlers = useRef({ go, close, index: current.index });
  useEffect(() => {
    handlers.current = { go, close, index: current.index };
  });

  // Keyboard (Escape, arrows) + scroll lock + focus management — same pattern as GalleryLightbox.tsx.
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      const h = handlers.current;
      if (e.key === 'Escape') { e.preventDefault(); h.close(); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); h.go(h.index - 1); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); h.go(h.index + 1); return; }
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
  }, [open]);

  // Delegated click tracking for directions / calendar / outbound links.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest<HTMLElement>('[data-market-track]');
      if (!el || !root.contains(el)) return;
      const { marketTrack, placement, method } = el.dataset;
      if (!marketTrack) return;
      pushDataLayer(
        buildEngagementEvent(marketTrack, {
          placement,
          ...(method ? { method } : {}),
          page_path: window.location.pathname,
        }),
      );
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, []);

  return (
    <GalleryContext.Provider value={openAt}>
      <div ref={rootRef} className="market">
        {children}
      </div>

      {item && (
        <>
          <div className={`lb-scrim${open ? ' open' : ''}`} onClick={close} />
          <div
            className={`lb${open ? ' open' : ''}`}
            onClick={(e) => { if (e.target === e.currentTarget) close(); }}
            {...(open
              ? { role: 'dialog', 'aria-modal': 'true', 'aria-label': item.title ?? item.label }
              : { 'aria-hidden': 'true' }
            )}
          >
            <div ref={cardRef} className={`lb-card${photoMode ? ' lb-card-image-only market-lb-photo' : ''}`}>
              <div
                className="lb-img"
                style={photoMode ? undefined : { aspectRatio: `${item.width} / ${item.height}` }}
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
                    go(current.index + (dx < 0 ? 1 : -1));
                  }
                }}
                onPointerCancel={() => { pointerStart.current = null; }}
              >
                <button ref={closeRef} type="button" className="lb-close" onClick={close} aria-label={labels.close}>
                  <Icon name="close" />
                </button>
                <button type="button" className="lb-nav lb-prev" onClick={() => go(current.index - 1)} aria-label={labels.prev}>
                  <Icon name="chevron-left" />
                </button>
                <button type="button" className="lb-nav lb-next" onClick={() => go(current.index + 1)} aria-label={labels.next}>
                  <Icon name="chevron-right" />
                </button>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  key={item.src}
                  src={item.src}
                  srcSet={srcSet(item.src)}
                  sizes="(min-width:861px) min(90vw, 1000px), 100vw"
                  alt={item.alt}
                  draggable={false}
                />
                <div className="lb-dots">
                  {items.map((dot, i) => (
                    <button
                      key={dot.id}
                      type="button"
                      className={`lb-dot${i === current.index ? ' active' : ''}`}
                      onClick={(e) => { e.stopPropagation(); go(i); }}
                      aria-label={`${labels.photo} ${i + 1}`}
                      aria-current={i === current.index}
                    />
                  ))}
                </div>
              </div>

              {photoMode ? (
                <p className="market-lb-caption">
                  <span>{item.label}</span>
                  {item.caption}
                </p>
              ) : (
                <div className="lb-body">
                  <div className="eyebrow">{item.label}</div>
                  <h3>{item.title}</h3>
                  <p className="lb-note">{showroomNote}</p>
                  {item.specs && (
                    <div className="lb-specs">
                      {item.specs.map((spec) => (
                        <div key={spec.label} className="lb-spec">
                          <span className="k">{spec.label}</span>
                          <span>{spec.value}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </GalleryContext.Provider>
  );
}

type TriggerProps = {
  gallery: GalleryKey;
  index: number;
  className?: string;
  label: string;
  children: ReactNode;
};

/** Button that opens the page lightbox at `gallery[index]`. */
export function GalleryTrigger({ gallery, index, className, label, children }: TriggerProps) {
  const openAt = useContext(GalleryContext);
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      onClick={(e) => openAt?.(gallery, index, e.currentTarget)}
    >
      {children}
    </button>
  );
}
