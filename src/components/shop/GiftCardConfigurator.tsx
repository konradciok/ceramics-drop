'use client';

/* ============================================================
   GiftCardConfigurator — tier picker + dedicated single-item checkout.
   ------------------------------------------------------------
   Gift cards are their own exclusive order track (see docs/gift-cards.md):
   no shipping, no piece reservation, cannot mix with ceramics/prints, and at
   most one gift-card line per checkout. Rather than routing through the
   general /koszyk cart (which deliberately drops gift-card tokens — see
   CartView.tsx), this island owns a short, self-contained checkout: pick a
   tier → contact form → Stripe PaymentElement. It never touches the
   persisted cart store.

   The Stripe return_url points at the existing /koszyk/return page. That
   page fires the purchase event generically from whatever ids were
   remembered via rememberCheckoutForReturn (checkout-analytics.ts) — since
   analyticsItemForId (analytics.ts) already resolves `giftcard:` tokens,
   no return-page changes were needed for gift-card purchases to convert.
   ============================================================ */
import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Elements } from '@stripe/react-stripe-js';
import { getStripe } from '@/lib/stripe-client';
import { useCurrency } from '@/components/currency/CurrencyProvider';
import { toChargeableCurrency } from '@/lib/currency';
import { currencyFormatter } from '@/lib/format';
import { Icon } from '@/components/ui/Icon';
import {
  GIFT_CARD_TIERS,
  encodeGiftCardToken,
  giftCardAmountMajor,
  formatGiftCardAmount,
  type GiftCardTier,
} from '@/lib/gift-cards';
import {
  buildEngagementEvent,
  buildGiftCardAddToCartEvent,
  buildGiftCardViewItemEvent,
  giftCardAnalyticsItem,
  pushDataLayer,
  type GiftCardItemInput,
} from '@/lib/analytics';
import {
  pushCheckoutStartedItemsOnce,
  rememberCheckoutForReturn,
  forgetRememberedCheckout,
} from '@/lib/checkout-analytics';
import { collectMarketingCookies } from '@/lib/marketing/client-cookies';
import { sha256Hex } from '@/lib/marketing/hash';
import { checkoutPreBodyError, shouldKeepAttemptIdOnCatch } from '@/lib/checkout-client';
import { CheckoutForm } from './CheckoutForm';

const stripePromise = getStripe();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Persisted like CartView's ATTEMPT_ID_KEY: survives a reload of the same
// attempt, reset whenever the selected tier changes or a checkout resolves.
const ATTEMPT_ID_KEY = 'acc_giftcard_checkout_attempt_v1';

function readOrCreateAttemptId(): string {
  if (typeof window === 'undefined') return '';
  const saved = localStorage.getItem(ATTEMPT_ID_KEY);
  if (saved) return saved;
  const id = crypto.randomUUID();
  localStorage.setItem(ATTEMPT_ID_KEY, id);
  return id;
}

type Step = 'pick' | 'checkout';

