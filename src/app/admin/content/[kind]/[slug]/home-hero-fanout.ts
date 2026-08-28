/**
 * Pure composition helpers for the home-hero editor's media fan-out save.
 * Kept free of React/DOM so the intricate part of that flow — building each
 * locale's payload and interpreting the settled results — is unit-testable
 * without a browser or a mocked `fetch`.
 */
import type { CmsLocale, HeroMediaSlot, HomePagePayload } from '@/lib/cms/types';

export type HomeCopy = Pick<HomePagePayload, 'heroLine1' | 'heroLine2' | 'heroTagline' | 'ctaLabel' | 'heroAlt'>;

export type SharedHeroMedia = { desktop: HeroMediaSlot; mobile: HeroMediaSlot };

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
