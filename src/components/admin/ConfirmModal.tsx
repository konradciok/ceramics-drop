'use client';

/* Confirmation dialog for destructive admin actions — replaces the inline
   "Na pewno? [Tak] [Anuluj]" state that each component re-implemented.
   Accessible: labelled dialog, initial focus on confirm, Tab trap, Escape to
   cancel (both gated while an action is in flight so a mid-request dismiss can't
   leave the operator thinking it was cancelled). */
import { useEffect, useRef, type ReactNode } from 'react';

const TITLE_ID = 'adm-confirm-title';

/** Modal that asks the operator to confirm a destructive admin action. */
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
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    confirmRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === 'Tab') {
        const focusables = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
        if (!focusables || focusables.length === 0) {
          // While busy both buttons are disabled — keep focus on the dialog itself
          // rather than letting Tab escape to the page behind the backdrop.
          e.preventDefault();
          dialogRef.current?.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div className="adm-modal-backdrop" role="presentation" onClick={busy ? undefined : onCancel}>
      <div
        ref={dialogRef}
        className="adm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={TITLE_ID} className={title ? 'adm-modal-title' : 'adm-sr-only'}>
          {title ?? 'Potwierdzenie'}
        </h3>
        <div className="adm-modal-body">{message}</div>
        <div className="adm-actions adm-modal-actions">
          <button
            ref={confirmRef}
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
