'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConfirmModal } from '@/components/admin/ConfirmModal';
import { shipmentNeedsBuy, type FulfillmentStage } from '@/lib/admin/fulfillment';

type Props = {
  orderId: string;
  stage: FulfillmentStage;
  inpostShipmentId: string | null;
  deliveryStatus: string | null;
  compact?: boolean;
};

export function FulfillmentActions({ orderId, stage, inpostShipmentId, deliveryStatus, compact = false }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmingRecreate, setConfirmingRecreate] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const openLabel = () => window.open(`/api/admin/label?orderId=${orderId}`, '_blank', 'noopener');
  const needsBuy = shipmentNeedsBuy({ inpost_shipment_id: inpostShipmentId, delivery_status: deliveryStatus });

  async function postShipment(recreate: boolean): Promise<boolean> {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/admin/create-shipment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, recreate }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setMsg({ ok: true, text: data.message || 'Gotowe.' });
      router.refresh();
      return true;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Błąd' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const onConfirmRecreate = () => {
    void postShipment(true).then((ok) => {
      if (ok) setConfirmingRecreate(false);
    });
  };

  if (stage === 'pickup') {
    return <span className="adm-muted">Do kontaktu</span>;
  }
  if (stage === 'prodigi') {
    return <span className="adm-muted">Wysyłka: Prodigi</span>;
  }

  return (
    <>
      <div className={compact ? 'adm-fulfillment-actions compact' : 'adm-fulfillment-actions'}>
        {stage === 'blocked' ? (
          <button className="adm-btn" disabled={busy} onClick={() => void postShipment(false)}>
            {busy ? 'Tworzę…' : 'Utwórz przesyłkę'}
          </button>
        ) : null}
        {stage === 'ready' || stage === 'in_transit' ? (
          needsBuy ? (
            <>
              <button className="adm-btn" disabled={busy} onClick={() => void postShipment(false)}>
                {busy && !confirmingRecreate ? 'Kupuję…' : 'Ponów'}
              </button>
              <button
                className="adm-btn"
                disabled={busy}
                onClick={() => setConfirmingRecreate(true)}
              >
                Utwórz nową przesyłkę
              </button>
            </>
          ) : (
            <button className="adm-btn" onClick={openLabel}>
              Drukuj etykietę
            </button>
          )
        ) : null}
        {msg && <p className={`adm-action-msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</p>}
      </div>

      <ConfirmModal
        open={confirmingRecreate}
        danger
        busy={busy}
        message="Utworzyć nową przesyłkę InPost? Stara zostanie osierocona w ShipX."
        onConfirm={onConfirmRecreate}
        onCancel={() => setConfirmingRecreate(false)}
      />
    </>
  );
}
