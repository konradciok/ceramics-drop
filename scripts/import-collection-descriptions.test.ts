import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import curationSource from '../config/print-catalog-curation.json';
import { MIN_COLLECTION_DESCRIPTION_LENGTH, collectionMetaDescription, splitCollectionDescription } from '../src/lib/print-collections';
import {
  IMPORT_ACTOR,
  LOCALES,
  MIN_DESCRIPTION_LENGTH,
  loadCollectionStates,
  parseApprovedDescriptions,
  parseArgs,
  planCollection,
  runImport,
  type ApprovedDescriptions,
  type CmsField,
  type CmsPayload,
  type CollectionState,
  type DescriptionLocale,
} from './import-collection-descriptions';

const CURATION = (curationSource as { collections: { slug: string; name: string }[] }).collections;
const KNOWN_SLUGS = CURATION.map((c) => c.slug);
const SEED_ACTOR = 'backfill-script@ceramics-drop.internal';
const EDITOR = 'anna@example.com';

/** A filler description above the 80-char indexability floor, tagged so texts differ per collection and locale. */
const longText = (tag: string) =>
  `${tag}: an abstract watercolour and ink Fine Art Print description, comfortably longer than the eighty character floor.`;

/** An approved-copy entry for one collection: a distinct long text per locale. */
function approvedEntry(name: string): ApprovedDescriptions['collections'][string] {
  return {
    name,
    description: { pl: longText(`${name} pl`), en: longText(`${name} en`), es: longText(`${name} es`), de: longText(`${name} de`) },
  };
}

/** The same entry as it appears in the JSON file (with the designIds the importer ignores). */
const rawEntry = (name: string) => ({ name, designIds: ['fap001'], description: approvedEntry(name).description });
/** A whole descriptions file as parsed JSON; `patch` overrides top-level fields such as `status`. */
const rawFile = (collections: Record<string, unknown>, patch: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  status: 'approved',
  collections,
  ...patch,
});

/** A CMS description field for one locale, shaped like the backfill's. */
function descriptionField(locale: DescriptionLocale, value: string): CmsField {
  return { key: 'description', label: 'Opis kolekcji', type: 'text', value, locale, sourceLocale: 'pl' };
}

/** Payload shaped like scripts/backfill-fine-art-collections.ts seeds it: PL "<name>.", other locales blank. */
function printPayload(name: string, slug: string, descriptions: Partial<Record<DescriptionLocale, string>> = { pl: `${name}.` }): CmsPayload {
  return {
    name,
    fields: [
      ...LOCALES.map((l) => descriptionField(l, descriptions[l] ?? '')),
      { key: 'products', label: 'Produkty i kolejność', type: 'productIds', value: 'fap001,fap002,fap003', locale: 'none', sourceLocale: 'none' },
      { key: 'slug', label: 'Slug', type: 'text', value: slug, locale: 'none', sourceLocale: 'none' },
      { key: 'kind', label: 'Rodzaj', type: 'text', value: 'print-collection', locale: 'none', sourceLocale: 'none' },
    ],
  };
}

/** The description text a payload stores for a locale. */
const valueOf = (payload: CmsPayload, locale: DescriptionLocale) =>
  payload.fields.find((f) => f.key === 'description' && f.locale === locale)?.value;

/** A published print collection at revision 1 still holding the seeded placeholder; override per test. */
function state(overrides: Partial<CollectionState> = {}): CollectionState {
  return {
    id: 'col_ostrea',
    publishedRevision: 1,
    latestRevision: 1,
    latestPayload: printPayload('Ostrea', 'ostrea'),
    latestCreatedBy: SEED_ACTOR,
    ...overrides,
  };
}

