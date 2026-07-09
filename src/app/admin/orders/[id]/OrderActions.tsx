'use client';

import { useState } from 'react';
import { useAdminAction } from '@/components/admin/useAdminAction';
import { ConfirmModal } from '@/components/admin/ConfirmModal';

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
  const { run, busy } = useAdminAction();
  const [confirming, setConfirming] = useState<Confirming>(null);

  const body = { orderId: props.orderId };
  const openLabel = () =>
    window.open(`/api/admin/label?orderId=${props.orderId}`, '_blank', 'noopener');

  const onConfirm = () => {
    if (!confirming) return;
    const path = confirming === 'refund' ? '/api/admin/refund' : '/api/admin/release-reservation';
    // Keep the success toast (a refund returns "…(re_…)") so the id survives for a
    // Stripe Dashboard cross-check instead of auto-dismissing.
    void run(confirming, path, { body, stickyToast: true }).then((ok) => {
      if (ok) setConfirming(null);
    });
  };

  return (
    <>
      <div className="adm-actions">
        {props.canRefund && (
          <button
            type="button"
            className="adm-btn danger"
            disabled={busy !== null}
            onClick={() => setConfirming('refund')}
          >
            Zwrot płatności
          </button>
        )}
        {props.hasEmail && (
          <button
            type="button"
            className="adm-btn"
            disabled={busy !== null}
            onClick={() => void run('resend', '/api/admin/resend-confirmation', { body })}
          >
            {busy === 'resend' ? 'Wysyłam…' : 'Wyślij ponownie potwierdzenie'}
          </button>
        )}
        {props.hasShipment && (
          <button type="button" className="adm-btn" onClick={openLabel}>
            Etykieta A6 (PDF)
          </button>
        )}
        {props.status !== 'paid' && (
          <button
            type="button"
            className="adm-btn danger"
            disabled={busy !== null}
            onClick={() => setConfirming('release')}
          >
            Zwolnij rezerwację
          </button>
        )}
      </div>

      <ConfirmModal
        open={confirming !== null}
        danger
        busy={busy !== null}
        message={
          confirming === 'refund'
            ? `Na pewno zwrócić ${props.amountLabel}?`
            : 'Zwolnić zarezerwowane prace? Wrócą do sprzedaży.'
        }
        onConfirm={onConfirm}
        onCancel={() => setConfirming(null)}
      />
    </>
  );
}
