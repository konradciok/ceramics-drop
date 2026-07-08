'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { CMS_LOCALES, CmsLocale } from '@/lib/cms/types';
import type { ContentEditorState } from '@/lib/admin/content';

type Props = {
  state: ContentEditorState;
};

type FieldErrors = Record<string, string>;

const LOCALES = ['pl', 'en', 'es', 'de'] as const satisfies typeof CMS_LOCALES;

function notesFromPayload(payload: unknown, count: number): string[] {
  const notes = (payload as { notes?: unknown })?.notes;
  if (!Array.isArray(notes)) return Array.from({ length: count }, () => '');
  return Array.from({ length: count }, (_, i) => (typeof notes[i] === 'string' ? notes[i] : ''));
}

async function postJson(path: string, body: unknown) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; fields?: FieldErrors; version?: { version: number }; path?: string; token?: string };
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`) as Error & { fields?: FieldErrors };
    err.fields = data.fields;
    throw err;
  }
  return data;
}

export function ContentEditor({ state }: Props) {
  const router = useRouter();
  const [activeLocale, setActiveLocale] = useState<CmsLocale>('pl');
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notesByLocale, setNotesByLocale] = useState<Record<CmsLocale, string[]>>(() => {
    return Object.fromEntries(LOCALES.map((locale) => [
      locale,
      notesFromPayload(state.locales[locale].payload, state.items.length),
    ])) as Record<CmsLocale, string[]>;
  });

  const notes = notesByLocale[activeLocale];
  const current = state.locales[activeLocale];
  const latestVersion = current.latestDraft?.version ?? current.published?.version ?? null;

  const emptyIndexes = useMemo(
    () => notes.map((note, index) => (note.trim() ? null : index)).filter((index): index is number => index !== null),
    [notes],
  );

  function updateNote(index: number, value: string) {
    setNotesByLocale((prev) => ({
      ...prev,
      [activeLocale]: prev[activeLocale].map((note, i) => (i === index ? value : note)),
    }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[`notes.${index}`];
      delete next.notes;
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
        payload: { notes },
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
            <h2 className="adm-section-title">Notatki produktu</h2>
            <p className="adm-sub adm-sub--tight">
              {state.items.length} pol. Ostatni szkic: {current.latestDraft?.version ?? 'brak'} · opublikowana: {current.published?.version ?? 'brak'}
            </p>
          </div>
          <div className="adm-actions adm-actions--top">
            <button className="adm-btn" type="button" disabled={busy !== null || pending} onClick={saveDraft}>
              {busy === 'draft' ? 'Zapisuje...' : 'Zapisz szkic'}
            </button>
            <button className="adm-btn" type="button" disabled={!latestVersion || busy !== null || pending} onClick={preview}>
              {busy === 'preview' ? 'Otwieram...' : 'Podglad'}
            </button>
            <button className="adm-btn" type="button" disabled={!latestVersion || busy !== null || pending} onClick={publish}>
              {busy === 'publish' ? 'Publikuje...' : 'Publikuj'}
            </button>
          </div>
        </div>

        {emptyIndexes.length > 0 ? (
          <div className="adm-banner">{emptyIndexes.length} pustych opisow. Publikacja wymaga kompletu niepustych notatek.</div>
        ) : null}
        {errors.notes ? <p className="adm-field-error">{errors.notes}</p> : null}

        <div className="adm-note-list">
          {state.items.map((item, index) => (
            <label className="adm-note-row" key={item.id}>
              <span className="adm-note-media">
                {item.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.image} alt="" />
                ) : (
                  <span className="adm-item-noimg" />
                )}
              </span>
              <span className="adm-note-body">
                <span className="adm-note-label">
                  <span>{item.label}</span>
                  <span className="adm-mono">{item.id}</span>
                </span>
                <textarea
                  className={errors[`notes.${index}`] ? 'has-error' : ''}
                  value={notes[index] ?? ''}
                  onChange={(event) => updateNote(index, event.target.value)}
                  rows={3}
                />
                {errors[`notes.${index}`] ? <span className="adm-field-error">{errors[`notes.${index}`]}</span> : null}
              </span>
            </label>
          ))}
        </div>

        {message ? <p className={`adm-action-msg ${message.ok ? 'ok' : 'err'}`}>{message.text}</p> : null}
      </div>
    </div>
  );
}
