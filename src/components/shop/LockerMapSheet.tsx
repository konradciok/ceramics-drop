'use client';

import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Below this width the map takes the whole screen (the lightbox breakpoint). */
export const LOCKER_SHEET_QUERY = '(max-width: 860px)';

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(LOCKER_SHEET_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

/** Whether the viewport is narrow enough for the full-screen sheet. */
function useSheetMode(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(LOCKER_SHEET_QUERY).matches,
    () => false,
  );
}

type Props = {
  /** Shown as the sheet's heading on phones (the same words as the open button). */
  title: string;
  closeLabel: string;
  onClose: () => void;
  /** The map itself (GeowidgetPicker). */
  children: ReactNode;
};

/**
 * The InPost map's frame. On a wide screen it sits inline in the delivery form,
 * as before. On a phone it becomes a full-screen modal sheet: a 75dvh map in the
 * middle of a scrolling page caught the scroll gesture and trapped the buyer in
 * it. The sheet locks the page scroll, closes on Escape, keeps Tab inside and
 * starts with focus on its close button; the caller returns focus to the
 * button that opened it. Tab is kept inside by two focus sentinels rather than
 * a list of focusable elements: the widget renders in its own shadow DOM, where
 * `document.activeElement` is only ever the widget host.
 *
 * The sheet is portalled to <body> so no transformed ancestor can turn its
 * `position: fixed` into a box inside the form. The map mounts only when the
 * buyer opens it, so the portal costs nothing — a breakpoint change while it is
 * open just re-creates the widget.
 */
export function LockerMapSheet({ title, closeLabel, onClose, children }: Props) {
  const sheet = useSheetMode();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!sheet) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    const raf = requestAnimationFrame(() => closeRef.current?.focus());

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [sheet]);

  const frame = (
    <div
      className={`locker-sheet${sheet ? ' is-sheet' : ''}`}
      data-testid="locker-map"
      {...(sheet ? { role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId } : {})}
    >
      {/* Shift+Tab from the close button stays on it. */}
      {sheet && <span className="locker-sheet-sentinel" tabIndex={0} onFocus={() => closeRef.current?.focus()} />}
      <div className="locker-sheet-bar">
        {sheet && (
          <span className="locker-sheet-title" id={titleId}>
            {title}
          </span>
        )}
        <button
          ref={closeRef}
          type="button"
          className="locker-close"
          data-testid="close-locker-map"
          onClick={onClose}
        >
          {closeLabel}
        </button>
      </div>
      {children}
      {/* Tabbing past the map wraps back to the close button. */}
      {sheet && <span className="locker-sheet-sentinel" tabIndex={0} onFocus={() => closeRef.current?.focus()} />}
    </div>
  );

  return sheet ? createPortal(frame, document.body) : frame;
}
