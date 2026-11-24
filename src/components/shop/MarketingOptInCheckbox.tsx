'use client';

import { useTranslations } from 'next-intl';

/**
 * Checkout marketing-email consent (cart + gift-card checkout). Unticked by
 * default and never required — the purchase works either way. The ticked
 * value travels to POST /api/checkout as `marketing_email_opt_in: true`, is
 * stored on the order (`marketing.email_opt_in` + timestamp), and only once
 * the order is paid adds the buyer to the Resend marketing segment.
 * `disabled` locks it to the value already sent with the current checkout
 * attempt (see readSentMarketingOptIn in src/lib/checkout-client.ts).
 */
export function MarketingOptInCheckbox({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const t = useTranslations();
  return (
    <label className="checkout-marketing-optin">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        data-testid="marketing-optin"
      />
      <span>{t('delivery.marketingOptIn')}</span>
    </label>
  );
}
