#!/usr/bin/env node
/**
 * Imports the approved print-collection descriptions
 * (docs/copy/2026-09-30-opisy-kolekcji/opisy-kolekcji.json — PL master plus
 * EN/ES/DE) into the CMS `collections` tables, through the same RPCs the CMS
 * itself uses: save_collection_draft (new revision) then
 * publish_collection_revision. Every write is audit-logged under
 * IMPORT_ACTOR.
 *
 * DRY-RUN BY DEFAULT: without --confirm it only reads the CMS and prints the
 * plan. It refuses to run unless the JSON's `status` is "approved".
 *
 * It never clobbers editorial work. Per locale, a description is overwritten
 * only when the CMS value is empty or the seeded "<name>." placeholder
 * (scripts/backfill-fine-art-collections.ts); anything else the editor wrote
 * is kept (the plan quotes it) unless --force. A collection that has an unpublished draft written
 * by someone else is skipped (publishing on top of it would publish their
 * changes too); a draft this script wrote itself but never published (an
 * interrupted run) is simply published on the next run — including one that
 * kept an editor's text for some locale — as long as publishing it can only put
 * approved copy live (see isResumableImportDraft).
 *
 * Usage:
 *   npm run collections:import-descriptions                       # dry-run: prints the plan
 *   npm run collections:import-descriptions -- --only ostrea --confirm   # canary: one collection
 *   npm run collections:import-descriptions -- --confirm          # every collection
 *
 *   --only <slug[,slug…]>  limit to these collections
 *   --force                also overwrite descriptions edited in the CMS
 *   --file <path>          alternative descriptions JSON
 *   --env-file <path>      env file (same precedence as the other operator scripts)
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local / .dev.vars /
 * --env-file / env). The target host is printed before anything is written;
 * confirm it is the project you mean — publishing is permanent (revisions are
 * append-only, there is no delete).
 *
 * `parseApprovedDescriptions` / `planCollection` / `runImport` are exported for
 * scripts/import-collection-descriptions.test.ts; main() only runs when the
 * file is invoked directly (same guard as backfill-fine-art-collections.ts).
 */
import fs from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import curationSource from '../config/print-catalog-curation.json';
import { loadLocalEnv, loadSupabaseClient } from './lib/script-env';

export const LOCALES = ['pl', 'en', 'es', 'de'] as const;
export type DescriptionLocale = (typeof LOCALES)[number];

/** Audit-log identity; the resume rule below relies on it being stable. */
export const IMPORT_ACTOR = 'import-descriptions@ceramics-drop.internal';

/** Same floor as MIN_COLLECTION_DESCRIPTION_LENGTH in src/lib/print-collections.ts (the test guards drift). */
export const MIN_DESCRIPTION_LENGTH = 80;

const DEFAULT_FILE = 'docs/copy/2026-09-30-opisy-kolekcji/opisy-kolekcji.json';
const PRINT_COLLECTION_KIND = 'print-collection';
const RETIRED_COLLECTION_SLUGS = new Set(
  ((curationSource as { retiredCollections?: Array<{ slug: string }> }).retiredCollections ?? []).map(({ slug }) => slug),
);

/** One collection's approved copy: its curated name and one description per locale. */
export interface ApprovedCollection {
  name: string;
  description: Record<DescriptionLocale, string>;
}

export interface ApprovedDescriptions {
  collections: Record<string, ApprovedCollection>;
}

export interface CmsField {
  key: string;
  value: string;
  label?: string;
  type?: string;
  locale?: string;
  sourceLocale?: string;
  [extra: string]: unknown;
}

export interface CmsPayload {
  name: string;
  fields: CmsField[];
  [extra: string]: unknown;
}

/** What the CMS currently holds for one collection. */
export interface CollectionState {
  id: string;
  publishedRevision: number | null;
  /** The payload of `publishedRevision` — what is live; undefined when that row was not returned. */
  publishedPayload?: CmsPayload;
  latestRevision: number;
  latestPayload: CmsPayload;
  latestCreatedBy: string | null;
}

