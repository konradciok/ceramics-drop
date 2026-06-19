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

export function OrderActions(props: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function post(path: string, label: string) {
    setBusy(label);
    setMsg(null);
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

  const refund = () => {
    const typed = window.prompt(
      `Zwrot ${props.amountLabel} dla zamówienia ${props.orderId.slice(0, 8)}.\nWpisz ZWROT aby potwierdzić.`,
    );
    if (typed?.trim().toUpperCase() !== 'ZWROT') return;
    void post('/api/admin/refund', 'refund');
  };
  const resend = () => void post('/api/admin/resend-confirmation', 'resend');
  const release = () => {
    if (!window.confirm('Zwolnić zarezerwowane prace tego zamówienia? Wrócą do sprzedaży.')) return;
    void post('/api/admin/release-reservation', 'release');
  };
  const openLabel = () => window.open(`/api/admin/label?orderId=${props.orderId}`, '_blank', 'noopener');

  return (
    <section className="adm-section">
      <h2 className="adm-section-title">Akcje</h2>
      <div className="adm-actions">
        {props.canRefund && (
          <button className="adm-btn danger" disabled={busy !== null} onClick={refund}>
            {busy === 'refund' ? 'Zwracam…' : 'Zwrot płatności'}
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
          <button className="adm-btn danger" disabled={busy !== null} onClick={release}>
            {busy === 'release' ? 'Zwalniam…' : 'Zwolnij rezerwację'}
          </button>
        )}
      </div>
      {msg && <p className={`adm-action-msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</p>}
    </section>
  );
}
