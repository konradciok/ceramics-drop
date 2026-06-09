'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { readConsent, setConsent } from './consent-mode';

// The cookie isn't an external store that pushes updates, so the subscribe is a
// no-op; useSyncExternalStore is used purely to read a client-only value without
// a hydration mismatch (server snapshot = null) and without set-state-in-effect.
const noopSubscribe = () => () => {};

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

  // Publish the banner's occupied bottom height to `--consent-h` so the selbar
  // (fixed, bottom-left overlap on collection pages) can sit above it. Zeroed on
  // cleanup — the component returns null once dismissed, so the offset must clear.
  useEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!el) { root.style.setProperty('--consent-h', '0px'); return; }
    const apply = () => {
      const rect = el.getBoundingClientRect();
      const h = window.innerHeight - rect.top + 12;
      root.style.setProperty('--consent-h', `${Math.max(0, Math.round(h))}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    window.addEventListener('resize', apply);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', apply);
      root.style.setProperty('--consent-h', '0px');
    };
  }, [visible]);

  if (!visible) return null;
  const choose = (v: 'granted' | 'denied') => { setConsent(v); setDismissed(true); };
  return (
    <div ref={ref} role="dialog" aria-labelledby="consent-title" className="consent">
      <p id="consent-title" className="consent-title">{t('title')}</p>
      <p className="consent-body">{t('body')}</p>
      <div className="consent-actions">
        <button onClick={() => choose('granted')} className="consent-btn consent-accept">{t('accept')}</button>
        <button onClick={() => choose('denied')} className="consent-btn consent-reject">{t('reject')}</button>
        <Link href="/polityka-prywatnosci" className="consent-more">{t('more')}</Link>
      </div>
    </div>
  );
}
