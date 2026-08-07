'use client';

import { useEffect } from 'react';
import { useLocale } from 'next-intl';
import { buildPrintViewItemEvent, pushDataLayer } from '@/lib/analytics';
import { useCurrency } from '@/components/currency/CurrencyProvider';
import { toChargeableCurrency } from '@/lib/currency';
import { currencyFormatter } from '@/lib/format';
import { priceOfVariant, type PrintPricingConfig } from '@/lib/print-pricing';
import { variantLabel } from '@/lib/print-cart';
import type { PrintDesign, PrintVariantSelection } from '@/lib/types';

type Props = { design: PrintDesign; pricing: PrintPricingConfig };

/** Fires view_item on print PDP load — mirrors ProductViewAnalytics for ceramics.
 *  Uses the configurator's entry selection (first size, unframed) so item_variant
 *  and price match what the buyer first sees. */
export function PrintViewAnalytics({ design, pricing }: Props) {
  const currency = useCurrency();
  const locale = useLocale();
  const printCurrency = toChargeableCurrency(currency);
  const { code: analyticsCurrency } = currencyFormatter(printCurrency);

  useEffect(() => {
    const sel: PrintVariantSelection = { size: design.sizes[0], framed: false, mount: false, frameColour: 'none' };
    pushDataLayer(
      buildPrintViewItemEvent(
        { id: design.id, num: design.num, variantLabel: variantLabel(sel, locale), price: priceOfVariant(sel, printCurrency, pricing) },
        { currency: analyticsCurrency },
      ),
    );
    // design.id is the stable key; a remount with a different design re-fires —
    // intentional for SPA-style navigation, exactly like ProductViewAnalytics.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design.id]);

  return null;
}
