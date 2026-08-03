'use client';

/* ============================================================
   PrintConfigurator — size × framed × frameColour × mount selector.
   Client island: picks a variant, shows the LIVE price, and adds the
   composite cart token (print:<id>:<size>:<framed>:<mount>:<colour>).
   ============================================================ */
import { useLocale, useTranslations } from 'next-intl';
import { useCart } from '@/store/cart';
import { Icon } from '@/components/ui/Icon';
import { useCurrency } from '@/components/currency/CurrencyProvider';
import { toChargeableCurrency } from '@/lib/currency';
import { currencyFormatter } from '@/lib/format';
import { priceOfVariant } from '@/lib/print-pricing';
import { isVariantAvailable } from '@/lib/prints';
import { encodePrintToken, isPrintToken, printVariantButtonState, variantLabel } from '@/lib/print-cart';
import { buildPrintAddToCartEvent, buildPrintRemoveFromCartEvent, pushDataLayer } from '@/lib/analytics';
import type { PrintDesign, PrintFrameColour, PrintVariantSelection } from '@/lib/types';

export function PrintConfigurator({
  design,
  usableVariantKeys,
  sel,
  onSelChange,
}: {
  design: PrintDesign;
  usableVariantKeys?: string[];
  sel: PrintVariantSelection;
  onSelChange: (sel: PrintVariantSelection) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const currency = useCurrency();
  // priceOfVariant only prices pln/eur/gbp; toChargeableCurrency maps any other
  // currency to EUR.
  const printCurrency = toChargeableCurrency(currency);
  const { fmt, code: analyticsCurrency } = currencyFormatter(printCurrency);

  const structurallyAvailable = isVariantAvailable(design, sel);
  const price = priceOfVariant(design, sel, printCurrency);
  const token = encodePrintToken(design.id, sel);

  const ids = useCart((s) => s.ids);
  const add = useCart((s) => s.add);
  const remove = useCart((s) => s.remove);
  const inCart = ids.includes(token);
  // Best-effort UX gating only — checkout re-resolves and fail-closes. The
  // decision table (incl. the in-cart remove edge) is pure + unit-tested in
  // print-cart.test.ts; the repo has no DOM render harness for the island.
  const buttonState = printVariantButtonState({ structurallyAvailable, usableVariantKeys, sel, inCart });
  // Hard rule: ceramics and prints are separate orders — block adding a print
  // while the cart holds ceramics (checkout rejects mixed carts server-side too).
  const cartHasCeramics = ids.some((id) => !isPrintToken(id));

  const canFrame = design.frameColours.length > 0;

  function setFramed(framed: boolean) {
    onSelChange({
      ...sel,
      framed,
      mount: false,
      frameColour: framed ? (design.frameColours[0] ?? 'black') : 'none',
    });
  }

  return (
    <div className="print-config" data-testid="print-configurator">
      {/* 1. Size selector — always shown */}
      <fieldset className="print-axis">
        <legend className="print-axis-label">{t('print.size.label')}</legend>
        <div className="print-opts" role="radiogroup" aria-label={t('print.size.label')}>
          {design.sizes.map((size) => (
            <button
              type="button"
              key={size}
              role="radio"
              aria-checked={sel.size === size}
              className={`print-opt${sel.size === size ? ' active' : ''}`}
              data-testid={`opt-size-${size}`}
              onClick={() => onSelChange({ ...sel, size })}
            >
              {t(`print.size.${size}`)}
            </button>
          ))}
        </div>
      </fieldset>

      {/* 2. Framing toggle — only when design offers at least one frame colour */}
      {canFrame && (
        <fieldset className="print-axis">
          <legend className="print-axis-label">{t('print.framing')}</legend>
          <div className="print-opts" role="radiogroup" aria-label={t('print.framing')}>
            <button
              type="button"
              role="radio"
              aria-checked={!sel.framed}
              className={`print-opt${!sel.framed ? ' active' : ''}`}
              data-testid="opt-framed-false"
              onClick={() => setFramed(false)}
            >
              {t('print.unframed')}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={sel.framed}
              className={`print-opt${sel.framed ? ' active' : ''}`}
              data-testid="opt-framed-true"
              onClick={() => setFramed(true)}
            >
              {t('print.framed')}
            </button>
          </div>
        </fieldset>
      )}

      {/* 3. Frame colour — only when framed */}
      {sel.framed && (
        <fieldset className="print-axis">
          <legend className="print-axis-label">{t('print.frameColour')}</legend>
          <div className="print-opts" role="radiogroup" aria-label={t('print.frameColour')}>
            {design.frameColours.map((colour) => (
              <button
                type="button"
                key={colour}
                role="radio"
                aria-checked={sel.frameColour === colour}
                className={`print-opt print-opt-colour${sel.frameColour === colour ? ' active' : ''}`}
                data-testid={`opt-colour-${colour}`}
                data-colour={colour}
                onClick={() => onSelChange({ ...sel, frameColour: colour as PrintFrameColour })}
              >
                {t(`print.colour_${colour}`)}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {/* 4. Mount toggle — only when framed and design supports mount */}
      {sel.framed && design.mountAvailable && (
        <fieldset className="print-axis">
          <legend className="print-axis-label">{t('print.mount')}</legend>
          <div className="print-opts" role="radiogroup" aria-label={t('print.mount')}>
            <button
              type="button"
              role="radio"
              aria-checked={!sel.mount}
              className={`print-opt${!sel.mount ? ' active' : ''}`}
              data-testid="opt-mount-false"
              onClick={() => onSelChange({ ...sel, mount: false })}
            >
              {t('print.mount_none')}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={sel.mount}
              className={`print-opt${sel.mount ? ' active' : ''}`}
              data-testid="opt-mount-true"
              onClick={() => onSelChange({ ...sel, mount: true })}
            >
              {t('print.mount_yes')}
            </button>
          </div>
        </fieldset>
      )}

      <div className="print-price" data-testid="print-price">
        <span className="v">{fmt(price)}</span>
      </div>

      {cartHasCeramics && !inCart ? (
        <>
          <button type="button" className="btn btn-primary lb-add" disabled aria-disabled="true" data-testid="print-add">
            {t('print.addToCart')}
          </button>
          <p className="pay-error" data-testid="print-mixed-note">{t('print.mixedCart')}</p>
        </>
      ) : buttonState === 'add' || buttonState === 'remove' ? (
        <button
          type="button"
          className={`btn btn-primary lb-add${inCart ? ' in' : ''}`}
          data-testid="print-add"
          onClick={() => {
            const was = useCart.getState().ids.includes(token);
            if (inCart) {
              remove(token);
              pushDataLayer(
                buildPrintRemoveFromCartEvent(
                  { id: design.id, num: design.num, variantLabel: variantLabel(sel, locale), price },
                  { currency: analyticsCurrency },
                ),
              );
            } else {
              add(token);
              const now = useCart.getState().ids.includes(token);
              if (!was && now) {
                pushDataLayer(
                  buildPrintAddToCartEvent(
                    { id: design.id, num: design.num, variantLabel: variantLabel(sel, locale), price },
                    { currency: analyticsCurrency },
                  ),
                );
              }
            }
          }}
        >
          {inCart ? t('print.inCart') : t('print.addToCart')}
          <Icon name={inCart ? 'check' : 'arrow'} className="btn-arrow" />
        </button>
      ) : (
        <button type="button" className="btn btn-primary lb-add" disabled aria-disabled="true" data-testid="print-add">
          {buttonState === 'disabledAsset' ? t('print.assetUnavailable') : t('print.unavailable')}
        </button>
      )}

      <p className="print-paper-note">{t('print.paperNote')}</p>
    </div>
  );
}
