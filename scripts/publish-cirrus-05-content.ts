/** Publish Cirrus 05 localized notes and media metadata. Dry-run unless --apply. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import copy from '../config/print-assets/batches/2026-09-cirrus-05/cirrus-05-opisy.json';
import { saveDraft, publishVersion } from '../src/lib/admin/content';
import { validateProductNotesPayload } from '../src/lib/cms/schemas';
import { loadLocalEnv } from './lib/script-env';

const locales = ['pl', 'en', 'es', 'de'] as const;
const actorEmail = 'cirrus-05-release@ceramics-drop.internal';
const reportPath = 'config/print-assets/batches/2026-09-cirrus-05/cirrus-05-tresci.json';
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
    db.from('products').select('id,status').eq('id', copy.productId).single(),
    db.from('cms_documents').select('id,status').eq('kind', 'product_notes').eq('slug', 'fine-art-prints').single(),
    db.from('product_media').select('*').eq('product_id', copy.productId),
  ]);
  if (productError || documentError || mediaError) throw productError ?? documentError ?? mediaError;
  if (product.status !== 'draft') throw new Error(`Expected ${copy.productId} draft, got ${product.status}`);
  if (!fs.existsSync('public/uploads/fap-058.webp')) throw new Error('Missing hero');

  const { data: versions, error: versionsError } = await db.from('cms_document_versions').select('*').eq('document_id', document.id);
  if (versionsError) throw versionsError;
  const plans = locales.map(locale => {
    const published = versions.find(row => row.locale === locale && row.status === 'published');
    if (!published) throw new Error(`Missing published ${locale} notes`);
    if (versions.some(row => row.locale === locale && row.version > published.version)) throw new Error(`Newer unpublished ${locale} notes exist`);
    const existing = published.payload.notes[copy.productId];
    if (existing && existing !== copy[locale]) throw new Error(`Content conflict ${locale}/${copy.productId}`);
    const payload = validateProductNotesPayload('fine-art-prints', { notes: { ...published.payload.notes, [copy.productId]: copy[locale] } });
    return { locale, previousVersion: published.version, payload, unchanged: sha(payload) === sha(published.payload) };
  });

  const expectedMedia = { url: '/uploads/fap-058.webp', alt: copy.name, position: 0, is_primary: true };
  if (media.length !== 1 || media[0].url !== expectedMedia.url || !media[0].is_primary) throw new Error('Unexpected product media');
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', product, media: expectedMedia,
    notes: plans.map(plan => ({ locale: plan.locale, previousVersion: plan.previousVersion, unchanged: plan.unchanged })) }, null, 2));
  if (!apply) return;

  const report = { status: 'in_progress', completedAt: null as string | null, productId: copy.productId,
    media: expectedMedia, notes: [] as Array<{ locale: string; version: number; payloadSha256: string }> };
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  save();
  if (media[0].alt !== expectedMedia.alt || media[0].position !== 0) {
    const { error } = await db.from('product_media').update({ alt: expectedMedia.alt, position: 0 }).eq('id', media[0].id);
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
  const { data: after, error: afterError } = await db.from('products').select('status').eq('id', copy.productId).single();
  if (afterError || after.status !== 'draft') throw afterError ?? new Error('Product status changed');
  report.status = 'published_content_product_still_draft';
  report.completedAt = new Date().toISOString();
  save();
  console.log('Cirrus 05 media metadata and four localized notes published; product remains draft.');
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