export type LocaleAction = 'set' | 'unchanged' | 'kept';

/** The description text the CMS currently holds per locale, trimmed ('' when there is none). */
export type LocaleTexts = Record<DescriptionLocale, string>;

export type CollectionPlan =
  | { slug: string; status: 'apply'; collectionId: string; baseRevision: number; localeActions: Record<DescriptionLocale, LocaleAction>; current: LocaleTexts; payload: CmsPayload }
  | { slug: string; status: 'resume'; collectionId: string; revision: number }
  | { slug: string; status: 'unchanged'; collectionId: string; localeActions: Record<DescriptionLocale, LocaleAction>; current: LocaleTexts }
  | { slug: string; status: 'skip'; reason: string; collectionId?: string };

export interface ImportOptions {
  confirm: boolean;
  force: boolean;
  only?: string[];
}

export interface ImportResult {
  plans: CollectionPlan[];
  applied: string[];
  errors: { slug: string; message: string }[];
}

/** Validates the approved-descriptions file; throws a message naming the first problem. */
export function parseApprovedDescriptions(raw: unknown, knownSlugs: readonly string[]): ApprovedDescriptions {
  /** Aborts validation with a message that names what is wrong with the file. */
  const fail = (message: string): never => {
    throw new Error(`Invalid descriptions file: ${message}`);
  };
  if (!raw || typeof raw !== 'object') return fail('must be an object');
  const file = raw as { schemaVersion?: unknown; status?: unknown; collections?: unknown };
  if (file.schemaVersion !== 1) fail(`unsupported schemaVersion ${String(file.schemaVersion)}`);
  if (file.status !== 'approved') fail(`status must be "approved" (got "${String(file.status)}") — the copy has not been signed off`);
  if (!file.collections || typeof file.collections !== 'object' || Array.isArray(file.collections)) return fail('collections must be an object keyed by slug');

  const known = new Set(knownSlugs);
  const collections: ApprovedDescriptions['collections'] = {};
  for (const [slug, entry] of Object.entries(file.collections as Record<string, unknown>)) {
    // The approved copy package predates later owner-directed regrouping.
    // Keep that package immutable for provenance, but omit collections the
    // curation map explicitly retired. Any other unknown slug remains an error.
    if (!known.has(slug) && RETIRED_COLLECTION_SLUGS.has(slug)) continue;
    if (!known.has(slug)) fail(`unknown collection slug "${slug}"`);
    const e = entry as { name?: unknown; description?: Record<string, unknown> } | null;
    if (!e || typeof e.name !== 'string' || !e.name.trim()) return fail(`${slug}: missing name`);
    if (!e.description || typeof e.description !== 'object') return fail(`${slug}: missing description`);
    for (const key of Object.keys(e.description)) {
      if (!(LOCALES as readonly string[]).includes(key)) fail(`${slug}: unknown locale "${key}"`);
    }
    const description = {} as Record<DescriptionLocale, string>;
    for (const locale of LOCALES) {
      const text = e.description[locale];
      if (typeof text !== 'string') return fail(`${slug}: missing ${locale} description`);
      const trimmed = text.trim();
      if (trimmed.length < MIN_DESCRIPTION_LENGTH) fail(`${slug}/${locale}: ${trimmed.length} chars, need at least ${MIN_DESCRIPTION_LENGTH} (below that the page stays noindex)`);
      description[locale] = trimmed;
    }
    collections[slug] = { name: e.name, description };
  }
  if (Object.keys(collections).length === 0) fail('no collections');
  return { collections };
}

/** A CMS description we may replace without asking: blank, or the seeded "<name>." placeholder (under either name, in case the collection was renamed since). */
function isSeedValue(value: string, names: readonly string[]): boolean {
  const v = value.trim();
  return v === '' || names.some((name) => v === `${name}.`);
}

/** The `description` field a payload carries for a locale, if any. */
function descriptionField(payload: CmsPayload, locale: DescriptionLocale): CmsField | undefined {
  return payload.fields.find((f) => f.key === 'description' && f.locale === locale);
}

