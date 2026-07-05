'use client';

import { useLocale } from 'next-intl';
import { useCurrencyControls } from '@/components/currency/CurrencyProvider';
import { SWITCHABLE_CURRENCIES, type Currency } from '@/lib/currency';

/** Display labels for every `Currency`. Only `SWITCHABLE_CURRENCIES` render;
 *  the rest (pln/usd/cad) are here for completeness but never shown. */
const CURRENCY_LABELS: Record<Currency, string> = {
  pln: 'PLN',
  eur: 'EUR',
  gbp: 'GBP',
  usd: 'USD',
  cad: 'CAD',
};

/**
 * EUR · GBP pill switcher. Mirrors LangSwitch styling (reuses the `.lang-switch`
 * classes). Hidden for the `pl` locale — Polish always prices in PLN, so there
 * is nothing to switch.
 */
export function CurrencySwitcher() {
  const locale = useLocale();
  const { currency, setCurrency } = useCurrencyControls();

  // Polish is PLN-only — no currency choice to offer.
  if (locale === 'pl') return null;

  return (
    <div className="lang-switch currency-switch" role="group" aria-label="Currency">
      {SWITCHABLE_CURRENCIES.map((c) => (
        <button
          key={c}
          type="button"
          className={c === currency ? 'active' : undefined}
          aria-pressed={c === currency}
          onClick={() => setCurrency(c)}
        >
          {CURRENCY_LABELS[c]}
        </button>
      ))}
    </div>
  );
}