describe('parseApprovedDescriptions', () => {
  it('accepts a valid file and trims the texts', () => {
    const raw = rawFile({ ostrea: rawEntry('Ostrea') });
    (raw.collections.ostrea as ReturnType<typeof rawEntry>).description.pl = `  ${longText('Ostrea pl')}\n`;
    const parsed = parseApprovedDescriptions(raw, KNOWN_SLUGS);
    expect(Object.keys(parsed.collections)).toEqual(['ostrea']);
    expect(parsed.collections.ostrea.description.pl).toBe(longText('Ostrea pl'));
  });

  it('refuses copy that has not been approved', () => {
    expect(() => parseApprovedDescriptions(rawFile({ ostrea: rawEntry('Ostrea') }, { status: 'draft-for-approval' }), KNOWN_SLUGS)).toThrow(
      /status must be "approved"/,
    );
  });

  it('refuses an unsupported schemaVersion', () => {
    expect(() => parseApprovedDescriptions(rawFile({ ostrea: rawEntry('Ostrea') }, { schemaVersion: 2 }), KNOWN_SLUGS)).toThrow(/schemaVersion/);
  });

  it('refuses a slug that is not a curated collection', () => {
    expect(() => parseApprovedDescriptions(rawFile({ nope: rawEntry('Nope') }), KNOWN_SLUGS)).toThrow(/unknown collection slug "nope"/);
  });

  it('refuses a collection with a missing locale', () => {
    const entry = rawEntry('Ostrea') as { description: Record<string, string> };
    delete entry.description.de;
    expect(() => parseApprovedDescriptions(rawFile({ ostrea: entry }), KNOWN_SLUGS)).toThrow(/ostrea: missing de description/);
  });

  it('refuses a description too short to make the page indexable, naming the collection and locale', () => {
    const entry = rawEntry('Ostrea') as { description: Record<string, string> };
    entry.description.es = 'Demasiado corto.';
    expect(() => parseApprovedDescriptions(rawFile({ ostrea: entry }), KNOWN_SLUGS)).toThrow(/ostrea\/es: 16 chars/);
  });

  it('refuses an unknown locale key, a missing name and an empty file', () => {
    const extra = rawEntry('Ostrea') as { description: Record<string, string> };
    extra.description.fr = longText('fr');
    expect(() => parseApprovedDescriptions(rawFile({ ostrea: extra }), KNOWN_SLUGS)).toThrow(/unknown locale "fr"/);
    expect(() => parseApprovedDescriptions(rawFile({ ostrea: { ...rawEntry('Ostrea'), name: '' } }), KNOWN_SLUGS)).toThrow(/missing name/);
    expect(() => parseApprovedDescriptions(rawFile({}), KNOWN_SLUGS)).toThrow(/no collections/);
    expect(() => parseApprovedDescriptions(null, KNOWN_SLUGS)).toThrow(/must be an object/);
  });

  it('keeps its indexability floor in step with the storefront', () => {
    expect(MIN_DESCRIPTION_LENGTH).toBe(MIN_COLLECTION_DESCRIPTION_LENGTH);
  });
});

describe('the committed copy package (docs/copy/2026-09-30-opisy-kolekcji)', () => {
  const raw = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL('../docs/copy/2026-09-30-opisy-kolekcji/opisy-kolekcji.json', import.meta.url)), 'utf8'),
  ) as unknown;
  const parsed = parseApprovedDescriptions(raw, KNOWN_SLUGS);

  it('is approved and covers every curated collection in all four locales', () => {
    expect(Object.keys(parsed.collections).sort()).toEqual([...KNOWN_SLUGS].sort());
    for (const { slug } of CURATION) {
      for (const locale of LOCALES) {
        expect(parsed.collections[slug].description[locale].length, `${slug}/${locale}`).toBeGreaterThanOrEqual(MIN_DESCRIPTION_LENGTH);
      }
    }
  });

  it('uses the curated collection names, unchanged in every language', () => {
    for (const { slug, name } of CURATION) {
      expect(parsed.collections[slug].name).toBe(name);
      for (const locale of LOCALES) {
        expect(parsed.collections[slug].description[locale], `${slug}/${locale}`).toContain(name);
      }
    }
  });

  it('gives the collection page a lead and a whole-sentence meta description in every locale', () => {
    for (const { slug } of CURATION) {
      for (const locale of LOCALES) {
        const text = parsed.collections[slug].description[locale];
        const meta = collectionMetaDescription(text);
        expect(meta.length, `${slug}/${locale}`).toBeLessThanOrEqual(155);
        expect(meta.endsWith('…'), `${slug}/${locale} should not need an ellipsis`).toBe(false);
        expect(text.startsWith(meta), `${slug}/${locale}`).toBe(true);
        // Lead = first sentence, short enough to double as the hub card teaser.
        expect(splitCollectionDescription(text).lead.length, `${slug}/${locale} lead`).toBeLessThanOrEqual(140);
      }
    }
  });
});

describe('the regrouping update package (docs/copy/2026-09-30-opisy-kolekcji/aktualizacja-ukladu-kolekcji.json)', () => {
  const raw = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL('../docs/copy/2026-09-30-opisy-kolekcji/aktualizacja-ukladu-kolekcji.json', import.meta.url)), 'utf8'),
  ) as unknown;
  // Parsed as committed: also guards that the package stays approved and importable.
  const parsed = parseApprovedDescriptions(raw, KNOWN_SLUGS);

  it('covers exactly the collections whose text changed after the regrouping', () => {
    expect(Object.keys(parsed.collections).sort()).toEqual(['cirrus', 'horizons', 'portals']);
  });

  it('keeps the curated names and gives each page a lead and a whole-sentence meta description', () => {
    for (const [slug, entry] of Object.entries(parsed.collections)) {
      expect(entry.name).toBe(CURATION.find((c) => c.slug === slug)!.name);
      for (const locale of LOCALES) {
        const text = entry.description[locale];
        expect(text, `${slug}/${locale}`).toContain(entry.name);
        const meta = collectionMetaDescription(text);
        expect(meta.length, `${slug}/${locale}`).toBeLessThanOrEqual(155);
        expect(meta.endsWith('…'), `${slug}/${locale} should not need an ellipsis`).toBe(false);
        expect(splitCollectionDescription(text).lead.length, `${slug}/${locale} lead`).toBeLessThanOrEqual(140);
      }
    }
  });
});

