/** Guarded activation of the reviewed September batch. Read-only unless --apply. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import copy from '../config/print-assets/batches/2026-09-new-prints/nowe-printy-2026-opisy.json';
import collections from '../config/print-assets/batches/2026-09-new-prints/nowe-printy-2026-kolekcje.json';
import fulfilment from '../config/print-assets/batches/2026-09-new-prints/nowe-printy-2026-r2-publikacja.json';
import { signPrintAssetUrl } from '../src/lib/print-assets';
import { probeSignedPrintAssetHead } from '../src/lib/print-asset-smoke';
import { updateProductStatus } from '../src/lib/catalog/repository';
import { loadLocalEnv } from './lib/script-env';

const batchDir = 'config/print-assets/batches/2026-09-new-prints';
async function main() {
  const env = loadLocalEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.PRINT_ASSET_TOKEN_SECRET) throw new Error('Missing credentials');
  if (new URL(env.SUPABASE_URL).hostname !== 'wnlysejenowymjdxlnaq.supabase.co') throw new Error('Wrong database');
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const ids = copy.prints.map(p => p.productId);
  const read = async (table: string) => { const r = await db.from(table).select('*'); if (r.error) throw r.error; return r.data; };
  const [products, allVariants, allMedia, allAssets, allAssignments, groups, drafts, docs, versions] = await Promise.all(
    ['products', 'product_variants', 'product_media', 'print_fulfilment_assets', 'print_variant_asset_assignments', 'collections', 'collection_drafts', 'cms_documents', 'cms_document_versions'].map(async table => {
      // Batch tables can exceed PostgREST's default page size; filter at source.
      if (['product_variants', 'product_media', 'print_fulfilment_assets', 'print_variant_asset_assignments'].includes(table)) {
        const r = await db.from(table).select('*').in('product_id', ids); if (r.error) throw r.error; return r.data;
      }
      return read(table);
    }),
  );
  const selected = products.filter(p => ids.includes(p.id));
  if (selected.length !== 16 || selected.some(p => !['draft', 'active'].includes(p.status))) throw new Error('Unexpected product statuses');
  if (allVariants.length !== 192 || allAssets.length !== 48 || allAssignments.length !== 192 || allMedia.length !== 16) throw new Error('Incomplete batch');
  const document = docs.find(d => d.kind === 'product_notes' && d.slug === 'fine-art-prints' && d.status === 'published');
  if (!document) throw new Error('Missing published notes');
  for (const locale of ['pl', 'en', 'es', 'de'] as const) {
    const version = versions.find(v => v.document_id === document.id && v.locale === locale && v.status === 'published');
    for (const print of copy.prints) if (version?.payload.notes[print.productId] !== print[locale]) throw new Error(`Description mismatch ${locale}/${print.productId}`);
  }
  for (const collection of collections.collections) {
    const published = drafts.filter(d => groups.some(g => g.id === d.collection_id && g.published_revision === d.revision));
    const group = published.find(d => d.payload.name === collection.name && d.payload.fields.some((f: { key: string; value: string }) => f.key === 'slug' && f.value === collection.slug));
    if (!group || group.payload.fields.find((f: { key: string }) => f.key === 'products')?.value !== collection.prints.map(p => p.productId).join(',')) throw new Error(`Collection mismatch ${collection.name}`);
  }
  for (const print of copy.prints) {
    if (allMedia.find(m => m.product_id === print.productId)?.url !== `/uploads/fap-${print.productId.slice(3)}.webp`) throw new Error(`Hero mismatch ${print.productId}`);
    const expected = fulfilment.products.find(p => p.productId === print.productId)!;
    for (const asset of expected.readyAssets) {
      const actual = allAssets.find(a => a.id === asset.assetId);
      if (!actual || actual.status !== 'ready' || actual.revision !== fulfilment.revision || actual.sha256 !== asset.sha256 || actual.r2_key !== asset.r2Key || Number(actual.byte_size) !== asset.bytes || !actual.verified_at || actual.revoked_at) throw new Error(`Unready asset ${asset.assetId}`);
    }
    const variants = allVariants.filter(v => v.product_id === print.productId);
    if (variants.length !== 12) throw new Error(`Variant count ${print.productId}`);
    for (const variant of variants) {
      const assignment = allAssignments.find(a => a.product_id === print.productId && a.variant_key === variant.variant_key);
      const asset = allAssets.find(a => a.id === assignment?.asset_id && a.product_id === print.productId);
      if (!variant.active || !asset || asset.width_px !== variant.print_area_width_px || asset.height_px !== variant.print_area_height_px) throw new Error(`Invalid assignment ${print.productId}/${variant.variant_key}`);
    }
  }
  // Verify bytes of every deployed storefront asset immediately before activation.
  const filenames = fs.readdirSync('public/uploads').filter(f => /^fap-0(4[2-9]|5[0-7])(?:[.-])/.test(f));
  if (filenames.length !== 448) throw new Error('Missing local storefront media');
  const sha = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
  for (let start = 0; start < filenames.length; start += 8) await Promise.all(filenames.slice(start, start + 8).map(async filename => {
    const response = await fetch(`https://anna-ciok.studio/uploads/${filename}`, { signal: AbortSignal.timeout(30_000) });
    if (response.status !== 200 || sha(Buffer.from(await response.arrayBuffer())) !== sha(fs.readFileSync(`public/uploads/${filename}`))) throw new Error(`Deployment mismatch ${filename}`);
  }));
  for (let start = 0; start < allAssets.length; start += 4) await Promise.all(allAssets.slice(start, start + 4).map(async asset => {
    const url = await signPrintAssetUrl(asset.id, env.PRINT_ASSET_TOKEN_SECRET!, Date.now(), 'https://anna-ciok.studio');
    const probe = await probeSignedPrintAssetHead(url, (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }));
    if (!probe.ok || probe.contentType !== 'image/jpeg' || probe.contentLength !== Number(asset.byte_size)) throw new Error(`Fulfilment HEAD failed: ${asset.id}, status ${probe.status}`);
  }));
  const report = { checkedAt: new Date().toISOString(), status: 'preflight_passed', storefrontFiles: 448, signedAssetProbes: 48, variants: 192,
    descriptions: 64, collections: 8, products: selected.map(p => ({ id: p.id, before: p.status, after: p.status })), completedAt: null as string | null };
  console.log('Preflight passed: 448 deployed images, 48 signed asset routes, 192 assignments, 64 descriptions, 8 collections.');
  const save = () => fs.writeFileSync(`${batchDir}/nowe-printy-2026-aktywacja.json`, JSON.stringify(report, null, 2) + '\n');
  if (!process.argv.includes('--apply')) { save(); return; }
  report.status = 'activating'; save();
  for (const product of report.products) {
    if (product.before !== 'active') await updateProductStatus(db, product.id, 'active', 'new-print-batch@ceramics-drop.internal');
    product.after = 'active'; save();
  }
  const after = await read('products');
  if (after.filter(p => ids.includes(p.id) && p.status === 'active').length !== 16) throw new Error('Activation incomplete');
  for (const old of products.filter(p => !ids.includes(p.id))) {
    const current = after.find(p => p.id === old.id);
    if (!current || Object.keys(old).some(key => JSON.stringify(current[key]) !== JSON.stringify(old[key]))) throw new Error(`Unrelated product changed: ${old.id}`);
  }
  report.status = 'active_verified'; report.completedAt = new Date().toISOString(); save();
  console.log('All 16 products active; unrelated product rows unchanged.');
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
