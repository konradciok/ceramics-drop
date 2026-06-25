'use client';

/* ============================================================
   PrintConfigurator — size × paper × frame selector for a print PDP.
   Client island: picks a variant, shows the LIVE price (computed by the
   same priceOfVariant the server charges), blocks unavailable combinations,
   and adds the composite cart token (print:<id>:<size>:<paper>:<frame>).
   ============================================================ */
import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useCart } from '@/store/cart';
import { Icon } from '@/components/ui/Icon';
import { eur, pln } from '@/lib/format';
import { priceOfVariant } from '@/lib/print-pricing';
import { isVariantAvailable } from '@/lib/prints';
import { encodePrintToken, variantLabel } from '@/lib/print-cart';
import { buildPrintAddToCartEvent, pushDataLayer } from '@/lib/analytics';
import type { PrintDesign, PrintFrame, PrintPaper, PrintSize, PrintVariantSelection } from '@/lib/types';

type Axis = 'size' | 'paper' | 'frame';

/** First selection (per axis offered order) that yields an available combination. */
function firstAvailable(design: PrintDesign): PrintVariantSelection {
  for (const size of design.sizes) {
    for (const paper of design.papers) {
      for (const frame of design.frames) {
        const sel = { size, paper, frame };
        if (isVariantAvailable(design, sel)) return sel;
      }
    }
  }
  // Fallback: a design with no sellable combo shouldn't be published, but never crash.
  return { size: design.sizes[0], paper: design.papers[0], frame: design.frames[0] };
}

export function PrintConfigurator({ design }: { design: PrintDesign }) {
  const t = useTranslations();
  const locale = useLocale();
  const currency: 'pln' | 'eur' = locale === 'pl' ? 'pln' : 'eur';
  const fmt = locale === 'pl' ? pln : eur;

  const [sel, setSel] = useState<PrintVariantSelection>(() => firstAvailable(design));

  const available = isVariantAvailable(design, sel);
  const price = priceOfVariant(sel, currency);
  const token = encodePrintToken(design.id, sel);

  const ids = useCart((s) => s.ids);
  const add = useCart((s) => s.add);
  const remove = useCart((s) => s.remove);
  const inCart = ids.includes(token);

  // Whether choosing `value` on `axis` (keeping the other two axes) is sellable —
  // drives per-option disabling so dead-end combinations can't be picked.
  const optionEnabled = useMemo(() => {
    return (axis: Axis, value: PrintSize | PrintPaper | PrintFrame) =>
      isVariantAvailable(design, { ...sel, [axis]: value } as PrintVariantSelection);
  }, [design, sel]);

  const axes: Array<{ axis: Axis; values: readonly string[] }> = [
    { axis: 'size', values: design.sizes },
    { axis: 'paper', values: design.papers },
    { axis: 'frame', values: design.frames },
  ];

  return (
    <div className="print-config" data-testid="print-configurator">
      {axes.map(({ axis, values }) => (
        <fieldset className="print-axis" key={axis}>
          <legend className="print-axis-label">{t(`print.axis.${axis}`)}</legend>
          <div className="print-opts" role="radiogroup" aria-label={t(`print.axis.${axis}`)}>
            {values.map((value) => {
              const active = sel[axis] === value;
              const enabled = active || optionEnabled(axis, value as PrintSize | PrintPaper | PrintFrame);
              return (
                <button
                  type="button"
                  key={value}
                  role="radio"
                  aria-checked={active}
                  disabled={!enabled}
                  className={`print-opt${active ? ' active' : ''}`}
                  data-testid={`opt-${axis}-${value}`}
                  onClick={() => setSel((s) => ({ ...s, [axis]: value }) as PrintVariantSelection)}
                >
                  {t(`print.${axis}.${value}`)}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}

      <div className="print-price" data-testid="print-price">
        <span className="k">{t('print.priceLabel')}</span>
        <span className="v">{fmt(price)}</span>
      </div>

      {available ? (
        <button
          type="button"
          className={`btn btn-primary lb-add${inCart ? ' in' : ''}`}
          data-testid="print-add"
          onClick={() => {
            const was = useCart.getState().ids.includes(token);
            if (inCart) remove(token);
            else add(token);
            const now = useCart.getState().ids.includes(token);
            // Only fire add_to_cart on a real add (not a remove / idempotent no-op).
            if (!was && now) {
              pushDataLayer(
                buildPrintAddToCartEvent(
                  { id: design.id, num: design.num, variantLabel: variantLabel(sel, locale), price },
                  { currency: currency === 'eur' ? 'EUR' : 'PLN' },
                ),
              );
            }
          }}
        >
          {inCart ? t('print.inCart') : t('print.addToCart')}
          <Icon name={inCart ? 'check' : 'arrow'} className="btn-arrow" />
        </button>
      ) : (
        <button type="button" className="btn btn-primary lb-add" disabled aria-disabled="true" data-testid="print-add">
          {t('print.unavailable')}
        </button>
      )}
    </div>
  );
}
