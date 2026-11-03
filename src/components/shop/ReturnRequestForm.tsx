'use client';
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { RETURNS_POLICY, returnContactHref } from '@/lib/returns-policy';

export function ReturnRequestForm({ initialOrderId = '' }: { initialOrderId?: string }) {
  const t = useTranslations('returns');
  const [orderId, setOrderId] = useState(initialOrderId);
  const fieldId = useId();
  const address = RETURNS_POLICY.address;
  return (
    <div className="return-form">
      <address>
        Anna Ciok Studio<br />
        {address.streetAddress}<br />
        {address.postalCode} {address.addressLocality}<br />
        {t('returnRegion')}
      </address>
      <p>{t('returnCost')}</p>
      <label htmlFor={fieldId} className="return-label">{t('optionalOrder')}</label>
      <input id={fieldId} name="order-id" value={orderId} onChange={(e) => setOrderId(e.target.value)} className="return-input" autoComplete="off" maxLength={100} />
      <a className="return-btn" href={returnContactHref(t('heading'),orderId)}>{t('button')}</a>
      <p>{t('noAccount')}</p>
    </div>
  );
}