describe('planCollection', () => {
  const approved = approvedEntry('Ostrea');

  it('sets every locale on a freshly seeded collection and leaves the other fields alone', () => {
    const before = state();
    const plan = planCollection('ostrea', approved, before, { force: false });
    expect(plan.status).toBe('apply');
    if (plan.status !== 'apply') return;

    expect(plan.baseRevision).toBe(1);
    expect(plan.localeActions).toEqual({ pl: 'set', en: 'set', es: 'set', de: 'set' });
    for (const locale of LOCALES) expect(valueOf(plan.payload, locale)).toBe(approved.description[locale]);
    /** Everything in a payload except its description fields. */
    const notDescription = (p: CmsPayload) => p.fields.filter((f) => f.key !== 'description');
    expect(notDescription(plan.payload)).toEqual(notDescription(before.latestPayload));
    expect(plan.payload.name).toBe('Ostrea');
    // Pure: the state that was read is not mutated.
    expect(valueOf(before.latestPayload, 'pl')).toBe('Ostrea.');
    expect(valueOf(before.latestPayload, 'en')).toBe('');
  });

  it('keeps a description an editor wrote and still fills the remaining locales', () => {
    const edited = 'Opis napisany ręcznie w CMS, zupełnie inny niż zatwierdzony szkic.';
    const plan = planCollection('ostrea', approved, state({ latestPayload: printPayload('Ostrea', 'ostrea', { pl: edited }) }), { force: false });
    expect(plan.status).toBe('apply');
    if (plan.status !== 'apply') return;
    expect(plan.localeActions).toEqual({ pl: 'kept', en: 'set', es: 'set', de: 'set' });
    expect(valueOf(plan.payload, 'pl')).toBe(edited);
    expect(valueOf(plan.payload, 'en')).toBe(approved.description.en);
  });

  it('reports the text the CMS holds now, per locale, on apply and unchanged plans', () => {
    const edited = 'Opis napisany ręcznie w CMS, zupełnie inny niż zatwierdzony szkic.';
    const apply = planCollection('ostrea', approved, state({ latestPayload: printPayload('Ostrea', 'ostrea', { pl: edited }) }), { force: false });
    expect(apply.status).toBe('apply');
    if (apply.status === 'apply') expect(apply.current).toEqual({ pl: edited, en: '', es: '', de: '' });

    const handWritten = printPayload('Ostrea', 'ostrea', { pl: `  ${edited}  `, en: 'Hand-written.', es: 'Escrito a mano.', de: 'Handgeschrieben.' });
    const unchanged = planCollection('ostrea', approved, state({ latestPayload: handWritten }), { force: false });
    expect(unchanged.status).toBe('unchanged');
    if (unchanged.status === 'unchanged') expect(unchanged.current).toEqual({ pl: edited, en: 'Hand-written.', es: 'Escrito a mano.', de: 'Handgeschrieben.' });
  });

  it('overwrites an edited description only with force', () => {
    const edited = 'Opis napisany ręcznie w CMS, zupełnie inny niż zatwierdzony szkic.';
    const plan = planCollection('ostrea', approved, state({ latestPayload: printPayload('Ostrea', 'ostrea', { pl: edited }) }), { force: true });
    expect(plan.status).toBe('apply');
    if (plan.status !== 'apply') return;
    expect(plan.localeActions.pl).toBe('set');
    expect(valueOf(plan.payload, 'pl')).toBe(approved.description.pl);
  });

  it('still recognises the seeded placeholder after the collection was renamed in the CMS', () => {
    const plan = planCollection('ostrea', approved, state({ latestPayload: printPayload('Ostrea Renamed', 'ostrea', { pl: 'Ostrea.' }) }), { force: false });
    expect(plan.status).toBe('apply');
    if (plan.status !== 'apply') return;
    expect(plan.localeActions.pl).toBe('set');
  });

  it('adds a description field for a locale the payload does not have yet', () => {
    const payload = printPayload('Ostrea', 'ostrea');
    payload.fields = payload.fields.filter((f) => !(f.key === 'description' && f.locale !== 'pl'));
    const plan = planCollection('ostrea', approved, state({ latestPayload: payload }), { force: false });
    expect(plan.status).toBe('apply');
    if (plan.status !== 'apply') return;
    expect(plan.payload.fields.filter((f) => f.key === 'description')).toHaveLength(4);
    expect(plan.payload.fields.find((f) => f.key === 'description' && f.locale === 'de')).toEqual(descriptionField('de', approved.description.de));
  });

  it('is unchanged when the CMS already holds the approved text (whitespace-insensitive)', () => {
    const descriptions = { ...approved.description, pl: `${approved.description.pl}\n` };
    const plan = planCollection('ostrea', approved, state({ latestPayload: printPayload('Ostrea', 'ostrea', descriptions) }), { force: false });
    expect(plan).toMatchObject({ status: 'unchanged', localeActions: { pl: 'unchanged', en: 'unchanged', es: 'unchanged', de: 'unchanged' } });
  });

  it('is unchanged when everything that differs was deliberately kept', () => {
    const descriptions = { ...approved.description, de: 'Von Hand geschriebener Text, der bewusst anders ist als der freigegebene Entwurf.' };
    const plan = planCollection('ostrea', approved, state({ latestPayload: printPayload('Ostrea', 'ostrea', descriptions) }), { force: false });
    expect(plan).toMatchObject({ status: 'unchanged', localeActions: { de: 'kept', pl: 'unchanged' } });
  });

  it('skips a collection that is not in the CMS', () => {
    expect(planCollection('ostrea', approved, undefined, { force: false })).toMatchObject({ status: 'skip', reason: expect.stringMatching(/not found/) });
  });

  it('skips a collection that was never published', () => {
    expect(planCollection('ostrea', approved, state({ publishedRevision: null }), { force: false })).toMatchObject({
      status: 'skip',
      reason: expect.stringMatching(/never published/),
    });
  });

  it("skips a collection with someone else's unpublished draft rather than publishing it", () => {
    const plan = planCollection('ostrea', approved, state({ latestRevision: 2, latestCreatedBy: EDITOR }), { force: false });
    expect(plan).toMatchObject({ status: 'skip', reason: expect.stringMatching(/unpublished CMS draft \(revision 2\)/) });
  });

  it('resumes an interrupted run: publishes the draft this script wrote instead of saving another', () => {
    const written = printPayload('Ostrea', 'ostrea', approved.description);
    const plan = planCollection('ostrea', approved, state({ latestRevision: 2, latestCreatedBy: IMPORT_ACTOR, latestPayload: written }), { force: false });
    expect(plan).toMatchObject({ status: 'resume', revision: 2 });
  });

  it('does not resume a draft from this script whose text is no longer the approved copy', () => {
    const stale = printPayload('Ostrea', 'ostrea', { ...approved.description, pl: 'Starsza wersja tekstu.' });
    const plan = planCollection('ostrea', approved, state({ latestRevision: 2, latestCreatedBy: IMPORT_ACTOR, latestPayload: stale }), { force: false });
    expect(plan).toMatchObject({ status: 'skip', reason: expect.stringMatching(/saved by an earlier import no longer matches the approved copy/) });
  });

  describe('resuming a draft that kept an editor\'s text', () => {
    const human = 'Opis napisany ręcznie w CMS, zupełnie inny niż zatwierdzony szkic.';
    // Live: the editor's PL text, other locales still blank. Draft: that PL text kept, approved copy elsewhere.
    const live = printPayload('Ostrea', 'ostrea', { pl: human });
    const mixed = printPayload('Ostrea', 'ostrea', { pl: human, en: approved.description.en, es: approved.description.es, de: approved.description.de });
    /** The state after an interrupted run: the mixed draft saved by the import, unpublished, over the live editor text. */
    const savedByImport = (over: Partial<CollectionState> = {}) =>
      state({ latestRevision: 2, latestCreatedBy: IMPORT_ACTOR, publishedPayload: live, latestPayload: mixed, ...over });

    it('resumes: every locale is approved copy or the text that is live', () => {
      expect(planCollection('ostrea', approved, savedByImport(), { force: false })).toMatchObject({ status: 'resume', revision: 2 });
    });

    it('does not resume when the kept text is no longer what is live', () => {
      const changedLive = printPayload('Ostrea', 'ostrea', { pl: 'Inny tekst redakcji.' });
      expect(planCollection('ostrea', approved, savedByImport({ publishedPayload: changedLive }), { force: false }).status).toBe('skip');
    });

    it('does not resume a draft that changes anything but descriptions', () => {
      const tampered = structuredClone(mixed);
      tampered.fields.find((f) => f.key === 'products')!.value = 'fap001';
      expect(planCollection('ostrea', approved, savedByImport({ latestPayload: tampered }), { force: false }).status).toBe('skip');
    });

    it('does not count a seeded placeholder left in the draft as kept copy', () => {
      const seededLive = printPayload('Ostrea', 'ostrea');
      const leftPlaceholder = printPayload('Ostrea', 'ostrea', { pl: 'Ostrea.', en: approved.description.en, es: approved.description.es, de: approved.description.de });
      expect(planCollection('ostrea', approved, savedByImport({ publishedPayload: seededLive, latestPayload: leftPlaceholder }), { force: false }).status).toBe('skip');
    });

    it('needs the published payload to vouch for kept text: without it only an all-approved draft resumes', () => {
      expect(planCollection('ostrea', approved, savedByImport({ publishedPayload: undefined }), { force: false }).status).toBe('skip');
    });

    it("never resumes a draft someone else saved, however much it looks like the import's", () => {
      expect(planCollection('ostrea', approved, savedByImport({ latestCreatedBy: EDITOR }), { force: false })).toMatchObject({
        status: 'skip',
        reason: expect.stringMatching(/unpublished CMS draft \(revision 2\)/),
      });
    });
  });
});

