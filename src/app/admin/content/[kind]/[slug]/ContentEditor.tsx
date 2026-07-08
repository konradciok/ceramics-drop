'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { CMS_LOCALES, CmsLocale } from '@/lib/cms/types';
import type { ContentEditorState } from '@/lib/admin/content';

type Props = {
  state: ContentEditorState;
};

type FieldErrors = Record<string, string>;
type NotesById = Record<string, string>;

const LOCALES = ['pl', 'en', 'es', 'de'] as const satisfies typeof CMS_LOCALES;

function notesFromPayload(payload: unknown, ids: string[]): NotesById {
  const raw = (payload as { notes?: unknown })?.notes;
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(ids.map((id) => [id, typeof obj[id] === 'string' ? obj[id] : '']));
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
  const itemIds = useMemo(() => state.items.map((item) => item.id), [state.items]);
  const [notesByLocale, setNotesByLocale] = useState<Record<CmsLocale, NotesById>>(() => {
    return Object.fromEntries(LOCALES.map((locale) => [
      locale,
      notesFromPayload(state.locales[locale].payload, itemIds),
    ])) as Record<CmsLocale, NotesById>;
  });

  const notes = notesByLocale[activeLocale];
  const current = state.locales[activeLocale];
  const latestVersion = current.latestDraft?.version ?? current.published?.version ?? null;

  // Dirty = local textarea differs from the persisted payload for this locale.
  // Publish/preview operate on the saved version, so an unsaved edit would
  // silently re-publish stale copy — block both until the draft is saved.
  const savedNotes = (current.payload as { notes?: NotesById })?.notes ?? {};
  const isDirty = itemIds.some((id) => (notes[id] ?? '').trim() !== (savedNotes[id] ?? '').trim());

  const emptyIds = useMemo(
    () => itemIds.map((id) => (notes[id]?.trim() ? null : id)).filter((id): id is string => id !== null),
    [notes, itemIds],
  );

  function updateNote(id: string, value: string) {
    setNotesByLocale((prev) => ({
      ...prev,
      [activeLocale]: { ...prev[activeLocale], [id]: value },
    }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[`notes.${id}`];
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
            <button className="adm-btn" type="button" disabled={!latestVersion || isDirty || busy !== null || pending} onClick={preview}>
              {busy === 'preview' ? 'Otwieram...' : 'Podglad'}
            </button>
            <button className="adm-btn" type="button" disabled={!latestVersion || isDirty || busy !== null || pending} onClick={publish}>
              {busy === 'publish' ? 'Publikuje...' : 'Publikuj'}
            </button>
          </div>
        </div>

        {isDirty ? <div className="adm-banner">Masz niezapisane zmiany — zapisz szkic przed podgladem lub publikacja.</div> : null}
        {emptyIds.length > 0 ? (
          <div className="adm-banner">{emptyIds.length} pustych opisow. Publikacja wymaga kompletu niepustych notatek.</div>
        ) : null}
        {errors.notes ? <p className="adm-field-error">{errors.notes}</p> : null}

        <div className="adm-note-list">
          {state.items.map((item) => (
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
                  className={errors[`notes.${item.id}`] ? 'has-error' : ''}
                  value={notes[item.id] ?? ''}
                  onChange={(event) => updateNote(item.id, event.target.value)}
                  rows={3}
                />
                {errors[`notes.${item.id}`] ? <span className="adm-field-error">{errors[`notes.${item.id}`]}</span> : null}
              </span>
            </label>
          ))}
        </div>

        {message ? <p className={`adm-action-msg ${message.ok ? 'ok' : 'err'}`}>{message.text}</p> : null}
      </div>
    </div>
  );
}
