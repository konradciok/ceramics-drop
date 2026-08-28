import { describe, it, expect } from 'vitest';
import {
  buildFanOutPayloads,
  mediaEqual,
  partitionSettled,
  type EditableHeroMediaSlot,
  type HomeCopy,
} from './home-hero-fanout';
import type { CmsLocale, HeroMediaSlot } from '@/lib/cms/types';

const LOCALES: readonly CmsLocale[] = ['pl', 'en', 'es', 'de'];

function copyFor(locale: CmsLocale): HomeCopy {
  return {
    heroLine1: `line1-${locale}`,
    heroLine2: `line2-${locale}`,
    heroTagline: `tagline-${locale}`,
    ctaLabel: `cta-${locale}`,
    heroAlt: `alt-${locale}`,
  };
}

describe('buildFanOutPayloads', () => {
  it('gives every locale its own in-memory copy plus the shared media', () => {
    const copies = Object.fromEntries(LOCALES.map((l) => [l, copyFor(l)])) as Record<CmsLocale, HomeCopy>;
    const desktop: HeroMediaSlot = { kind: 'image', key: 'a'.repeat(64) + '.webp', width: 100, height: 100 };
    const mobile: HeroMediaSlot = null;
    const media = { desktop, mobile };

    const payloads = buildFanOutPayloads(copies, media, LOCALES);

    for (const locale of LOCALES) {
      expect(payloads[locale]).toEqual({ ...copyFor(locale), media });
    }
  });

  it('does not cross-contaminate one locale copy with another locale text', () => {
    const copies = Object.fromEntries(LOCALES.map((l) => [l, copyFor(l)])) as Record<CmsLocale, HomeCopy>;
    // Simulate an unsaved edit on 'en' only.
    copies.en = { ...copies.en, heroLine1: 'unsaved edit made on the en tab' };
    const media = { desktop: null, mobile: null };

    const payloads = buildFanOutPayloads(copies, media, LOCALES);

    expect(payloads.en.heroLine1).toBe('unsaved edit made on the en tab');
    expect(payloads.pl.heroLine1).toBe('line1-pl');
    expect(payloads.de.heroLine1).toBe('line2-de'.replace('line2', 'line1')); // sanity: de untouched
  });

  it('every payload references the exact same shared media object shape', () => {
    const copies = Object.fromEntries(LOCALES.map((l) => [l, copyFor(l)])) as Record<CmsLocale, HomeCopy>;
    const media = { desktop: null, mobile: null };
    const payloads = buildFanOutPayloads(copies, media, LOCALES);
    for (const locale of LOCALES) {
      expect(payloads[locale].media).toEqual(media);
    }
  });
});