/** The trimmed description text a payload carries for a locale ('' when absent). */
function descriptionValue(payload: CmsPayload, locale: DescriptionLocale): string {
  return (descriptionField(payload, locale)?.value ?? '').trim();
}

/** A payload minus its description fields — everything this script must leave untouched. */
function withoutDescriptions(payload: CmsPayload): CmsPayload {
  return { ...payload, fields: payload.fields.filter((f) => f.key !== 'description') };
}

/**
 * Whether the unpublished latest draft is one an earlier run of this script saved
 * and that can be published as is. That holds only when publishing it can put
 * nothing but approved copy live: every locale is the approved text, or the editor
 * text that was live (and kept) when the draft was saved, and nothing else differs
 * from the published payload. Without the published payload only a draft made
 * entirely of approved copy qualifies.
 */
function isResumableImportDraft(state: CollectionState, approved: ApprovedCollection): boolean {
  if (state.latestCreatedBy !== IMPORT_ACTOR) return false;
  const draft = state.latestPayload;
  const live = state.publishedPayload;
  const names = [live?.name ?? draft.name, approved.name];
  const onlyApprovedOrLiveCopy = LOCALES.every((locale) => {
    const value = descriptionValue(draft, locale);
    if (value === approved.description[locale]) return true;
    const kept = live ? descriptionValue(live, locale) : '';
    return kept !== '' && value === kept && !isSeedValue(kept, names);
  });
  return onlyApprovedOrLiveCopy && (!live || isDeepStrictEqual(withoutDescriptions(draft), withoutDescriptions(live)));
}

/** Decide what to do for one collection. Pure — no I/O. */
export function planCollection(
  slug: string,
  approved: ApprovedCollection,
  state: CollectionState | undefined,
  options: { force: boolean },
): CollectionPlan {
  if (!state) return { slug, status: 'skip', reason: 'not found in the CMS (no print-collection with this slug)' };
  const { id } = state;
  if (state.publishedRevision == null) return { slug, status: 'skip', collectionId: id, reason: 'collection was never published' };

  if (state.latestRevision !== state.publishedRevision) {
    if (isResumableImportDraft(state, approved)) return { slug, status: 'resume', collectionId: id, revision: state.latestRevision };
    return {
      slug,
      status: 'skip',
      collectionId: id,
      reason:
        state.latestCreatedBy === IMPORT_ACTOR
          ? `an unpublished draft (revision ${state.latestRevision}) saved by an earlier import no longer matches the approved copy — publish or discard it in the CMS first`
          : `an unpublished CMS draft (revision ${state.latestRevision}) exists — publish or discard it first, otherwise this import would publish it too`,
    };
  }

  const payload: CmsPayload = { ...state.latestPayload, fields: state.latestPayload.fields.map((f) => ({ ...f })) };
  const localeActions = {} as Record<DescriptionLocale, LocaleAction>;
  const current = {} as LocaleTexts;
  for (const locale of LOCALES) {
    const next = approved.description[locale];
    const field = descriptionField(payload, locale);
    const existing = field?.value ?? '';
    current[locale] = existing.trim();
    if (current[locale] === next) {
      localeActions[locale] = 'unchanged';
    } else if (options.force || isSeedValue(existing, [state.latestPayload.name, approved.name])) {
      localeActions[locale] = 'set';
      if (field) field.value = next;
      else payload.fields.push({ key: 'description', label: 'Opis kolekcji', type: 'text', value: next, locale, sourceLocale: 'pl' });
    } else {
      localeActions[locale] = 'kept';
    }
  }

  if (!LOCALES.some((l) => localeActions[l] === 'set')) return { slug, status: 'unchanged', collectionId: id, localeActions, current };
  return { slug, status: 'apply', collectionId: id, baseRevision: state.latestRevision, localeActions, current, payload };
}

