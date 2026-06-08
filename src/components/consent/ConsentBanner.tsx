'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { readConsent, setConsent } from './consent-mode';

export function ConsentBanner() {
  const t = useTranslations('consent');
  const [show, setShow] = useState(false);
  useEffect(() => { setShow(readConsent(document.cookie) === null); }, []);
  if (!show) return null;
  const choose = (v: 'granted' | 'denied') => { setConsent(v); setShow(false); };
  return (
    <div role="dialog" aria-label={t('title')} className="consent">
      <p className="consent-body">{t('body')}</p>
      <div className="consent-actions">
        <button onClick={() => choose('granted')} className="consent-btn consent-accept">{t('accept')}</button>
        <button onClick={() => choose('denied')} className="consent-btn consent-reject">{t('reject')}</button>
        <Link href="/polityka-prywatnosci" className="consent-more">{t('more')}</Link>
      </div>
    </div>
  );
}
