'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';

export function CheckoutForm({
  returnUrl,
  payLabel,
  onConfirmingChange,
}: {
  returnUrl: string;
  /** The pay button's label, carrying the amount it charges ("Zapłać 255 zł"). */
  payLabel: string;
  /**
   * True while a confirm is in flight (and stays true once it succeeded and the
   * page is navigating away). The cart locks "Zmień" on it: retiring the
   * attempt under a payment that is landing would take its pieces away.
   */
  onConfirmingChange?: (confirming: boolean) => void;
}) {
  const t = useTranslations('cart');
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    onConfirmingChange?.(true);
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
      onConfirmingChange?.(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="pay-form">
      {/* Email + delivery details are collected before payment, so only the
          payment method is gathered here. */}
      {/* Accordion with radios: BLIK, Przelewy24 and card read as one short
          list on a phone instead of a row of tabs that scrolls sideways. */}
      <PaymentElement options={{ layout: { type: 'accordion', defaultCollapsed: false, radios: 'always', spacedAccordionItems: false } }} />
      {error && <p className="pay-error">{error}</p>}
      <button className="btn btn-primary" type="submit" data-testid="payment-submit" disabled={!stripe || submitting}>
        {submitting ? t('payProcessing') : payLabel}
      </button>
    </form>
  );
}
