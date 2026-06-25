'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import * as Sentry from '@sentry/nextjs';
import { loadStripe } from '@stripe/stripe-js';
import { useCart } from '@/store/cart';
import { Link } from '@/i18n/navigation';
import { Icon } from '@/components/ui/Icon';
import { richTags } from '@/components/ui/richTags';
import {
  pushConfirmedPurchaseFromRememberedCheckout,
  pushPaymentFailedOnce,
  reportPurchaseGapOnce,
} from '@/lib/checkout-analytics';
import { buildEngagementEvent, pushDataLayer } from '@/lib/analytics';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);
type Status = 'loading' | 'ok' | 'processing' | 'fail';

export default function ReturnPage() {
  const t = useTranslations('return');
  const clear = useCart((s) => s.clear);
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const secret = params.get('payment_intent_client_secret');
    stripePromise
      .then(async (stripe) => {
        if (!secret || !stripe) { setStatus('fail'); return; }
        const { paymentIntent } = await stripe.retrievePaymentIntent(secret);
        switch (paymentIntent?.status) {
          case 'succeeded': {
            // Fires the purchase event once per payment intent and clears the
            // remembered snapshot internally on success.
            const fired = pushConfirmedPurchaseFromRememberedCheckout(paymentIntent.id, {});
            if (!fired) {
              // The PI succeeded but the browser purchase event did not fire. reportPurchaseGapOnce
              // returns null for benign cases (purchase already fired — a refresh — or the gap was
              // already reported for this intent) and otherwise the reason it is missing, so the GA4 /
              // Meta Pixel attribution gap is searchable in Sentry instead of audit-only, at most once
              // per intent. Best-effort — never let telemetry break the success screen.
              const gap = reportPurchaseGapOnce(paymentIntent.id);
              if (gap) {
                try {
                  Sentry.captureMessage('purchase event not fired on return page', {
                    level: 'warning',
                    extra: {
                      payment_intent_id: paymentIntent.id,
                      channel: 'browser',
                      reason: gap.reason,
                    },
                  });
                } catch {
                  // Swallow: Sentry must never break the confirmation render.
                }
              }
            }
            clear();
            setStatus('ok');
            break;
          }
          case 'processing':
            setStatus('processing');
            break;
          default: {
            // Distinct from checkout_error (pre-payment): the PaymentIntent itself
            // failed/was canceled. Only the status is sent — the PI id is a sensitive
            // param and never reaches analytics. The `status` param keeps the granularity
            // (e.g. canceled vs. requires_payment_method) so the funnel can segment.
            const status = paymentIntent?.status ?? 'unknown';
            if (paymentIntent?.id) {
              pushPaymentFailedOnce(paymentIntent.id, status);
            } else {
              // No PI id to dedupe against (e.g. unretrievable intent) — fire once.
              pushDataLayer(buildEngagementEvent('payment_failed', { status }));
            }
            setStatus('fail');
            break;
          }
        }
      })
      .catch((err) => {
        Sentry.captureException(err, { level: 'warning', tags: { context: 'stripe_return_load' } });
        setStatus('fail');
      });
  }, [clear]);

  if (status === 'loading') return <main id="cart-root" />;
  const key = status === 'ok' ? 'ok' : status === 'processing' ? 'processing' : 'fail';
  return (
    <main id="cart-root">
      <div className="confirm" data-testid={status === 'ok' ? 'checkout-success' : undefined}>
        {status === 'ok' && <div className="seal"><Icon name="check" /></div>}
        <h1>{t.rich(`${key}H`, richTags)}</h1>
        <p>{t(`${key}P`)}</p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link href="/" className="btn btn-primary">{t('back')} <Icon name="arrow" /></Link>
          <Link href="/koszyk" className="btn btn-ghost">{t('cart')}</Link>
        </div>
      </div>
    </main>
  );
}
