'use client';

/* ============================================================
   GiftCardConfigurator — denomination selector + "buy as a gift" form.
   Client island: purely presentational for now. The gift card is not yet
   wired into cart/checkout or the promo-code system (see docs/promo-codes.md
   — codes are admin-minted today; purchase-minted codes are a separate,
   larger piece of work), so "Dodaj do koszyka" stays disabled with an
   explanatory note instead of a dead button.
   ============================================================ */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

type Tier = { amount: number; labelKey: string };

const TIERS: Tier[] = [
  { amount: 100, labelKey: 'tier1Label' },
  { amount: 200, labelKey: 'tier2Label' },
  { amount: 350, labelKey: 'tier3Label' },
  { amount: 500, labelKey: 'tier4Label' },
];

const DEFAULT_TIER = 1;

export function GiftCardConfigurator() {
  const t = useTranslations('giftCard');
  const [selected, setSelected] = useState(DEFAULT_TIER);
  const price = TIERS[selected].amount;

  return (
    <div className="gc-form-wrap">
      <div className="gc-tier-grid" role="radiogroup" aria-label={t('amountTitle')}>
        {TIERS.map((tier, i) => (
          <button
            type="button"
            key={tier.amount}
            role="radio"
            aria-checked={selected === i}
            className={`gc-tier${selected === i ? ' active' : ''}`}
            data-testid={`gc-tier-${tier.amount}`}
            onClick={() => setSelected(i)}
          >
            <span className="amt">{tier.amount} zł</span>
            <span className="lbl">{t(tier.labelKey)}</span>
          </button>
        ))}
      </div>

      <div className="gc-form">
        <h3>{t('formTitle')}</h3>
        <p className="sub">{t('formSub')}</p>

        <div className="field">
          <label htmlFor="gc-recipient-email">{t('recipientLabel')}</label>
          <input id="gc-recipient-email" type="email" placeholder={t('recipientPlaceholder')} />
        </div>
        <div className="field">
          <label htmlFor="gc-message">{t('messageLabel')}</label>
          <textarea id="gc-message" placeholder={t('messagePlaceholder')} rows={3} />
        </div>

        <div className="gc-purchase-row">
          <div className="gc-price" data-testid="gc-price">
            {price} zł<span className="cur">PLN</span>
          </div>
          <button type="button" className="btn btn-primary" disabled aria-disabled="true" data-testid="gc-add-to-cart">
            {t('addToCart')}
          </button>
        </div>
        <p className="gc-note">{t('deliveryNote')}</p>
        <p className="gc-soon">
          {t.rich('comingSoon', { link: (chunks) => <Link href="/kontakt">{chunks}</Link> })}
        </p>
      </div>
    </div>
  );
}