// ── In-memory stand-in for the two tables + two RPCs the script uses ─────────

interface FakeDraft {
  revision: number;
  payload: CmsPayload;
  createdBy: string | null;
}
interface FakeCollection {
  id: string;
  publishedRevision: number | null;
  drafts: FakeDraft[];
}
interface FakeOptions {
  saveError?: (collectionId: string) => { message: string } | null;
  publishError?: (collectionId: string) => { message: string } | null;
  readError?: 'collections' | 'collection_drafts';
}

/** A collection as the backfill leaves it: published at revision 1 with one seeded draft. */
function seeded(id: string, name: string, slug: string, descriptions?: Partial<Record<DescriptionLocale, string>>): FakeCollection {
  return { id, publishedRevision: 1, drafts: [{ revision: 1, payload: printPayload(name, slug, descriptions), createdBy: SEED_ACTOR }] };
}

/** In-memory model of the `collections` / `collection_drafts` tables and the two RPCs, so tests assert the resulting CMS state. */
function fakeDb(initial: FakeCollection[], options: FakeOptions = {}) {
  const collections: FakeCollection[] = structuredClone(initial);
  const calls: { fn: string; params: Record<string, unknown> }[] = [];
  const reads: string[] = [];
  /** Highest draft revision of a collection (0 when it has none). */
  const latestRevision = (c: FakeCollection) => Math.max(0, ...c.drafts.map((d) => d.revision));

  const supabase = {
    from: (table: string) => {
      reads.push(table);
      if (table === 'collections') {
        return {
          select: () =>
            Promise.resolve(
              options.readError === 'collections'
                ? { data: null, error: { message: 'collections read failed' } }
                : { data: collections.map((c) => ({ id: c.id, published_revision: c.publishedRevision })), error: null },
            ),
        };
      }
      if (table === 'collection_drafts') {
        return {
          select: () => ({
            in: (_column: string, ids: string[]) => ({
              // Rows come back in insertion (ascending) order regardless of the
              // requested ordering, so the loader must not rely on it.
              order: () =>
                Promise.resolve(
                  options.readError === 'collection_drafts'
                    ? { data: null, error: { message: 'collection_drafts read failed' } }
                    : {
                        data: collections
                          .filter((c) => ids.includes(c.id))
                          .flatMap((c) => c.drafts.map((d) => ({ collection_id: c.id, revision: d.revision, payload: d.payload, created_by: d.createdBy }))),
                        error: null,
                      },
                ),
            }),
          }),
        };
      }
      throw new Error(`fakeDb: unexpected table "${table}"`);
    },
    rpc: (fn: string, params: Record<string, unknown>) => {
      calls.push({ fn, params });
      const collection = collections.find((c) => c.id === params.p_collection_id);
      if (!collection) return Promise.resolve({ error: { message: 'collection_not_found' } });
      if (fn === 'save_collection_draft') {
        const injected = options.saveError?.(collection.id);
        if (injected) return Promise.resolve({ error: injected });
        if (latestRevision(collection) !== params.p_expected_revision) return Promise.resolve({ error: { message: 'revision_conflict' } });
        collection.drafts.push({ revision: latestRevision(collection) + 1, payload: params.p_payload as CmsPayload, createdBy: params.p_actor_email as string });
        return Promise.resolve({ error: null });
      }
      if (fn === 'publish_collection_revision') {
        const injected = options.publishError?.(collection.id);
        if (injected) return Promise.resolve({ error: injected });
        if (latestRevision(collection) !== params.p_expected_revision) return Promise.resolve({ error: { message: 'revision_conflict' } });
        collection.publishedRevision = params.p_expected_revision as number;
        return Promise.resolve({ error: null });
      }
      throw new Error(`fakeDb: unexpected rpc "${fn}"`);
    },
  } as unknown as SupabaseClient;

  /** The stored collection with this id. */
  const byId = (id: string) => collections.find((c) => c.id === id)!;
  /** The payload of a collection's newest draft. */
  const latestPayload = (id: string) => byId(id).drafts.at(-1)!.payload;
  return { supabase, collections, calls, reads, byId, latestPayload };
}

