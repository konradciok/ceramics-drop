'use client';
import { useState, useSyncExternalStore } from 'react';
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
  if (dismissed || stored !== null) return null;
  const choose = (v: 'granted' | 'denied') => { setConsent(v); setDismissed(true); };
  return (
    <div role="dialog" aria-labelledby="consent-title" className="consent">
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
