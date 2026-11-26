import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';

/**
 * One-line purchase assurance — the damage guarantee and the 14-day return —
 * linking to the matching sections of /dostawa-i-zwroty. Shown under the PDP's
 * add-to-cart button and above the cart's pay button. No 'use client': it
 * renders as a server component on the PDP and inside the client CartView.
 */
export function PurchaseAssurance({ className }: { className?: string }) {
  const t = useTranslations();
  return (
    <p className={`purchase-assurance${className ? ` ${className}` : ''}`} data-testid="purchase-assurance">
      {t.rich('pdp.assurance', {
        damage: (c: ReactNode) => <Link href="/dostawa-i-zwroty#uszkodzenia">{c}</Link>,
        returns: (c: ReactNode) => <Link href="/dostawa-i-zwroty#zwroty">{c}</Link>,
      })}
    </p>
  );
}
