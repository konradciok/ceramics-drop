'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Props = {
  orderId: string;
  status: string;
  hasEmail: boolean;
  hasShipment: boolean;
  canRefund: boolean;
  amountLabel: string;
};

type Confirming = 'refund' | 'release' | null;

export function OrderActions(props: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);

  async function post(path: string, label: string) {
    setBusy(label);
    setMsg(null);
    setConfirming(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: props.orderId }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setMsg({ ok: true, text: data.message || 'Gotowe.' });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Błąd' });
    } finally {
      setBusy(null);
    }
  }

  const resend = () => void post('/api/admin/resend-confirmation', 'resend');
  const openLabel = () => window.open(`/api/admin/label?orderId=${props.orderId}`, '_blank', 'noopener');

  if (confirming) {
    const text =
      confirming === 'refund'
        ? `Na pewno zwrócić ${props.amountLabel}?`
        : 'Zwolnić zarezerwowane prace? Wrócą do sprzedaży.';
    const onConfirm = () =>
      void post(confirming === 'refund' ? '/api/admin/refund' : '/api/admin/release-reservation', confirming);

    return (
      <>
        <div className="adm-actions">
          <span className="adm-muted">{text}</span>
          <button className="adm-btn danger" disabled={busy !== null} onClick={onConfirm}>
            {busy === confirming ? 'Trwa…' : 'Tak'}
          </button>
          <button className="adm-btn" disabled={busy !== null} onClick={() => setConfirming(null)}>
            Anuluj
          </button>
        </div>
        {msg && <p className={`adm-action-msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</p>}
      </>
    );
  }

  return (
    <>
      <div className="adm-actions">
        {props.canRefund && (
          <button className="adm-btn danger" disabled={busy !== null} onClick={() => setConfirming('refund')}>
            Zwrot płatności
          </button>
        )}
        {props.hasEmail && (
          <button className="adm-btn" disabled={busy !== null} onClick={resend}>
            {busy === 'resend' ? 'Wysyłam…' : 'Wyślij ponownie potwierdzenie'}
          </button>
        )}
        {props.hasShipment && (
          <button className="adm-btn" onClick={openLabel}>
            Etykieta A6 (PDF)
          </button>
        )}
        {props.status !== 'paid' && (
          <button className="adm-btn danger" disabled={busy !== null} onClick={() => setConfirming('release')}>
            Zwolnij rezerwację
          </button>
        )}
      </div>
      {msg && <p className={`adm-action-msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</p>}
    </>
  );
}
