'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { splitGiftCardPayment, STRIPE_MINIMUM_MINOR, type GiftCardCurrency } from '@/lib/gift-card-balance';

export type AppliedGiftCard = { code: string; available: number; currency: GiftCardCurrency };

export function GiftCardPayment({ card, onChange, total, currency, locked, confirmed }: {
  card: AppliedGiftCard | null; onChange: (card: AppliedGiftCard | null) => void;
  total: number; currency: GiftCardCurrency; locked: boolean;
  confirmed: { giftCard: number; cash: number } | null;
}) {
  const t = useTranslations('giftBalance');
  const locale = useLocale();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  const money = (minor: number) => new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 100);
  const split = card?.currency === currency && total > 0
    ? splitGiftCardPayment(total, card.available, STRIPE_MINIMUM_MINOR[currency]) : null;
  async function apply() {
    if (busy || locked || !input.trim()) return;
    const version = ++request.current;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/gift-cards/balance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: input, locale }) });
      const data = await response.json();
      if (version !== request.current) return;
      if (!response.ok) { setError(data.error === 'gift_card_currency' ? t('wrongCurrency', { currency: data.currency }) : t('invalid')); return; }
      if (data.available <= 0) { setError(t('empty')); return; }
      onChange(data); setInput('');
    } catch { if (version === request.current) setError(t('unavailable')); }
    finally { if (version === request.current) setBusy(false); }
  }
  return <section className="promo-entry" aria-label={t('label')}>
    {card ? <>
      <p>{t('balance', { amount: money(card.available) })}</p>
      {(confirmed ?? split) && <>
        <p>{t('used', { amount: money((confirmed ?? split)!.giftCard) })}</p>
        <p>{t('cashDue', { amount: money((confirmed ?? split)!.cash) })}</p>
        {!locked && split && <p>{t('remaining', { amount: money(split.balanceAfter) })}</p>}
      </>}
      {!locked && <button type="button" className="promo-remove" onClick={() => { request.current++; onChange(null); }}>{t('remove')}</button>}
    </> : <details><summary>{t('have')}</summary>
      <label htmlFor="gift-card-code">{t('label')}</label>
      <div className="promo-form">
        <input id="gift-card-code" value={input} onChange={event => setInput(event.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={busy || locked}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void apply(); } }} />
        <button className="btn btn-ghost" type="button" onClick={() => void apply()} disabled={busy || locked || !input.trim()}>{t('apply')}</button>
      </div>
      <p>{t('promoConflict')}</p>
    </details>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