const APPROVED: ApprovedDescriptions = { collections: { ostrea: approvedEntry('Ostrea'), linea: approvedEntry('Linea') } };
const OFF = { confirm: false, force: false } as const;
const ON = { confirm: true, force: false } as const;
/** Log sink for tests that do not assert on the output. */
const quiet = () => {};

describe('runImport', () => {
  it('is a dry run by default: reads, prints the plan, writes nothing', async () => {
    const db = fakeDb([seeded('col_ostrea', 'Ostrea', 'ostrea'), seeded('col_linea', 'Linea', 'linea')]);
    const lines: string[] = [];

    const result = await runImport(db.supabase, APPROVED, OFF, (l) => lines.push(l));

    expect(db.calls).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(result.plans.map((p) => p.status)).toEqual(['apply', 'apply']);
    expect(lines.join('\n')).toMatch(/Dry run — nothing was written/);
    expect(db.collections.every((c) => c.drafts.length === 1 && c.publishedRevision === 1)).toBe(true);
  });

  it('with --confirm saves a new revision then publishes exactly that revision, as the import actor', async () => {
    const db = fakeDb([seeded('col_ostrea', 'Ostrea', 'ostrea'), seeded('col_linea', 'Linea', 'linea')]);

    const result = await runImport(db.supabase, APPROVED, ON, quiet);

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual(['ostrea', 'linea']);
    for (const id of ['col_ostrea', 'col_linea']) {
      const forCollection = db.calls.filter((c) => c.params.p_collection_id === id);
      expect(forCollection.map((c) => c.fn)).toEqual(['save_collection_draft', 'publish_collection_revision']);
      expect(forCollection[0].params).toMatchObject({ p_expected_revision: 1, p_actor_email: IMPORT_ACTOR });
      expect(forCollection[1].params).toMatchObject({ p_expected_revision: 2, p_actor_email: IMPORT_ACTOR });
    }
    for (const [id, slug] of [['col_ostrea', 'ostrea'], ['col_linea', 'linea']] as const) {
      const collection = db.byId(id);
      expect(collection.publishedRevision).toBe(2);
      expect(collection.drafts).toHaveLength(2);
      for (const locale of LOCALES) expect(valueOf(db.latestPayload(id), locale)).toBe(APPROVED.collections[slug].description[locale]);
      // Structure the CMS owns is carried over untouched.
      expect(db.latestPayload(id).fields.filter((f) => f.key !== 'description')).toEqual(
        collection.drafts[0].payload.fields.filter((f) => f.key !== 'description'),
      );
    }
  });

  it('is idempotent: a second run plans nothing and makes no calls', async () => {
    const db = fakeDb([seeded('col_ostrea', 'Ostrea', 'ostrea'), seeded('col_linea', 'Linea', 'linea')]);
    await runImport(db.supabase, APPROVED, ON, quiet);
    const callsAfterFirst = db.calls.length;

    const second = await runImport(db.supabase, APPROVED, ON, quiet);

    expect(second.plans.map((p) => p.status)).toEqual(['unchanged', 'unchanged']);
    expect(second.applied).toEqual([]);
    expect(db.calls).toHaveLength(callsAfterFirst);
  });

  it('--only limits the run to the named collections', async () => {
    const db = fakeDb([seeded('col_ostrea', 'Ostrea', 'ostrea'), seeded('col_linea', 'Linea', 'linea')]);

    const result = await runImport(db.supabase, APPROVED, { ...ON, only: ['linea'] }, quiet);

    expect(result.applied).toEqual(['linea']);
    expect(db.calls.every((c) => c.params.p_collection_id === 'col_linea')).toBe(true);
    expect(db.byId('col_ostrea').drafts).toHaveLength(1);
  });

  it('rejects an unknown --only slug before reading or writing anything', async () => {
    const db = fakeDb([seeded('col_ostrea', 'Ostrea', 'ostrea')]);
    await expect(runImport(db.supabase, APPROVED, { ...ON, only: ['nope'] }, quiet)).rejects.toThrow(/--only "nope" is not in the descriptions file/);
    expect(db.reads).toEqual([]);
    expect(db.calls).toEqual([]);
  });

  it('keeps what an editor wrote but still publishes the locales that were empty', async () => {
    const human = 'Opis napisany ręcznie w CMS, zupełnie inny niż zatwierdzony szkic.';
    const db = fakeDb([seeded('col_ostrea', 'Ostrea', 'ostrea', { pl: human })]);

    await runImport(db.supabase, { collections: { ostrea: APPROVED.collections.ostrea } }, ON, quiet);

    const payload = db.latestPayload('col_ostrea');
    expect(valueOf(payload, 'pl')).toBe(human);
    expect(valueOf(payload, 'en')).toBe(APPROVED.collections.ostrea.description.en);
    expect(db.byId('col_ostrea').publishedRevision).toBe(2);
  });

  it('quotes every kept text and says how to replace it', async () => {
    const tagline = 'Falujące pasma, otwarte pętle i miękkie plamy koloru.';
    const db = fakeDb([
      seeded('col_aurora', 'Aurora', 'aurora', { pl: tagline, en: 'Wavering bands.', es: 'Franjas ondulantes.', de: 'Wellige Bänder.' }),
      seeded('col_ostrea', 'Ostrea', 'ostrea'),
    ]);
    const lines: string[] = [];

    await runImport(db.supabase, { collections: { aurora: approvedEntry('Aurora'), ostrea: APPROVED.collections.ostrea } }, OFF, (l) => lines.push(l));

    const out = lines.join('\n');
    expect(out).toContain(`pl kept (${tagline.length} chars): ${JSON.stringify(tagline)}`);
    expect(out).toContain('en kept (15 chars): "Wavering bands."');
    expect(out).toMatch(/Replace it with --force/);
    // Only Aurora keeps anything; Ostrea (seeded) gets no quotes.
    expect(lines.filter((l) => l.includes('kept ('))).toHaveLength(4);
  });

  it('shortens a long kept text in the preview and reports its full length', async () => {
    const db = fakeDb([seeded('col_ostrea', 'Ostrea', 'ostrea', { pl: 'x'.repeat(250) })]);
    const lines: string[] = [];

    await runImport(db.supabase, { collections: { ostrea: APPROVED.collections.ostrea } }, OFF, (l) => lines.push(l));

    const preview = lines.find((l) => l.includes('pl kept'))!;
    expect(preview).toContain('(250 chars)');
    expect(preview).toContain('…');
    expect(preview.length).toBeLessThan(160);
  });

  it('prints no "kept" lines or hint when nothing is kept', async () => {
    const db = fakeDb([seeded('col_ostrea', 'Ostrea', 'ostrea')]);
    const lines: string[] = [];

    await runImport(db.supabase, { collections: { ostrea: APPROVED.collections.ostrea } }, OFF, (l) => lines.push(l));

    expect(lines.join('\n')).not.toMatch(/kept/);
  });

  it("skips a collection carrying someone else's unpublished draft and carries on with the rest", async () => {
    const withDraft = seeded('col_ostrea', 'Ostrea', 'ostrea');
    withDraft.drafts.push({ revision: 2, payload: printPayload('Ostrea', 'ostrea', { pl: 'Szkic Anny.' }), createdBy: EDITOR });
    const db = fakeDb([withDraft, seeded('col_linea', 'Linea', 'linea')]);

    const result = await runImport(db.supabase, APPROVED, ON, quiet);

    expect(result.plans.map((p) => p.status)).toEqual(['skip', 'apply']);
    expect(result.applied).toEqual(['linea']);
    expect(db.calls.some((c) => c.params.p_collection_id === 'col_ostrea')).toBe(false);
    expect(db.byId('col_ostrea').publishedRevision).toBe(1);
  });

  it('skips a slug that is missing from the CMS, or carried by two collections', async () => {
    const db = fakeDb([seeded('col_a', 'Linea', 'linea'), seeded('col_b', 'Linea', 'linea')]);

    const result = await runImport(db.supabase, APPROVED, ON, quiet);

    expect(result.plans).toEqual([
      expect.objectContaining({ slug: 'ostrea', status: 'skip', reason: expect.stringMatching(/not found/) }),
      expect.objectContaining({ slug: 'linea', status: 'skip', reason: expect.stringMatching(/more than one/) }),
    ]);
    expect(db.calls).toEqual([]);
  });

  it('ignores CMS collections that are not print collections', async () => {
    const generic = seeded('col_generic', 'Ostrea', 'ostrea');
    generic.drafts[0].payload.fields = generic.drafts[0].payload.fields.filter((f) => f.key !== 'kind');
    const db = fakeDb([generic, seeded('col_ostrea', 'Ostrea', 'ostrea')]);

    const result = await runImport(db.supabase, { collections: { ostrea: APPROVED.collections.ostrea } }, ON, quiet);

    expect(result.applied).toEqual(['ostrea']);
    expect(db.calls.every((c) => c.params.p_collection_id === 'col_ostrea')).toBe(true);
    expect(db.byId('col_generic').drafts).toHaveLength(1);
  });

  it('isolates a failure: the failing collection is reported and left unpublished, the others go through', async () => {
    const db = fakeDb([seeded('col_ostrea', 'Ostrea', 'ostrea'), seeded('col_linea', 'Linea', 'linea')], {
      saveError: (id) => (id === 'col_ostrea' ? { message: 'boom' } : null),
    });
    const lines: string[] = [];

    const result = await runImport(db.supabase, APPROVED, ON, (l) => lines.push(l));

    expect(result.errors).toEqual([{ slug: 'ostrea', message: 'boom' }]);
    expect(result.applied).toEqual(['linea']);
    expect(db.calls.filter((c) => c.params.p_collection_id === 'col_ostrea').map((c) => c.fn)).toEqual(['save_collection_draft']);
    expect(db.byId('col_ostrea').publishedRevision).toBe(1);
    expect(lines.join('\n')).toMatch(/ERROR: ostrea: boom/);
  });

  it('reports a revision conflict from a concurrent CMS edit instead of overwriting it', async () => {
    const db = fakeDb([seeded('col_ostrea', 'Ostrea', 'ostrea')]);
    // The editor saves a newer draft between the plan and the write.
    const realRpc = db.supabase.rpc.bind(db.supabase);
    let raced = false;
    (db.supabase as unknown as { rpc: unknown }).rpc = (fn: string, params: Record<string, unknown>) => {
      if (!raced && fn === 'save_collection_draft') {
        raced = true;
        db.byId('col_ostrea').drafts.push({ revision: 2, payload: printPayload('Ostrea', 'ostrea', { pl: 'Edycja w trakcie.' }), createdBy: EDITOR });
      }
      return realRpc(fn, params);
    };

    const result = await runImport(db.supabase, { collections: { ostrea: APPROVED.collections.ostrea } }, ON, quiet);

    expect(result.errors).toEqual([{ slug: 'ostrea', message: 'revision_conflict' }]);
    expect(db.byId('col_ostrea').publishedRevision).toBe(1);
    expect(valueOf(db.latestPayload('col_ostrea'), 'pl')).toBe('Edycja w trakcie.');
  });

  it('recovers from a failed publish: the next run publishes the saved draft without saving again', async () => {
    let failPublish = true;
    const db = fakeDb([seeded('col_ostrea', 'Ostrea', 'ostrea')], {
      publishError: () => (failPublish ? { message: 'publish failed' } : null),
    });
    const only = { collections: { ostrea: APPROVED.collections.ostrea } };

    const first = await runImport(db.supabase, only, ON, quiet);
    expect(first.errors).toEqual([{ slug: 'ostrea', message: 'publish failed' }]);
    expect(db.byId('col_ostrea').drafts).toHaveLength(2);
    expect(db.byId('col_ostrea').publishedRevision).toBe(1);

    failPublish = false;
    const second = await runImport(db.supabase, only, ON, quiet);

    expect(second.plans[0].status).toBe('resume');
    expect(second.applied).toEqual(['ostrea']);
    expect(db.byId('col_ostrea').drafts).toHaveLength(2);
    expect(db.byId('col_ostrea').publishedRevision).toBe(2);
    expect(db.calls.filter((c) => c.fn === 'save_collection_draft')).toHaveLength(1);
  });

  it("recovers from a failed publish even when the saved draft kept an editor's text", async () => {
    const human = 'Opis napisany ręcznie w CMS, zupełnie inny niż zatwierdzony szkic.';
    let failPublish = true;
    const db = fakeDb([seeded('col_ostrea', 'Ostrea', 'ostrea', { pl: human })], {
      publishError: () => (failPublish ? { message: 'publish failed' } : null),
    });
    const only = { collections: { ostrea: APPROVED.collections.ostrea } };

    const first = await runImport(db.supabase, only, ON, quiet);
    expect(first.plans[0]).toMatchObject({ status: 'apply', localeActions: { pl: 'kept', en: 'set', es: 'set', de: 'set' } });
    expect(first.errors).toEqual([{ slug: 'ostrea', message: 'publish failed' }]);
    expect(db.byId('col_ostrea').publishedRevision).toBe(1);

    failPublish = false;
    const second = await runImport(db.supabase, only, ON, quiet);

    expect(second.plans[0].status).toBe('resume');
    expect(second.errors).toEqual([]);
    expect(second.applied).toEqual(['ostrea']);
    const payload = db.latestPayload('col_ostrea');
    expect(valueOf(payload, 'pl')).toBe(human);
    expect(valueOf(payload, 'en')).toBe(APPROVED.collections.ostrea.description.en);
    expect(db.byId('col_ostrea').publishedRevision).toBe(2);
    expect(db.byId('col_ostrea').drafts).toHaveLength(2);
    expect(db.calls.filter((c) => c.fn === 'save_collection_draft')).toHaveLength(1);
  });

  it('surfaces a read failure instead of planning against partial data', async () => {
    const db = fakeDb([seeded('col_ostrea', 'Ostrea', 'ostrea')], { readError: 'collection_drafts' });
    await expect(runImport(db.supabase, APPROVED, ON, quiet)).rejects.toMatchObject({ message: 'collection_drafts read failed' });
    expect(db.calls).toEqual([]);
  });
});

