'use client';

import { useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { richTags } from '@/components/ui/richTags';
import { buildEngagementEvent, pushDataLayer } from '@/lib/analytics';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Status = 'idle' | 'submitting' | 'done' | 'error';

/**
 * Footer newsletter signup — step 1 of the double opt-in. POSTs {email, locale}
 * to /api/newsletter, which emails a confirmation link; the Resend contact is
 * created only when that link is clicked, so the "done" copy promises an email,
 * not a subscription. The emailed link doubles as the consent action — no
 * checkbox needed here, just the privacy note. Rendered in the footer brand
 * column on every page.
 */
export function FooterNewsletterForm() {
  const t = useTranslations();
  const locale = useLocale();
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');

  const emailValid = EMAIL_RE.test(email.trim());

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!emailValid || status === 'submitting') return;
    setStatus('submitting');
    try {
      const res = await fetch('/api/newsletter', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), locale }),
      });
      if (!res.ok) throw new Error('newsletter_failed');
      pushDataLayer(buildEngagementEvent('newsletter_signup_requested'));
      setStatus('done');
    } catch {
      setStatus('error');
    }
  }

  return (
    <form className="footer-newsletter" onSubmit={handleSubmit} data-testid="newsletter-form">
      {/* Heading stays in the done state so the brand column keeps its height. */}
      <h5>{t('newsletter.heading')}</h5>
      {status === 'done' ? (
        <p className="footer-newsletter-thanks" data-testid="newsletter-thanks" role="status">
          {t('newsletter.done')}
        </p>
      ) : (
        <>
          <p className="footer-newsletter-blurb">{t('newsletter.blurb')}</p>
          <div className="footer-newsletter-row">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              aria-label={t('newsletter.emailLabel')}
              placeholder={t('newsletter.placeholder')}
              data-testid="newsletter-email"
            />
            <button
              type="submit"
              className="footer-newsletter-btn"
              disabled={!emailValid || status === 'submitting'}
              data-testid="newsletter-submit"
            >
              {status === 'submitting' ? t('newsletter.submitting') : t('newsletter.submit')}
            </button>
          </div>
          {status === 'error' && (
            <p className="footer-newsletter-err" role="alert">
              {t('newsletter.error')}
            </p>
          )}
          <p className="footer-newsletter-privacy">
            {t.rich('newsletter.privacyNote', {
              ...richTags,
              link: (c) => (
                <Link href="/polityka-prywatnosci" className="inline">
                  {c}
                </Link>
              ),
            })}
          </p>
        </>
      )}
    </form>
  );
}