/** Reads every print collection's latest draft + publication state, keyed by slug. */
export async function loadCollectionStates(supabase: SupabaseClient): Promise<Map<string, CollectionState | 'duplicate'>> {
  const { data: collections, error: collectionsError } = await supabase.from('collections').select('id, published_revision');
  if (collectionsError) throw collectionsError;
  const ids = (collections ?? []).map((c) => c.id as string);
  const publishedById = new Map((collections ?? []).map((c) => [c.id as string, c.published_revision as number | null]));
  if (ids.length === 0) return new Map();

  const { data: drafts, error: draftsError } = await supabase
    .from('collection_drafts')
    .select('collection_id, revision, payload, created_by')
    .in('collection_id', ids)
    // Newest first: if PostgREST's row cap ever truncated the result it would
    // drop the oldest revisions, never the latest ones this loader needs.
    .order('revision', { ascending: false });
  if (draftsError) throw draftsError;

  const latest = new Map<string, { revision: number; payload: CmsPayload; createdBy: string | null }>();
  const publishedPayloads = new Map<string, CmsPayload>();
  for (const row of drafts ?? []) {
    const id = row.collection_id as string;
    const revision = row.revision as number;
    const payload = row.payload as CmsPayload;
    if (revision === publishedById.get(id)) publishedPayloads.set(id, payload);
    if (!latest.has(id) || revision > latest.get(id)!.revision) {
      latest.set(id, { revision, payload, createdBy: (row.created_by as string | null) ?? null });
    }
  }

  const bySlug = new Map<string, CollectionState | 'duplicate'>();
  for (const [id, draft] of latest) {
    const fields = draft.payload?.fields ?? [];
    if (fields.find((f) => f.key === 'kind')?.value !== PRINT_COLLECTION_KIND) continue;
    const slug = fields.find((f) => f.key === 'slug')?.value;
    if (!slug) continue;
    bySlug.set(slug, bySlug.has(slug) ? 'duplicate' : {
      id,
      publishedRevision: publishedById.get(id) ?? null,
      publishedPayload: publishedPayloads.get(id),
      latestRevision: draft.revision,
      latestPayload: draft.payload,
      latestCreatedBy: draft.createdBy,
    });
  }
  return bySlug;
}

/** One dry-run/plan line for a collection: what would be written, resumed, left alone or skipped. */
function describePlan(plan: CollectionPlan): string {
  switch (plan.status) {
    case 'apply': return `WRITE   rev ${plan.baseRevision} → ${plan.baseRevision + 1}  ${LOCALES.map((l) => `${l}:${plan.localeActions[l]}`).join(' ')}`;
    case 'resume': return `RESUME  publish the unpublished revision ${plan.revision} written by an earlier run`;
    case 'unchanged': return `ok      nothing to change  ${LOCALES.map((l) => `${l}:${plan.localeActions[l]}`).join(' ')}`;
    case 'skip': return `SKIP    ${plan.reason}`;
  }
}

/** How much of a kept text the plan output quotes. */
const KEPT_PREVIEW_CHARS = 100;

/**
 * One line per locale whose existing text the plan keeps, quoting that text, so
 * the operator can judge whether to replace it with --force.
 */
function keptPreview(plan: CollectionPlan): string[] {
  if (plan.status !== 'apply' && plan.status !== 'unchanged') return [];
  return LOCALES.filter((l) => plan.localeActions[l] === 'kept').map((l) => {
    const text = plan.current[l];
    const shown = text.length > KEPT_PREVIEW_CHARS ? `${text.slice(0, KEPT_PREVIEW_CHARS - 1)}…` : text;
    return `${' '.repeat(15)}${l} kept (${text.length} chars): ${JSON.stringify(shown)}`;
  });
}

