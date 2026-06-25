'use client';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { returnStatusMessageKey, type ReturnStatusKey } from './return-status';

export function ReturnRequestForm({ initialOrderId = '' }: { initialOrderId?: string }) {
  const t = useTranslations('returns');
  const [orderId, setOrderId] = useState(initialOrderId);
  const [status, setStatus] = useState<ReturnStatusKey | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!orderId.trim() || pending) return;
    setPending(true);
    setStatus(null);
    try {
      const res = await fetch('/api/returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId.trim() }),
      });
      setStatus(returnStatusMessageKey(res.status));
    } catch {
      setStatus('error');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="return-form">
      <label htmlFor="order-id" className="return-label">{t('label')}</label>
      <input id="order-id" name="order-id" value={orderId} onChange={(e) => setOrderId(e.target.value)} className="return-input" autoComplete="off" required />
      <button type="submit" className="return-btn" disabled={pending || !orderId.trim()}>{t('button')}</button>
      {status && <p className={`return-msg return-msg-${status}`} role="status">{t(status)}</p>}
    </form>
  );
}
