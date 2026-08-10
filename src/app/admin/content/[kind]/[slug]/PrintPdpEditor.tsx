'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { CMS_LOCALES, CmsLocale, PrintPdpPayload } from '@/lib/cms/types';
import type { ContentEditorState } from '@/lib/admin/content';
import { postJson, type FieldErrors } from './editor-shared';

const LOCALES = ['pl', 'en', 'es', 'de'] as const satisfies typeof CMS_LOCALES;

const FIELDS = [
  { path: 'artist.name' as const, label: 'Artystka — imię i nazwisko', rows: 1 },
  { path: 'artist.bio' as const, label: 'Artystka — bio (puste = sekcja ukryta)', rows: 5 },
  { path: 'accordions.productDetails' as const, label: 'Akordeon: szczegóły produktu (puste = ukryty)', rows: 5 },
  { path: 'accordions.framing' as const, label: 'Akordeon: oprawa i passe-partout (puste = ukryty)', rows: 5 },
  { path: 'accordions.shipping' as const, label: 'Akordeon: wysyłka i zwroty (puste = ukryty)', rows: 5 },
];

type FieldPath = (typeof FIELDS)[number]['path'];

function getField(payload: PrintPdpPayload, path: FieldPath): string {
  const [a, b] = path.split('.') as [keyof PrintPdpPayload, string];
  return ((payload[a] as Record<string, string>)[b] ?? '');
}

function setField(payload: PrintPdpPayload, path: FieldPath, value: string): PrintPdpPayload {
  const [a, b] = path.split('.') as [keyof PrintPdpPayload, string];
  return { ...payload, [a]: { ...(payload[a] as Record<string, string>), [b]: value } };
}

function asPayload(raw: unknown): PrintPdpPayload {
  const p = (raw ?? {}) as Partial<PrintPdpPayload>;
  return {
    artist: { name: p.artist?.name ?? '', bio: p.artist?.bio ?? '' },
    accordions: {
      productDetails: p.accordions?.productDetails ?? '',
      framing: p.accordions?.framing ?? '',
      shipping: p.accordions?.shipping ?? '',
    },
  };
}

export function PrintPdpEditor({ state }: { state: ContentEditorState }) {
  const router = useRouter();
  const [activeLocale, setActiveLocale] = useState<CmsLocale>('pl');
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [payloads, setPayloads] = useState<Record<CmsLocale, PrintPdpPayload>>(() =>
    Object.fromEntries(LOCALES.map((locale) => [locale, asPayload(state.locales[locale].payload)])) as Record<CmsLocale, PrintPdpPayload>,
  );

  const payload = payloads[activeLocale];
  const current = state.locales[activeLocale];
  const latestVersion = current.latestDraft?.version ?? current.published?.version ?? null;
  const saved = asPayload(current.payload);
  const isDirty = FIELDS.some((f) => getField(payload, f.path).trim() !== getField(saved, f.path).trim());

  function update(path: FieldPath, value: string) {
    setPayloads((prev) => ({ ...prev, [activeLocale]: setField(prev[activeLocale], path, value) }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
  }

  async function saveDraft() {
    setBusy('draft');
    setMessage(null);
    setErrors({});
    try {
      const data = await postJson('/api/admin/content/draft', {
        kind: state.kind,
        slug: state.slug,
        locale: activeLocale,
        payload,
      });
      setMessage({ ok: true, text: `Szkic zapisany jako wersja ${data.version?.version ?? ''}.` });
      startTransition(() => router.refresh());
    } catch (err) {
      setErrors((err as Error & { fields?: FieldErrors }).fields ?? {});
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Blad zapisu.' });
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (!latestVersion) return;
    setBusy('publish');
    setMessage(null);
    try {
      await postJson('/api/admin/content/publish', {
        kind: state.kind,
        slug: state.slug,
        locale: activeLocale,
        version: latestVersion,
      });
      setMessage({ ok: true, text: `Opublikowano wersje ${latestVersion}.` });
      startTransition(() => router.refresh());
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Blad publikacji.' });
    } finally {
      setBusy(null);
    }
  }

  async function preview() {
    if (!latestVersion) return;
    setBusy('preview');
    setMessage(null);
    try {
      const data = await postJson('/api/admin/content/preview', {
        kind: state.kind,
        slug: state.slug,
        locale: activeLocale,
        version: latestVersion,
      });
      if (data.path && data.token) window.open(`${data.path}?preview=${encodeURIComponent(data.token)}`, '_blank', 'noopener');
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Blad podgladu.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="adm-editor">
      <div className="adm-tabs" role="tablist" aria-label="Locale">
        {LOCALES.map((locale) => {
          const localeState = state.locales[locale];
          const cls = localeState.published ? 'published' : localeState.latestDraft ? 'pending' : 'missing';
          return (
            <button
              key={locale}
              className={`adm-tab ${activeLocale === locale ? 'is-active' : ''}`}
              type="button"
              onClick={() => {
                setActiveLocale(locale);
                setMessage(null);
                setErrors({});
              }}
              role="tab"
              aria-selected={activeLocale === locale}
            >
              <span>{locale}</span>
              <span className={`adm-locale ${cls}`}>{localeState.published ? 'pub' : localeState.latestDraft ? 'draft' : 'missing'}</span>
            </button>
          );
        })}
      </div>

      <div className="adm-panel">
        <div className="adm-editor-head">
          <div>
            <h2 className="adm-section-title">Sekcje print PDP</h2>
            <p className="adm-sub adm-sub--tight">
              Ostatni szkic: {current.latestDraft?.version ?? 'brak'} · opublikowana: {current.published?.version ?? 'brak'}
            </p>
          </div>
          <div className="adm-actions adm-actions--top">
            <button className="adm-btn" type="button" disabled={busy !== null || pending} onClick={saveDraft}>
              {busy === 'draft' ? 'Zapisuje...' : 'Zapisz szkic'}
            </button>
            <button className="adm-btn" type="button" disabled={!latestVersion || isDirty || busy !== null || pending} onClick={preview}>
              {busy === 'preview' ? 'Otwieram...' : 'Podglad'}
            </button>
            <button className="adm-btn" type="button" disabled={!latestVersion || isDirty || busy !== null || pending} onClick={publish}>
              {busy === 'publish' ? 'Publikuje...' : 'Publikuj'}
            </button>
          </div>
        </div>

        {isDirty ? <div className="adm-banner">Masz niezapisane zmiany — zapisz szkic przed podgladem lub publikacja.</div> : null}
        <div className="adm-banner">Puste pole wylacza dana sekcje na stronie produktu. Bez opublikowanego dokumentu strona uzywa tekstow domyslnych z tlumaczen.</div>

        <div className="adm-note-list">
          {FIELDS.map((field) => (
            <label className="adm-note-row" key={field.path}>
              <span className="adm-note-body">
                <span className="adm-note-label">
                  <span>{field.label}</span>
                  <span className="adm-mono">{field.path}</span>
                </span>
                <textarea
                  className={errors[field.path] ? 'has-error' : ''}
                  value={getField(payload, field.path)}
                  onChange={(event) => update(field.path, event.target.value)}
                  rows={field.rows}
                />
                {errors[field.path] ? <span className="adm-field-error">{errors[field.path]}</span> : null}
              </span>
            </label>
          ))}
        </div>

        {message ? <p className={`adm-action-msg ${message.ok ? 'ok' : 'err'}`}>{message.text}</p> : null}
      </div>
    </div>
  );
}