/** Plans (always) and applies (only with `confirm`) the import. Never throws for a single collection's failure. */
export async function runImport(
  supabase: SupabaseClient,
  approved: ApprovedDescriptions,
  options: ImportOptions,
  log: (line: string) => void = console.log,
): Promise<ImportResult> {
  for (const wanted of options.only ?? []) {
    if (!(wanted in approved.collections)) throw new Error(`--only "${wanted}" is not in the descriptions file`);
  }
  const slugs = Object.keys(approved.collections).filter((s) => !options.only || options.only.includes(s));

  const states = await loadCollectionStates(supabase);
  const plans: CollectionPlan[] = slugs.map((slug): CollectionPlan => {
    const state = states.get(slug);
    if (state === 'duplicate') return { slug, status: 'skip', reason: 'more than one CMS collection carries this slug' };
    return planCollection(slug, approved.collections[slug], state, { force: options.force });
  });
  for (const plan of plans) {
    log(`${plan.slug.padEnd(14)} ${describePlan(plan)}`);
    for (const line of keptPreview(plan)) log(line);
  }
  if (plans.some((p) => keptPreview(p).length > 0)) {
    log('\n"kept" = existing text that is neither blank nor the seeded "<name>." placeholder. Replace it with --force (limit with --only).');
  }

  const result: ImportResult = { plans, applied: [], errors: [] };
  if (!options.confirm) {
    log('\nDry run — nothing was written. Add --confirm to apply.');
    return result;
  }

  for (const plan of plans) {
    if (plan.status !== 'apply' && plan.status !== 'resume') continue;
    try {
      let publishRevision: number;
      if (plan.status === 'apply') {
        const { error } = await supabase.rpc('save_collection_draft', {
          p_collection_id: plan.collectionId,
          p_expected_revision: plan.baseRevision,
          p_payload: plan.payload,
          p_actor_email: IMPORT_ACTOR,
        });
        if (error) throw error;
        publishRevision = plan.baseRevision + 1;
      } else {
        publishRevision = plan.revision;
      }
      const { error: publishError } = await supabase.rpc('publish_collection_revision', {
        p_collection_id: plan.collectionId,
        p_expected_revision: publishRevision,
        p_actor_email: IMPORT_ACTOR,
      });
      if (publishError) throw publishError;
      result.applied.push(plan.slug);
      log(`published: ${plan.slug} (revision ${publishRevision})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
      result.errors.push({ slug: plan.slug, message });
      log(`ERROR: ${plan.slug}: ${message}`);
    }
  }

  log(`\n${result.applied.length} published, ${result.errors.length} failed, ${plans.filter((p) => p.status === 'skip').length} skipped.`);
  return result;
}

export interface CliArgs extends ImportOptions {
  file: string;
}

/** Parse the CLI flags; throws on an unknown flag, an empty `--only` or a missing `--file` value. */
export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { confirm: false, force: false, file: DEFAULT_FILE };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--confirm') out.confirm = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--only') out.only = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--file') out.file = argv[++i] ?? '';
    else if (arg === '--env-file') i++; // consumed by loadLocalEnv()
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (out.only && out.only.length === 0) throw new Error('--only needs at least one slug');
  if (!out.file) throw new Error('--file needs a path');
  return out;
}

/** CLI entry: validate the approved copy, print the target project, then plan (and with `--confirm` apply) the import. */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const known = (curationSource as { collections: { slug: string }[] }).collections.map((c) => c.slug);
  const approved = parseApprovedDescriptions(JSON.parse(fs.readFileSync(resolve(args.file), 'utf8')), known);

  const supabase = loadSupabaseClient();
  const env = loadLocalEnv();
  console.log(`Target: ${new URL(env.SUPABASE_URL!).host}`);
  console.log(`Mode:   ${args.confirm ? 'WRITE (--confirm)' : 'dry-run'}${args.force ? ', --force' : ''}${args.only ? `, only ${args.only.join(',')}` : ''}\n`);

  const result = await runImport(supabase, approved, args);
  if (result.errors.length > 0) process.exitCode = 1;
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  main().catch((error: unknown) => {
    // Supabase errors are plain { message } objects, not Error instances.
    console.error(error instanceof Error ? error.message : ((error as { message?: unknown } | null)?.message ?? error));
    process.exit(1);
  });
}
