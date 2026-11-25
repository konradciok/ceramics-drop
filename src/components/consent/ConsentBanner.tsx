'use client';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { readConsent, setConsent } from './consent-mode';

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
  const [dismissed, setDismissed] = useState(false);
  const stored = useSyncExternalStore(
    noopSubscribe,
    () => readConsent(document.cookie),
    () => null,
  );
  const ref = useRef<HTMLDivElement>(null);
  const visible = !dismissed && stored === null;
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

  if (!visible) return null;
  const choose = (v: 'granted' | 'denied') => { setConsent(v); setDismissed(true); };
  return (
    <div ref={ref} role="dialog" aria-labelledby="consent-title" className="consent">
      <p id="consent-title" className="consent-title">{t('title')}</p>
      {/* The privacy link closes the body text rather than sharing the button
          row: on a phone the row then fits on one line, which keeps the banner
          short enough that the hero CTA above it stays visible and tappable. */}
      <p className="consent-body">
        {t('body')}{' '}
        <Link href="/polityka-prywatnosci" className="consent-more">{t('more')}</Link>
      </p>
      <div className="consent-actions">
        <button onClick={() => choose('granted')} className="consent-btn consent-accept">{t('accept')}</button>
        <button onClick={() => choose('denied')} className="consent-btn consent-reject">{t('reject')}</button>
      </div>
    </div>
  );
}