export function GiftCardConfigurator() {
  const t = useTranslations();
  const locale = useLocale();
  const currency = useCurrency();
  const chargeCurrency = toChargeableCurrency(currency);
  const { fmt, code: analyticsCurrency } = currencyFormatter(chargeCurrency);

  const [tier, setTier] = useState<GiftCardTier>(GIFT_CARD_TIERS[0]);
  const [step, setStep] = useState<Step>('pick');
  const [contact, setContact] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [attemptId, setAttemptId] = useState<string>(() => readOrCreateAttemptId());

  const price = giftCardAmountMajor(tier, chargeCurrency);
  const token = encodeGiftCardToken(tier.id);
  const giftCardItem: GiftCardItemInput = {
    tierId: tier.id,
    amountLabel: formatGiftCardAmount(tier, chargeCurrency),
    price,
  };

  function resetAttemptId() {
    const id = crypto.randomUUID();
    localStorage.setItem(ATTEMPT_ID_KEY, id);
    setAttemptId(id);
  }

  // view_item once on mount, for the entry tier/currency — mirrors
  // PrintViewAnalytics (fires once per mount, not on every later selection).
  useEffect(() => {
    pushDataLayer(buildGiftCardViewItemEvent(giftCardItem, { currency: analyticsCurrency }));
    // Runs once on mount only — intentionally excludes giftCardItem/analyticsCurrency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const contactReady =
    contact.firstName.trim() !== '' &&
    contact.lastName.trim() !== '' &&
    EMAIL_RE.test(contact.email.trim());

  function handlePickTier(next: GiftCardTier) {
    if (next.id === tier.id) return;
    setTier(next);
    resetAttemptId();
  }

  function handleBuy() {
    pushDataLayer(buildGiftCardAddToCartEvent(giftCardItem, { currency: analyticsCurrency }));
    setCheckoutError(null);
    setStep('checkout');
  }

  function handleBack() {
    setStep('pick');
    setClientSecret(null);
    setCheckoutError(null);
  }

  async function handleSubmitContact(e: React.FormEvent) {
    e.preventDefault();
    if (!contactReady || submitting) return;
    setSubmitting(true);
    setCheckoutError(null);
    forgetRememberedCheckout();
    const emailNorm = contact.email.trim().toLowerCase();
    const em = emailNorm ? await sha256Hex(emailNorm) : undefined;
    pushCheckoutStartedItemsOnce(attemptId, [giftCardAnalyticsItem(giftCardItem)], {
      shippingCost: 0,
      shippingMethod: 'giftcard',
      userData: em ? { em } : undefined,
      currency: analyticsCurrency,
    });

    let gotResponse = false;
    let resOk = false;
    let resStatus = 0;
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ids: [token],
          attemptId,
          locale,
          contact: {
            first_name: contact.firstName.trim(),
            last_name: contact.lastName.trim(),
            email: contact.email.trim(),
            phone: contact.phone.trim(),
          },
          marketing_cookies: collectMarketingCookies(),
        }),
      });
      gotResponse = true;
      resOk = res.ok;
      resStatus = res.status;

      if (res.status === 409) {
        const conflict = (await res.json()) as { error?: string };
        if (conflict.error === 'order_conflict') {
          resetAttemptId();
        }
        // checkout_in_progress: keep the attemptId so a retry replays onto the
        // in-flight winner instead of starting a fresh (409-doomed) attempt.
        pushDataLayer(buildEngagementEvent('checkout_error', { reason: conflict.error ?? 'order_conflict', status: 409, track: 'giftcard' }));
        setCheckoutError(t('cart.checkoutError'));
        return;
      }
      if (res.status === 429 || res.status === 503) {
        let body: { error?: string } | undefined;
        if (res.status === 503) {
          try {
            body = (await res.json()) as { error?: string };
          } catch {
            // Bare 503 is unambiguous.
          }
        }
        const preBody = checkoutPreBodyError(res.status, body);
        if (preBody) {
          pushDataLayer(buildEngagementEvent('checkout_error', { reason: preBody.analyticsReason, status: preBody.analyticsStatus, track: 'giftcard' }));
          setCheckoutError(t(preBody.errorKey));
          return;
        }
      }
      if (!res.ok) {
        resetAttemptId();
        let reason = 'checkout_failed';
        let errorMessage = t('cart.checkoutError');
        if (res.status === 400) {
          try {
            const body = (await res.json()) as { error?: string };
            if (body.error === 'invalid_contact') {
              reason = 'invalid_contact';
              errorMessage = t('giftCard.invalidContact');
            }
          } catch {
            // Unparseable body — keep generic copy.
          }
        }
        pushDataLayer(buildEngagementEvent('checkout_error', { reason, status: res.status, track: 'giftcard' }));
        setCheckoutError(errorMessage);
        return;
      }

      const { client_secret } = (await res.json()) as { client_secret: string };
      rememberCheckoutForReturn([token], {
        shippingCost: 0,
        shippingMethod: 'giftcard',
        currency: analyticsCurrency,
        itemPrices: [price],
        userData: em ? { em } : undefined,
      });
      resetAttemptId();
      setClientSecret(client_secret);
    } catch {
      if (gotResponse && !resOk && !shouldKeepAttemptIdOnCatch(resStatus)) resetAttemptId();
      pushDataLayer(buildEngagementEvent(
        'checkout_error',
        gotResponse
          ? { reason: 'response_parse_error', status: resStatus, track: 'giftcard' }
          : { reason: 'network_error', status: 0, track: 'giftcard' },
      ));
      setCheckoutError(t('cart.checkoutError'));
    } finally {
      setSubmitting(false);
    }
  }

  const returnUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}${locale === 'pl' ? '' : `/${locale}`}/koszyk/return`
      : '/koszyk/return';
  const stripeLocale = (['pl', 'en', 'es', 'de'] as string[]).includes(locale)
    ? (locale as 'pl' | 'en' | 'es' | 'de')
    : 'auto';

  if (step === 'pick') {
    return (
      <div className="giftcard-config" data-testid="giftcard-configurator">
        <fieldset className="print-axis">
          <legend className="print-axis-label">{t('giftCard.tierLabel')}</legend>
          <div className="print-opts" role="radiogroup" aria-label={t('giftCard.tierLabel')}>
            {GIFT_CARD_TIERS.map((opt) => (
              <button
                type="button"
                key={opt.id}
                role="radio"
                aria-checked={tier.id === opt.id}
                className={`print-opt${tier.id === opt.id ? ' active' : ''}`}
                data-testid={`giftcard-tier-${opt.id}`}
                onClick={() => handlePickTier(opt)}
              >
                {formatGiftCardAmount(opt, chargeCurrency)}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="print-price" data-testid="giftcard-price">
          <span className="v">{fmt(price)}</span>
        </div>

        <button
          type="button"
          className="btn btn-primary lb-add"
          data-testid="giftcard-buy"
          onClick={handleBuy}
        >
          {t('giftCard.buy')} <Icon name="arrow" className="btn-arrow" />
        </button>
      </div>
    );
  }

  return (
    <div className="giftcard-config giftcard-checkout" data-testid="giftcard-checkout">
      {/* Once a live PaymentIntent exists, going back would orphan it —
          same reasoning as CartView locking the promo-remove control once
          clientSecret is set. */}
      {!clientSecret && (
        <button type="button" className="giftcard-back" data-testid="giftcard-back" onClick={handleBack}>
          <Icon name="chevron-left" /> {t('giftCard.back')}
        </button>
      )}

      <div className="print-price" data-testid="giftcard-checkout-price">
        <span className="v">{formatGiftCardAmount(tier, chargeCurrency)}</span>
      </div>

      {clientSecret ? (
        <Elements stripe={stripePromise} options={{ clientSecret, locale: stripeLocale }}>
          <CheckoutForm returnUrl={returnUrl} />
        </Elements>
      ) : (
        <form onSubmit={handleSubmitContact} className="delivery-fields" data-testid="giftcard-contact-form">
          <div className="cart-section-label">{t('giftCard.contactTitle')}</div>
          <p className="giftcard-contact-note">{t('giftCard.contactNote')}</p>
          <div className="field-row">
            <label className="field">
              <span>{t('delivery.firstName')}</span>
              <input
                value={contact.firstName}
                onChange={(e) => setContact((c) => ({ ...c, firstName: e.target.value }))}
                autoComplete="given-name"
                required
              />
            </label>
            <label className="field">
              <span>{t('delivery.lastName')}</span>
              <input
                value={contact.lastName}
                onChange={(e) => setContact((c) => ({ ...c, lastName: e.target.value }))}
                autoComplete="family-name"
                required
              />
            </label>
          </div>
          <label className="field">
            <span>{t('delivery.email')}</span>
            <input
              type="email"
              value={contact.email}
              onChange={(e) => setContact((c) => ({ ...c, email: e.target.value }))}
              autoComplete="email"
              required
            />
          </label>
          <label className="field">
            <span>{t('delivery.phone')}</span>
            <input
              type="tel"
              value={contact.phone}
              onChange={(e) => setContact((c) => ({ ...c, phone: e.target.value }))}
              autoComplete="tel"
            />
          </label>

          <button
            type="submit"
            className="btn btn-primary"
            data-testid="giftcard-continue"
            disabled={!contactReady || submitting}
          >
            {t('giftCard.continueToPayment')} <Icon name="arrow" className="btn-arrow" />
          </button>
          {checkoutError && <p className="pay-error">{checkoutError}</p>}
        </form>
      )}
    </div>
  );
}