describe('loadCollectionStates', () => {
  it('returns the latest draft per print collection whatever order the rows arrive in', async () => {
    const collection = seeded('col_ostrea', 'Ostrea', 'ostrea');
    collection.drafts.push(
      { revision: 3, payload: printPayload('Ostrea', 'ostrea', { pl: 'trzecia' }), createdBy: EDITOR },
      { revision: 2, payload: printPayload('Ostrea', 'ostrea', { pl: 'druga' }), createdBy: EDITOR },
    );
    const db = fakeDb([collection]);

    const states = await loadCollectionStates(db.supabase);

    expect(states.get('ostrea')).toMatchObject({ id: 'col_ostrea', publishedRevision: 1, latestRevision: 3, latestCreatedBy: EDITOR });
    expect(valueOf((states.get('ostrea') as CollectionState).latestPayload, 'pl')).toBe('trzecia');
  });

  it('keeps the payload of the published revision next to the latest draft', async () => {
    const collection = seeded('col_ostrea', 'Ostrea', 'ostrea', { pl: 'Opublikowany opis.' });
    collection.drafts.push({ revision: 2, payload: printPayload('Ostrea', 'ostrea', { pl: 'Nowszy szkic.' }), createdBy: EDITOR });

    const state = (await loadCollectionStates(fakeDb([collection]).supabase)).get('ostrea') as CollectionState;

    expect(state).toMatchObject({ publishedRevision: 1, latestRevision: 2 });
    expect(valueOf(state.publishedPayload!, 'pl')).toBe('Opublikowany opis.');
    expect(valueOf(state.latestPayload, 'pl')).toBe('Nowszy szkic.');
  });

  it('returns an empty map when the CMS has no collections', async () => {
    expect((await loadCollectionStates(fakeDb([]).supabase)).size).toBe(0);
  });
});

describe('parseArgs', () => {
  it('defaults to a dry run over the committed copy package', () => {
    const args = parseArgs([]);
    expect(args).toMatchObject({ confirm: false, force: false });
    expect(args.only).toBeUndefined();
    expect(args.file).toMatch(/opisy-kolekcji\.json$/);
  });

  it('reads every flag, splitting --only on commas and ignoring the value of --env-file', () => {
    expect(parseArgs(['--confirm', '--force', '--only', 'ostrea, linea', '--file', 'x.json', '--env-file', '.env.prod'])).toEqual({
      confirm: true,
      force: true,
      only: ['ostrea', 'linea'],
      file: 'x.json',
    });
  });

  it('rejects unknown arguments and an empty --only', () => {
    expect(() => parseArgs(['--yes'])).toThrow(/Unknown argument: --yes/);
    expect(() => parseArgs(['--only'])).toThrow(/--only needs at least one slug/);
  });
});
