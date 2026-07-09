'use client';

import { useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { buildEngagementEvent, pushDataLayer } from '@/lib/analytics';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Status = 'idle' | 'submitting' | 'done' | 'error';

/**
 * "Request a similar piece" capture for a showroom piece. A CTA reveals an
 * inline form (email + optional message + marketing consent) that POSTs to
 * /api/interest. Rendered on showroom PDPs and on each showroom gallery card.
 * The server dedupes per (product_id, email) and always answers success, so the
 * UI shows the same thank-you whether the submission was new or a repeat.
 */
export function ShowroomInterestForm({ productId }: { productId: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<Status>('idle');

  const emailValid = EMAIL_RE.test(email.trim());

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!emailValid || status === 'submitting') return;
    setStatus('submitting');
    try {
      const res = await fetch('/api/interest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          product_id: productId,
          email: email.trim(),
          message: message.trim() || undefined,
          consent_marketing: consent,
          locale,
        }),
      });
      if (!res.ok) throw new Error('interest_failed');
      pushDataLayer(buildEngagementEvent('showroom_interest_submit', { item_id: productId }));
      setStatus('done');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'done') {
    return (
      <p className="showroom-interest-thanks" data-testid="interest-thanks">
        {t('showroom.interestThanks')}
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-primary lb-add"
        data-testid="interest-cta"
        onClick={() => setOpen(true)}
      >
        {t('showroom.interestCta')}
      </button>
    );
  }

  return (
    <form className="showroom-interest" onSubmit={handleSubmit} data-testid="interest-form">
      <label className="field">
        <span>{t('showroom.emailLabel')}</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
          data-testid="interest-email"
        />
      </label>
      <label className="field">
        <span>{t('showroom.messageLabel')}</span>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          maxLength={2000}
          data-testid="interest-message"
        />
      </label>
      <label className="showroom-interest-consent">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          data-testid="interest-consent"
        />
        <span>{t('showroom.consentLabel')}</span>
      </label>
      <button
        type="submit"
        className="btn btn-primary lb-add"
        disabled={!emailValid || status === 'submitting'}
        data-testid="interest-submit"
      >
        {status === 'submitting' ? t('showroom.submitting') : t('showroom.submit')}
      </button>
      {status === 'error' && <p className="pay-error">{t('showroom.interestError')}</p>}
    </form>
  );
}
