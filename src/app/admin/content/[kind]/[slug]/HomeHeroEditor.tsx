'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { CMS_LOCALES, CmsLocale, HeroMediaSlot, HomePagePayload } from '@/lib/cms/types';
import type { ContentEditorState } from '@/lib/admin/content';
import { siteMediaUrl } from '@/lib/site-media';
import { postJson, type FieldErrors } from './editor-shared';

const LOCALES = ['pl', 'en', 'es', 'de'] as const satisfies typeof CMS_LOCALES;

type HomeCopy = Pick<HomePagePayload, 'heroLine1' | 'heroLine2' | 'heroTagline' | 'ctaLabel' | 'heroAlt'>;

const TEXT_FIELDS: { key: keyof HomeCopy; label: string; rows: number }[] = [
  { key: 'heroLine1', label: 'Hero — wiersz 1', rows: 1 },
  { key: 'heroLine2', label: 'Hero — wiersz 2', rows: 1 },
  { key: 'heroTagline', label: 'Hero — tagline (opcjonalny)', rows: 2 },
  { key: 'ctaLabel', label: 'Przycisk CTA — etykieta', rows: 1 },
  { key: 'heroAlt', label: 'Tekst alternatywny obrazu/wideo (opcjonalny)', rows: 2 },
];

/** A slot mid-edit: a video may exist with its poster not yet uploaded, which
    `HeroMediaSlot` (the published payload shape) cannot represent — the
    schema requires a poster on every video. Slots stay in this wider shape
    until save time, when an incomplete video blocks saving instead of being
    silently dropped. */
type EditableHeroMediaSlot =
  | { kind: 'image'; key: string; width: number; height: number }
  | { kind: 'video'; key: string; poster: { key: string; width: number; height: number } | null }
  | null;

type EditableMedia = { desktop: EditableHeroMediaSlot; mobile: EditableHeroMediaSlot };

type SlotTarget = 'desktop' | 'mobile';

const GUIDANCE: Record<SlotTarget, { hint: string; maxBytes: number; maxLabel: string }> = {
  desktop: { hint: 'Zalecane: WebP, ok. 2400–2800px szerokości, poniżej 700 KB.', maxBytes: 700 * 1024, maxLabel: '700 KB' },
  mobile: { hint: 'Zalecane: WebP, ok. 1080×1350px, poniżej 350 KB.', maxBytes: 350 * 1024, maxLabel: '350 KB' },
};

function asCopy(raw: unknown): HomeCopy {
  const p = (raw ?? {}) as Partial<HomePagePayload>;
  return {
    heroLine1: p.heroLine1 ?? '',
    heroLine2: p.heroLine2 ?? '',
    heroTagline: p.heroTagline ?? '',
    ctaLabel: p.ctaLabel ?? '',
    heroAlt: p.heroAlt ?? '',
  };
}

function asEditableMedia(raw: unknown): EditableMedia {
  const p = (raw ?? {}) as Partial<HomePagePayload>;
  return {
    desktop: (p.media?.desktop as EditableHeroMediaSlot | undefined) ?? null,
    mobile: (p.media?.mobile as EditableHeroMediaSlot | undefined) ?? null,
  };
}

function isSlotIncomplete(slot: EditableHeroMediaSlot): boolean {
  return slot !== null && slot.kind === 'video' && slot.poster === null;
}

function mediaEqual(a: EditableMedia, b: EditableMedia): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Reads a File's intrinsic pixel dimensions via a transient object URL —
    never rendered, revoked immediately after the read. The persisted preview
    always comes from `/api/media/<key>` after upload, never from a blob URL. */
function readDimensions(file: File): Promise<{ width: number; height: number }> {
  const isVideo = file.type.startsWith('video/');
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const cleanup = () => URL.revokeObjectURL(url);
    if (isVideo) {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.onloadedmetadata = () => {
        resolve({ width: video.videoWidth, height: video.videoHeight });
        cleanup();
      };
      video.onerror = () => {
        cleanup();
        reject(new Error('Nie udalo sie odczytac wymiarow wideo.'));
      };
      video.src = url;
    } else {
      const img = new Image();
      img.onload = () => {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
        cleanup();
      };
      img.onerror = () => {
        cleanup();
        reject(new Error('Nie udalo sie odczytac wymiarow obrazu.'));
      };
      img.src = url;
    }
  });
}

