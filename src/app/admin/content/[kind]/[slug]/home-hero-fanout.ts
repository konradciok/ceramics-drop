/**
 * Pure composition helpers for the home-hero editor's media fan-out save.
 * Kept free of React/DOM so the intricate part of that flow — building each
 * locale's payload and interpreting the settled results — is unit-testable
 * without a browser or a mocked `fetch`.
 */
import type { CmsLocale, HeroMediaSlot, HomePagePayload } from '@/lib/cms/types';

export type HomeCopy = Pick<HomePagePayload, 'heroLine1' | 'heroLine2' | 'heroTagline' | 'ctaLabel' | 'heroAlt'>;

export type SharedHeroMedia = { desktop: HeroMediaSlot; mobile: HeroMediaSlot };

/** A slot mid-edit: a video may exist with its poster not yet uploaded, which
    `HeroMediaSlot` (the published payload shape) cannot represent — the
    schema requires a poster on every video. Slots stay in this wider shape
    until save time, when an incomplete video blocks saving instead of being
    silently dropped. */
export type EditableHeroMediaSlot =
  | { kind: 'image'; key: string; width: number; height: number }
  | { kind: 'video'; key: string; poster: { key: string; width: number; height: number } | null }
  | null;

export type EditableMedia = { desktop: EditableHeroMediaSlot; mobile: EditableHeroMediaSlot };

function slotEqual(a: EditableHeroMediaSlot, b: EditableHeroMediaSlot): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'image' && b.kind === 'image') {
    return a.key === b.key && a.width === b.width && a.height === b.height;
  }
  if (a.kind === 'video' && b.kind === 'video') {
    if (a.key !== b.key) return false;
    if (a.poster === null || b.poster === null) return a.poster === b.poster;
    return a.poster.key === b.poster.key && a.poster.width === b.poster.width && a.poster.height === b.poster.height;
  }
  return false;
}

/**
 * Structural (field-by-field) media equality for the editor's dirty check.
 * MUST NOT be a serialization compare: the editor builds slots in
 * `{ kind, key, ... }` insertion order while Postgres JSONB canonicalises
 * object keys (shortest first), so a just-saved slot comes back from
 * `cms_document_versions.payload` as `{ key, kind, ... }`. A
 * `JSON.stringify` comparison saw those as different, leaving the editor
 * permanently "dirty" after every media save — which disabled
 * preview/publish behind the unsaved-changes banner.
 */
export function mediaEqual(a: EditableMedia, b: EditableMedia): boolean {
  return slotEqual(a.desktop, b.desktop) && slotEqual(a.mobile, b.mobile);
}

/**
 * Builds the per-locale payload to save when the shared media panel is
 * dirty. Every locale gets its OWN in-memory copy (`copies[locale]` — which
 * already reflects any unsaved edit made on that locale's tab) paired with
 * the one shared media selection. Fanning out from the active locale's copy
 * (or a locale's last-saved copy) would silently drop unsaved text edits an
 * admin made on another tab before uploading media.
 */
export function buildFanOutPayloads(
  copies: Record<CmsLocale, HomeCopy>,
  media: SharedHeroMedia,
  locales: readonly CmsLocale[],
): Record<CmsLocale, HomePagePayload> {
  return Object.fromEntries(
    locales.map((locale) => [locale, { ...copies[locale], media }]),
  ) as Record<CmsLocale, HomePagePayload>;
}

export type FanOutFailure = { locale: CmsLocale; reason: string };
export type FanOutPartition = { succeeded: CmsLocale[]; failed: FanOutFailure[] };

/**
 * Partitions a `Promise.allSettled` result — indexed in lockstep with
 * `locales` — into which locales saved and which didn't, extracting a
 * human-readable reason (an `Error.message`, falling back to a generic
 * "Blad zapisu." for a non-Error rejection value).
 */
export function partitionSettled<T>(
  locales: readonly CmsLocale[],
  settled: PromiseSettledResult<T>[],
): FanOutPartition {
  const succeeded: CmsLocale[] = [];
  const failed: FanOutFailure[] = [];
  settled.forEach((result, i) => {
    const locale = locales[i];
    if (result.status === 'fulfilled') {
      succeeded.push(locale);
    } else {
      failed.push({
        locale,
        reason: result.reason instanceof Error ? result.reason.message : 'Blad zapisu.',
      });
    }
  });
  return { succeeded, failed };
}
