/** Guarded Cirrus 05 activation. Read-only unless --apply. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import copy from '../config/print-assets/batches/2026-09-cirrus-05/cirrus-05-opisy.json';
import { signPrintAssetUrl } from '../src/lib/print-assets';
import { probeSignedPrintAssetHead } from '../src/lib/print-asset-smoke';
import { updateProductStatus } from '../src/lib/catalog/repository';
import { loadLocalEnv } from './lib/script-env';

const revision = '2026-09-30-r1';
const reportPath = 'config/print-assets/batches/2026-09-cirrus-05/cirrus-05-aktywacja.json';

async function main() {
  const env = loadLocalEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.PRINT_ASSET_TOKEN_SECRET) throw new Error('Missing credentials');
  if (new URL(env.SUPABASE_URL).hostname !== 'wnlysejenowymjdxlnaq.supabase.co') throw new Error('Wrong database');
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const read = async (table: string) => { const result = await db.from(table).select('*'); if (result.error) throw result.error; return result.data; };
  const [products, variants, media, assets, assignments, collections, drafts, documents, versions] = await Promise.all([
    read('products'),
    db.from('product_variants').select('*').eq('product_id', copy.productId).then(result => { if (result.error) throw result.error; return result.data; }),
    db.from('product_media').select('*').eq('product_id', copy.productId).then(result => { if (result.error) throw result.error; return result.data; }),
    db.from('print_fulfilment_assets').select('*').eq('product_id', copy.productId).then(result => { if (result.error) throw result.error; return result.data; }),
    db.from('print_variant_asset_assignments').select('*').eq('product_id', copy.productId).then(result => { if (result.error) throw result.error; return result.data; }),
    read('collections'), read('collection_drafts'), read('cms_documents'), read('cms_document_versions'),
  ]);
  const product = products.find(row => row.id === copy.productId);
  if (!product || !['draft', 'active'].includes(product.status)) throw new Error('Unexpected product status');
  if (variants.length !== 12 || variants.some(row => !row.active)) throw new Error('Variant coverage incomplete');
  if (media.length !== 1 || media[0].url !== '/uploads/fap-058.webp' || media[0].alt !== copy.name || !media[0].is_primary) throw new Error('Media mismatch');
  const ready = assets.filter(row => row.revision === revision && row.status === 'ready' && !row.revoked_at);
  if (ready.length !== 3 || assignments.length !== 12) throw new Error('Asset coverage incomplete');
  for (const variant of variants) {
    const assignment = assignments.find(row => row.variant_key === variant.variant_key);
    const asset = ready.find(row => row.id === assignment?.asset_id);
    if (!asset || asset.width_px !== variant.print_area_width_px || asset.height_px !== variant.print_area_height_px) throw new Error(`Assignment mismatch ${variant.variant_key}`);
  }
  const document = documents.find(row => row.kind === 'product_notes' && row.slug === 'fine-art-prints' && row.status === 'published');
  if (!document) throw new Error('Missing published notes document');
  for (const locale of ['pl', 'en', 'es', 'de'] as const) {
    const version = versions.find(row => row.document_id === document.id && row.locale === locale && row.status === 'published');
    if (version?.payload.notes[copy.productId] !== copy[locale]) throw new Error(`Description mismatch ${locale}`);
  }
  const cirrus = drafts.find(draft => collections.some(collection => collection.id === draft.collection_id && collection.published_revision === draft.revision)
    && draft.payload?.name === 'Cirrus');
  if (cirrus?.payload?.fields?.find((field: { key: string }) => field.key === 'products')?.value !== 'fap045,fap058') throw new Error('Cirrus collection mismatch');

  const filenames = fs.readdirSync('public/uploads').filter(filename => /^fap-058(?:[.-])/.test(filename));
  if (filenames.length !== 28) throw new Error(`Expected 28 storefront files, got ${filenames.length}`);
  const sha = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
  for (let start = 0; start < filenames.length; start += 6) await Promise.all(filenames.slice(start, start + 6).map(async filename => {
    const response = await fetch(`https://anna-ciok.studio/uploads/${filename}`, { signal: AbortSignal.timeout(30_000) });
    if (response.status !== 200 || sha(Buffer.from(await response.arrayBuffer())) !== sha(fs.readFileSync(`public/uploads/${filename}`))) throw new Error(`Deployment mismatch ${filename}`);
  }));
  for (const asset of ready) {
    const url = await signPrintAssetUrl(asset.id, env.PRINT_ASSET_TOKEN_SECRET, Date.now(), 'https://anna-ciok.studio');
    const probe = await probeSignedPrintAssetHead(url, (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }));
    if (!probe.ok || probe.contentType !== 'image/jpeg' || probe.contentLength !== Number(asset.byte_size)) throw new Error(`Fulfilment HEAD failed ${asset.id}`);
  }
  const report = { checkedAt: new Date().toISOString(), status: 'preflight_passed', productId: copy.productId,
    revision, storefrontFiles: filenames.length, signedAssetProbes: ready.length, variants: variants.length,
    descriptions: 4, collection: 'Cirrus', before: product.status, after: product.status, completedAt: null as string | null };
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  save();
  if (!process.argv.includes('--apply')) return console.log('Cirrus 05 activation preflight passed.');
  if (product.status !== 'active') await updateProductStatus(db, copy.productId, 'active', 'cirrus-05-release@ceramics-drop.internal');
  const { data: after, error } = await db.from('products').select('status').eq('id', copy.productId).single();
  if (error || after.status !== 'active') throw error ?? new Error('Activation incomplete');
  report.status = 'active_verified'; report.after = 'active'; report.completedAt = new Date().toISOString(); save();
  console.log('Cirrus 05 active.');
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
