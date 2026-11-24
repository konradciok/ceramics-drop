'use client';

import { useTranslations } from 'next-intl';

/**
 * Checkout marketing-email consent (cart + gift-card checkout). Unticked by
 * default and never required — the purchase works either way. The ticked
 * value travels to POST /api/checkout as `marketing_email_opt_in: true`, is
 * stored on the order (`marketing.email_opt_in` + timestamp), and only once
 * the order is paid adds the buyer to the Resend marketing segment.
 */
export function MarketingOptInCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const t = useTranslations();
  return (
    <label className="checkout-marketing-optin">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid="marketing-optin"
      />
      <span>{t('delivery.marketingOptIn')}</span>
    </label>
  );
}
