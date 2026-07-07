'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { FulfillmentStage } from '@/lib/admin/fulfillment';

type Props = {
  orderId: string;
  stage: FulfillmentStage;
  compact?: boolean;
};

export function FulfillmentActions({ orderId, stage, compact = false }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const openLabel = () => window.open(`/api/admin/label?orderId=${orderId}`, '_blank', 'noopener');

  async function createShipment() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/admin/create-shipment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setMsg({ ok: true, text: data.message || 'Gotowe.' });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Błąd' });
    } finally {
      setBusy(false);
    }
  }

  if (stage === 'pickup') {
    return <span className="adm-muted">Do kontaktu</span>;
  }
  if (stage === 'prodigi') {
    return <span className="adm-muted">Wysyłka: Prodigi</span>;
  }

  return (
    <div className={compact ? 'adm-fulfillment-actions compact' : 'adm-fulfillment-actions'}>
      {stage === 'blocked' ? (
        <button className="adm-btn" disabled={busy} onClick={createShipment}>
          {busy ? 'Tworzę…' : 'Utwórz przesyłkę'}
        </button>
      ) : null}
      {stage === 'ready' || stage === 'in_transit' ? (
        <button className="adm-btn" onClick={openLabel}>
          Drukuj etykietę
        </button>
      ) : null}
      {msg && <p className={`adm-action-msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</p>}
    </div>
  );
}
