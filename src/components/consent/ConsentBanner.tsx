'use client';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import {
  CONSENT_OPEN_EVENT,
  choiceEffect,
  isBannerVisible,
  readConsent,
  setConsent,
  type BannerMode,
  type ConsentValue,
} from './consent-mode';

// The cookie isn't an external store that pushes updates, so the subscribe is a
// no-op; useSyncExternalStore is used purely to read a client-only value without
// a hydration mismatch (server snapshot = null) and without set-state-in-effect.
const noopSubscribe = () => () => {};

// Measure before paint so the selbar never renders one frame at bottom:0 (under
// the banner) on a first visit. Falls back to useEffect on the server to avoid
// React's "useLayoutEffect does nothing on the server" warning.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/** Gap kept between the banner's top edge and whatever must stay clear of it. */
const GAP = 12;

/**
 * Lift every `[data-consent-clear]` element (the home hero copy) so its content
 * ends above the banner on the first screen. Measured against the fold, not the
 * element's container, because the hero can end below the fold on short
 * viewports. Applied with a transform, which — unlike a padding or margin
 * change — is not a layout shift (CLS). Capped at the element's offset in its
 * container so it never rises past the hero's top.
 *
 * The value is published as `--consent-lift` on the target's parent, so
 * siblings can follow it (the hero scrim darkens higher up with the copy).
 */
function liftClearTargets(bannerTop: number) {
  document.querySelectorAll<HTMLElement>('[data-consent-clear]').forEach((target) => {
    const host = target.parentElement ?? target;
    const container = target.offsetParent ?? host;
    // Untransformed geometry on the first screen (offsetTop/offsetHeight ignore
    // the lift, even mid-transition), in page coordinates so scroll is irrelevant.
    const contentBottom =
      container.getBoundingClientRect().top + window.scrollY +
      target.offsetTop + target.offsetHeight - parseFloat(getComputedStyle(target).paddingBottom);
    const lift = Math.min(Math.max(0, contentBottom - (bannerTop - GAP)), target.offsetTop);
    host.style.setProperty('--consent-lift', `${Math.round(lift)}px`);
  });
}

function resetClearTargets() {
  document.querySelectorAll<HTMLElement>('[data-consent-clear]').forEach((target) => {
    (target.parentElement ?? target).style.removeProperty('--consent-lift');
  });
}

export function ConsentBanner() {
  const t = useTranslations('consent');
  const [mode, setMode] = useState<BannerMode>('auto');
  const stored = useSyncExternalStore(
    noopSubscribe,
    () => readConsent(document.cookie),
    () => null,
  );
  const ref = useRef<HTMLDivElement>(null);
  // Where focus was when "Cookie settings" reopened the banner, so closing it
  // returns the keyboard user there instead of to <body>.
  const opener = useRef<HTMLElement | null>(null);
  const visible = isBannerVisible(mode, stored);
  const reopened = mode === 'reopened';
  // Re-measure after a client-side navigation: the page (and any
  // `[data-consent-clear]` target) changes under the persistent layout.
  const pathname = usePathname();

  // Publish the banner's occupied bottom height to `--consent-h` so the selbar
  // (fixed, bottom-left overlap on collection pages) can sit above it, and lift
  // `[data-consent-clear]` targets (the home hero CTA) clear of it. Both are
  // zeroed on cleanup — the component returns null once dismissed.
  useIsoLayoutEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!el) { root.style.setProperty('--consent-h', '0px'); return; }
    const apply = () => {
      const rect = el.getBoundingClientRect();
      // distance from the viewport bottom up to the banner's top edge (the height
      // it occupies, incl. its safe-area margin) + a 12px breathing gap so the
      // selbar pill never butts up against the banner.
      const h = window.innerHeight - rect.top + GAP;
      root.style.setProperty('--consent-h', `${Math.max(0, Math.round(h))}px`);
      liftClearTargets(rect.top);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    window.addEventListener('resize', apply);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', apply);
      root.style.setProperty('--consent-h', '0px');
      resetClearTargets();
    };
  }, [visible, pathname]);

  // "Cookie settings" (footer, privacy policy) reopens the banner from any page.
  useEffect(() => {
    const onOpen = () => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setMode('reopened');
    };
    window.addEventListener(CONSENT_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(CONSENT_OPEN_EVENT, onOpen);
  }, []);

  // Move focus into a reopened banner: it renders at the end of <body>, far
  // from the footer link that opened it.
  useEffect(() => {
    if (reopened) ref.current?.focus();
  }, [reopened]);

  const close = () => {
    setMode('closed');
    if (opener.current?.isConnected) opener.current.focus();
    opener.current = null;
  };

  if (!visible) return null;
  const choose = (v: ConsentValue) => {
    // Read the cookie now, not the render snapshot: it is the choice in force.
    const effect = choiceEffect(readConsent(document.cookie), v);
    if (effect.persist) setConsent(v);
    if (effect.reload) {
      // Withdrawal: unload the tags this page view already loaded (see
      // choiceEffect). The banner stays up until the reload replaces the page.
      window.location.reload();
      return;
    }
    close();
  };
  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby="consent-title"
      className="consent"
      data-reopened={reopened || undefined}
      tabIndex={-1}
      onKeyDown={reopened ? (e) => { if (e.key === 'Escape') close(); } : undefined}
    >
      {reopened && (
        <button type="button" onClick={close} className="consent-close" aria-label={t('close')}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      )}
      <p id="consent-title" className="consent-title">{t('title')}</p>
      {/* The privacy link closes the body text rather than sharing the button
          row: on a phone the row then fits on one line, which keeps the banner
          short enough that the hero CTA above it stays visible and tappable. */}
      <p className="consent-body">
        {t('body')}{' '}
        <Link href="/polityka-prywatnosci" className="consent-more">{t('more')}</Link>
      </p>
      {reopened && stored !== null && (
        <p className="consent-current">{t(stored === 'granted' ? 'currentGranted' : 'currentDenied')}</p>
      )}
      <div className="consent-actions">
        <button onClick={() => choose('granted')} className="consent-btn consent-accept">{t('accept')}</button>
        <button onClick={() => choose('denied')} className="consent-btn consent-reject">{t('reject')}</button>
      </div>
    </div>
  );
}
