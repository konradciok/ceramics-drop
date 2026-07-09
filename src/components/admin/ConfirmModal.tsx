'use client';

/* Confirmation dialog for destructive admin actions — replaces the inline
   "Na pewno? [Tak] [Anuluj]" state that each component re-implemented. */
export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'Tak',
  cancelLabel = 'Anuluj',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title?: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="adm-modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="adm-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        {title ? <h3 className="adm-modal-title">{title}</h3> : null}
        <div className="adm-modal-body">{message}</div>
        <div className="adm-actions adm-modal-actions">
          <button
            type="button"
            className={`adm-btn ${danger ? 'danger' : ''}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? 'Trwa…' : confirmLabel}
          </button>
          <button type="button" className="adm-btn" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
