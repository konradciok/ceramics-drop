/** Rename active product fap058 from Cirrus 05 to Cumulus 02 in CMS copy and media metadata. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import previous from '../config/print-assets/batches/2026-09-cirrus-05/cirrus-05-opisy.json';
import next from '../config/print-assets/batches/2026-09-collections-layout/cumulus-02-opisy.json';
import { saveDraft, publishVersion } from '../src/lib/admin/content';
import { validateProductNotesPayload } from '../src/lib/cms/schemas';
import { loadLocalEnv } from './lib/script-env';

const locales = ['pl', 'en', 'es', 'de'] as const;
const actorEmail = 'collections-layout-2026-09@ceramics-drop.internal';
const reportPath = 'config/print-assets/batches/2026-09-collections-layout/cumulus-02-publikacja.json';
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const sha = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

async function main() {
  const apply = process.argv.includes('--apply');
  const env = loadLocalEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing credentials');
  if (new URL(env.SUPABASE_URL).hostname !== 'wnlysejenowymjdxlnaq.supabase.co') throw new Error('Wrong project');
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const [{ data: product, error: productError }, { data: document, error: documentError }, { data: media, error: mediaError }] = await Promise.all([
    db.from('products').select('id,status').eq('id', next.productId).single(),
    db.from('cms_documents').select('id,status').eq('kind', 'product_notes').eq('slug', 'fine-art-prints').single(),
    db.from('product_media').select('*').eq('product_id', next.productId),
  ]);
  if (productError || documentError || mediaError) throw productError ?? documentError ?? mediaError;
  if (product.status !== 'active') throw new Error(`Expected ${next.productId} active, got ${product.status}`);
  if (media.length !== 1 || media[0].url !== '/uploads/fap-058.webp' || !media[0].is_primary) throw new Error('Unexpected product media');
  if (![previous.name, next.name].includes(media[0].alt)) throw new Error(`Media alt conflict: ${media[0].alt}`);

  const { data: versions, error: versionsError } = await db.from('cms_document_versions').select('*').eq('document_id', document.id);
  if (versionsError) throw versionsError;
  const plans = locales.map(locale => {
    const published = versions.find(row => row.locale === locale && row.status === 'published');
    if (!published) throw new Error(`Missing published ${locale} notes`);
    if (versions.some(row => row.locale === locale && row.version > published.version)) throw new Error(`Newer unpublished ${locale} notes exist`);
    const existing = published.payload.notes[next.productId];
    if (![previous[locale], next[locale]].includes(existing)) throw new Error(`Content conflict ${locale}/${next.productId}`);
    const payload = validateProductNotesPayload('fine-art-prints', { notes: { ...published.payload.notes, [next.productId]: next[locale] } });
    return { locale, previousVersion: published.version, payload, unchanged: sha(payload) === sha(published.payload) };
  });

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', product, rename: `${previous.name} -> ${next.name}`,
    mediaAltUnchanged: media[0].alt === next.name,
    notes: plans.map(plan => ({ locale: plan.locale, previousVersion: plan.previousVersion, unchanged: plan.unchanged })) }, null, 2));
  if (!apply) return;

  const report = { status: 'in_progress', completedAt: null as string | null, productId: next.productId,
    previousName: previous.name, name: next.name, mediaAlt: next.name,
    notes: [] as Array<{ locale: string; version: number; payloadSha256: string }> };
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  save();
  if (media[0].alt !== next.name) {
    const { error } = await db.from('product_media').update({ alt: next.name }).eq('id', media[0].id);
    if (error) throw error;
  }
  for (const plan of plans) {
    let version = plan.previousVersion;
    if (!plan.unchanged) {
      const saved = await saveDraft({ kind: 'product_notes', slug: 'fine-art-prints', locale: plan.locale,
        payload: plan.payload, actorEmail, client: db });
      version = saved.version;
      await publishVersion({ kind: 'product_notes', slug: 'fine-art-prints', locale: plan.locale,
        version, actorEmail, client: db });
    }
    report.notes.push({ locale: plan.locale, version, payloadSha256: sha(plan.payload) });
    save();
  }
  report.status = 'published';
  report.completedAt = new Date().toISOString();
  save();
  console.log('fap058 renamed to Cumulus 02 in media and four localized notes.');
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