async function uploadFile(file: File): Promise<{ key: string; width: number; height: number; contentType: string }> {
  const { width, height } = await readDimensions(file);
  const res = await fetch(`/api/admin/content/media?width=${width}&height=${height}`, {
    method: 'POST',
    headers: { 'content-type': file.type },
    body: file,
  });
  const data = (await res.json().catch(() => ({}))) as { key?: string; contentType?: string; error?: string };
  if (!res.ok || !data.key || !data.contentType) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return { key: data.key, width, height, contentType: data.contentType };
}

function sizeWarning(target: SlotTarget, file: File): string | null {
  const g = GUIDANCE[target];
  if (file.size <= g.maxBytes) return null;
  return `Plik wiekszy niz zalecane ${g.maxLabel} (${(file.size / 1024).toFixed(0)} KB) — przeslano mimo to.`;
}

export function HomeHeroEditor({ state }: { state: ContentEditorState }) {
  const router = useRouter();
  const [activeLocale, setActiveLocale] = useState<CmsLocale>('pl');
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [slotBusy, setSlotBusy] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [slotWarnings, setSlotWarnings] = useState<Record<string, string | null>>({});
  const [mediaFannedOut, setMediaFannedOut] = useState(false);

  const [copies, setCopies] = useState<Record<CmsLocale, HomeCopy>>(() =>
    Object.fromEntries(LOCALES.map((locale) => [locale, asCopy(state.locales[locale].payload)])) as Record<CmsLocale, HomeCopy>,
  );
  const [media, setMedia] = useState<EditableMedia>(() => asEditableMedia(state.locales.pl.payload));

  const copy = copies[activeLocale];
  const current = state.locales[activeLocale];
  const latestVersion = current.latestDraft?.version ?? current.published?.version ?? null;
  const savedCopy = asCopy(current.payload);
  const savedMedia = asEditableMedia(current.payload);

  const textDirty = TEXT_FIELDS.some((f) => (copy[f.key] ?? '').trim() !== (savedCopy[f.key] ?? '').trim());
  const mediaDirty = !mediaEqual(media, savedMedia);
  const isDirty = textDirty || mediaDirty;
  const mediaIncomplete = isSlotIncomplete(media.desktop) || isSlotIncomplete(media.mobile);
  const anySlotBusy = Object.values(slotBusy).some(Boolean);

  function updateText(key: keyof HomeCopy, value: string) {
    setCopies((prev) => ({ ...prev, [activeLocale]: { ...prev[activeLocale], [key]: value } }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function handleSlotUpload(target: SlotTarget, file: File) {
    const busyKey = target;
    setSlotBusy((prev) => ({ ...prev, [busyKey]: true }));
    setMessage(null);
    try {
      const uploaded = await uploadFile(file);
      const isVideo = uploaded.contentType.startsWith('video/');
      setMedia((prev) => ({
        ...prev,
        [target]: isVideo
          ? { kind: 'video', key: uploaded.key, poster: null }
          : { kind: 'image', key: uploaded.key, width: uploaded.width, height: uploaded.height },
      }));
      setSlotWarnings((prev) => ({ ...prev, [busyKey]: sizeWarning(target, file) }));
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Blad przesylania pliku.' });
    } finally {
      setSlotBusy((prev) => ({ ...prev, [busyKey]: false }));
    }
  }

  async function handlePosterUpload(target: SlotTarget, file: File) {
    const busyKey = `${target}-poster`;
    setSlotBusy((prev) => ({ ...prev, [busyKey]: true }));
    setMessage(null);
    try {
      const uploaded = await uploadFile(file);
      if (uploaded.contentType.startsWith('video/')) {
        throw new Error('Plakat musi byc obrazem, nie wideo.');
      }
      setMedia((prev) => {
        const slot = prev[target];
        if (!slot || slot.kind !== 'video') return prev;
        return {
          ...prev,
          [target]: { ...slot, poster: { key: uploaded.key, width: uploaded.width, height: uploaded.height } },
        };
      });
      setSlotWarnings((prev) => ({ ...prev, [busyKey]: sizeWarning(target, file) }));
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Blad przesylania plakatu.' });
    } finally {
      setSlotBusy((prev) => ({ ...prev, [busyKey]: false }));
    }
  }

  function removeSlot(target: SlotTarget) {
    setMedia((prev) => ({ ...prev, [target]: null }));
    setSlotWarnings((prev) => ({ ...prev, [target]: null, [`${target}-poster`]: null }));
  }

  async function saveDraft() {
    if (mediaIncomplete) {
      setMessage({ ok: false, text: 'Uzupelnij plakat dla wideo przed zapisaniem szkicu.' });
      return;
    }
    setBusy('draft');
    setMessage(null);
    setErrors({});
    setMediaFannedOut(false);
    const finalMedia = { desktop: media.desktop as HeroMediaSlot, mobile: media.mobile as HeroMediaSlot };
    try {
      if (mediaDirty) {
        // Media is a shared panel across locales — fan the new media out to
        // every locale's draft. The active locale gets its edited copy; every
        // other locale keeps its own last-saved copy with only media swapped.
        // Promise.allSettled (not Promise.all): one locale's request can fail
        // server-side (e.g. a stale copy that no longer passes validation)
        // while the other three still land. The admin needs to know exactly
        // which locales saved and which didn't, not one opaque failure that
        // hides three real writes — and dirty-tracking must reflect that per
        // locale (via the router.refresh() below, not by guessing locally).
        const settled = await Promise.allSettled(
          LOCALES.map((locale) => {
            const localeCopy = locale === activeLocale ? copy : asCopy(state.locales[locale].payload);
            const payload: HomePagePayload = { ...localeCopy, media: finalMedia };
            return postJson('/api/admin/content/draft', { kind: state.kind, slug: state.slug, locale, payload });
          }),
        );
        const succeeded: CmsLocale[] = [];
        const failed: { locale: CmsLocale; reason: string }[] = [];
        settled.forEach((result, i) => {
          const locale = LOCALES[i];
          if (result.status === 'fulfilled') succeeded.push(locale);
          else failed.push({ locale, reason: result.reason instanceof Error ? result.reason.message : 'Blad zapisu.' });
        });
        setMediaFannedOut(failed.length === 0);
        if (failed.length === 0) {
          const ownResult = settled[LOCALES.indexOf(activeLocale)];
          const ownVersion = ownResult.status === 'fulfilled' ? ownResult.value.version?.version : undefined;
          setMessage({ ok: true, text: `Szkic zapisany dla wszystkich 4 jezykow (media) — ta wersja: ${ownVersion ?? ''}.` });
        } else {
          const okText = succeeded.length > 0 ? `Zapisano dla: ${succeeded.join(', ')}. ` : '';
          const failText = failed.map((f) => `${f.locale} (${f.reason})`).join('; ');
          setMessage({ ok: false, text: `${okText}Niepowodzenie dla: ${failText}.` });
        }
      } else {
        const payload: HomePagePayload = { ...copy, media: finalMedia };
        const data = await postJson('/api/admin/content/draft', {
          kind: state.kind,
          slug: state.slug,
          locale: activeLocale,
          payload,
        });
        setMessage({ ok: true, text: `Szkic zapisany jako wersja ${data.version?.version ?? ''}.` });
      }
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

  function renderSlot(target: SlotTarget) {
    const slot = media[target];
    const guidance = GUIDANCE[target];
    const isBusy = slotBusy[target] === true;
    const isPosterBusy = slotBusy[`${target}-poster`] === true;
    const warning = slotWarnings[target];
    const posterWarning = slotWarnings[`${target}-poster`];
    const label = target === 'desktop' ? 'Desktop' : 'Mobile';

    return (
      <div className="adm-media-card" key={target}>
        <div className="adm-media-card-head">
          <span className="adm-media-card-title">{label}</span>
          {slot ? (
            <button className="adm-btn adm-btn--sm" type="button" onClick={() => removeSlot(target)} disabled={isBusy || isPosterBusy}>
              Usun
            </button>
          ) : null}
        </div>

        {slot?.kind === 'image' ? (
          <div className="adm-media-preview">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={siteMediaUrl(slot.key)} alt="" />
            <span className="adm-media-dims">{slot.width}×{slot.height}px</span>
          </div>
        ) : slot?.kind === 'video' ? (
          <div className="adm-media-preview">
            <video src={siteMediaUrl(slot.key)} muted controls poster={slot.poster ? siteMediaUrl(slot.poster.key) : undefined} />
            {slot.poster ? (
              <span className="adm-media-dims">Plakat: {slot.poster.width}×{slot.poster.height}px</span>
            ) : (
              <span className="adm-media-dims adm-media-dims--warn">Brak plakatu — wymagany przed zapisem</span>
            )}
          </div>
        ) : (
          <div className="adm-media-empty">Brak pliku — strona uzyje domyslnego obrazu.</div>
        )}

        <p className="adm-sub adm-sub--tight">{guidance.hint}</p>
        {warning ? <p className="adm-field-error">{warning}</p> : null}

        <label className="adm-media-upload">
          <span>{slot ? 'Zamien plik' : 'Wybierz plik'}</span>
          <input
            type="file"
            accept="image/webp,image/jpeg,image/png,video/mp4,video/webm"
            disabled={isBusy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void handleSlotUpload(target, file);
            }}
          />
        </label>
        {isBusy ? <p className="adm-sub adm-sub--tight">Przesylanie...</p> : null}

        {slot?.kind === 'video' ? (
          <>
            <label className="adm-media-upload">
              <span>{slot.poster ? 'Zamien plakat' : 'Dodaj plakat (wymagany)'}</span>
              <input
                type="file"
                accept="image/webp,image/jpeg,image/png"
                disabled={isPosterBusy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void handlePosterUpload(target, file);
                }}
              />
            </label>
            {isPosterBusy ? <p className="adm-sub adm-sub--tight">Przesylanie plakatu...</p> : null}
            {posterWarning ? <p className="adm-field-error">{posterWarning}</p> : null}
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="adm-editor adm-editor--fixed-fields">
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
            <h2 className="adm-section-title">Hero strony glownej</h2>
            <p className="adm-sub adm-sub--tight">
              Ostatni szkic: {current.latestDraft?.version ?? 'brak'} · opublikowana: {current.published?.version ?? 'brak'}
            </p>
          </div>
          <div className="adm-actions adm-actions--top">
            <button className="adm-btn" type="button" disabled={busy !== null || pending || anySlotBusy} onClick={saveDraft}>
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
        {mediaIncomplete ? <div className="adm-banner">Wideo wymaga plakatu (obrazu) przed zapisaniem szkicu.</div> : null}
        {mediaFannedOut ? (
          <div className="adm-banner">Media zostaly zapisane w szkicach wszystkich 4 jezykow. Pamietaj, by opublikowac kazdy jezyk osobno.</div>
        ) : null}

        <div className="adm-note-list">
          {TEXT_FIELDS.map((field) => (
            <label className="adm-note-row adm-note-row--form adm-note-row--compact" key={field.key}>
              <span className="adm-note-body">
                <span className="adm-note-label">
                  <span>{field.label}</span>
                  <span className="adm-mono">{field.key}</span>
                </span>
                <textarea
                  className={errors[field.key] ? 'has-error' : ''}
                  value={copy[field.key]}
                  onChange={(event) => updateText(field.key, event.target.value)}
                  rows={field.rows}
                />
                {errors[field.key] ? <span className="adm-field-error">{errors[field.key]}</span> : null}
              </span>
            </label>
          ))}
        </div>

        <div className="adm-media-panel">
          <h3 className="adm-section-title">Media (wspolne dla wszystkich jezykow)</h3>
          <div className="adm-media-grid">
            {renderSlot('desktop')}
            {renderSlot('mobile')}
          </div>
        </div>

        {message ? <p className={`adm-action-msg ${message.ok ? 'ok' : 'err'}`}>{message.text}</p> : null}
      </div>
    </div>
  );
}