describe('mediaEqual', () => {
  /** The editor builds slots in `{ kind, key, width, height }` insertion
      order; Postgres JSONB canonicalises keys (shortest first) so the same
      slot comes back from a saved draft as `{ key, kind, width, height }`.
      Equality must be structural, never serialization-order-sensitive. */
  const clientImage: EditableHeroMediaSlot = { kind: 'image', key: 'a'.repeat(64) + '.webp', width: 2800, height: 1600 };
  const jsonbImage = JSON.parse(
    `{"key":"${'a'.repeat(64)}.webp","kind":"image","width":2800,"height":1600}`,
  ) as EditableHeroMediaSlot;

  it('treats a client-built image slot and its JSONB round-trip as equal', () => {
    expect(mediaEqual({ desktop: clientImage, mobile: null }, { desktop: jsonbImage, mobile: null })).toBe(true);
  });

  it('treats a client-built video slot and its JSONB round-trip as equal', () => {
    const clientVideo: EditableHeroMediaSlot = {
      kind: 'video',
      key: 'b'.repeat(64) + '.mp4',
      poster: { key: 'c'.repeat(64) + '.webp', width: 1080, height: 1350 },
    };
    const jsonbVideo = JSON.parse(
      `{"key":"${'b'.repeat(64)}.mp4","kind":"video","poster":{"key":"${'c'.repeat(64)}.webp","width":1080,"height":1350}}`,
    ) as EditableHeroMediaSlot;
    expect(mediaEqual({ desktop: clientVideo, mobile: null }, { desktop: jsonbVideo, mobile: null })).toBe(true);
  });

  it('still detects real differences per field and per slot', () => {
    expect(mediaEqual({ desktop: clientImage, mobile: null }, { desktop: null, mobile: null })).toBe(false);
    expect(mediaEqual({ desktop: null, mobile: clientImage }, { desktop: clientImage, mobile: null })).toBe(false);
    expect(
      mediaEqual({ desktop: clientImage, mobile: null }, { desktop: { ...clientImage, width: 2400 }, mobile: null }),
    ).toBe(false);
    expect(
      mediaEqual(
        { desktop: clientImage, mobile: null },
        { desktop: { ...clientImage, key: 'd'.repeat(64) + '.webp' }, mobile: null },
      ),
    ).toBe(false);
  });

  it('distinguishes a video missing its poster from one that has it', () => {
    const withPoster: EditableHeroMediaSlot = {
      kind: 'video',
      key: 'b'.repeat(64) + '.mp4',
      poster: { key: 'c'.repeat(64) + '.webp', width: 1080, height: 1350 },
    };
    const withoutPoster: EditableHeroMediaSlot = { kind: 'video', key: 'b'.repeat(64) + '.mp4', poster: null };
    expect(mediaEqual({ desktop: withPoster, mobile: null }, { desktop: withoutPoster, mobile: null })).toBe(false);
    expect(mediaEqual({ desktop: withoutPoster, mobile: null }, { desktop: withoutPoster, mobile: null })).toBe(true);
  });

  it('never equates an image slot with a video slot', () => {
    const video: EditableHeroMediaSlot = { kind: 'video', key: 'b'.repeat(64) + '.mp4', poster: null };
    expect(mediaEqual({ desktop: clientImage, mobile: null }, { desktop: video, mobile: null })).toBe(false);
  });
});

describe('partitionSettled', () => {
  it('preserves locale pairing on mixed fulfilled/rejected results, order-independent of locale order', () => {
    const settled: PromiseSettledResult<{ ok: true }>[] = [
      { status: 'fulfilled', value: { ok: true } }, // pl
      { status: 'rejected', reason: new Error('walidacja nieudana') }, // en
      { status: 'fulfilled', value: { ok: true } }, // es
      { status: 'rejected', reason: new Error('inny blad') }, // de
    ];

    const { succeeded, failed } = partitionSettled(LOCALES, settled);

    expect(succeeded).toEqual(['pl', 'es']);
    expect(failed).toEqual([
      { locale: 'en', reason: 'walidacja nieudana' },
      { locale: 'de', reason: 'inny blad' },
    ]);
  });

  it('all fulfilled -> everyone succeeded, no failures', () => {
    const settled: PromiseSettledResult<{ ok: true }>[] = LOCALES.map(() => ({
      status: 'fulfilled' as const,
      value: { ok: true },
    }));
    const { succeeded, failed } = partitionSettled(LOCALES, settled);
    expect(succeeded).toEqual([...LOCALES]);
    expect(failed).toEqual([]);
  });

  it('falls back to the Blad zapisu. message when the rejection reason is not an Error', () => {
    const settled: PromiseSettledResult<unknown>[] = [
      { status: 'rejected', reason: 'a plain string rejection' },
      { status: 'fulfilled', value: {} },
      { status: 'rejected', reason: { some: 'object' } },
      { status: 'rejected', reason: undefined },
    ];

    const { failed } = partitionSettled(LOCALES, settled);

    expect(failed).toEqual([
      { locale: 'pl', reason: 'Blad zapisu.' },
      { locale: 'es', reason: 'Blad zapisu.' },
      { locale: 'de', reason: 'Blad zapisu.' },
    ]);
  });
});
