'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';

export function CheckoutForm({ returnUrl }: { returnUrl: string }) {
  const t = useTranslations('cart');
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
    });
    // Reached only if confirmation fails immediately (e.g. card validation);
    // redirect-based methods (BLIK/P24) navigate away on success.
    if (error) {
      setError(error.message ?? t('payError'));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="pay-form">
      {/* Email + delivery details are collected before payment, so only the
          payment method is gathered here. */}
      <PaymentElement />
      {error && <p className="pay-error">{error}</p>}
      <button className="btn btn-primary" type="submit" disabled={!stripe || submitting}>
        {submitting ? t('payProcessing') : t('pay')}
      </button>
    </form>
  );
}
