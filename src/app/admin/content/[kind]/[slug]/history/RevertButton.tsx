'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { CmsDocumentKind, CmsLocale } from '@/lib/cms/types';

type Props = {
  kind: CmsDocumentKind;
  slug: string;
  locale: CmsLocale;
  version: number;
};

export function RevertButton({ kind, slug, locale, version }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  async function revert() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/content/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, slug, locale, version }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      startTransition(() => router.refresh());
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Blad przywracania.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="adm-inline-action">
      <button className="adm-btn" type="button" disabled={busy || pending} onClick={revert}>
        {busy ? 'Przywracam...' : 'Przywroc jako szkic'}
      </button>
      {message ? <span className="adm-action-msg err">{message}</span> : null}
    </span>
  );
}
