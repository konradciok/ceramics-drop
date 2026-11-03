/** Complete this batch's content and hero metadata; never activates products. Dry-run by default. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import copy from '../config/print-assets/batches/2026-09-new-prints/nowe-printy-2026-opisy.json';
import batch from '../config/print-assets/batches/2026-09-new-prints/nowe-printy-2026-kolekcje.json';
import { saveDraft, publishVersion } from '../src/lib/admin/content';
import { validateProductNotesPayload } from '../src/lib/cms/schemas';
import { readPrintPricingConfig } from '../src/lib/print-pricing-config/repository';
import { priceOfVariant } from '../src/lib/print-pricing';
import { buildFields, generateCollectionId } from './backfill-fine-art-collections';
import { loadLocalEnv } from './lib/script-env';

const reportPath = 'config/print-assets/batches/2026-09-new-prints/nowe-printy-2026-tresci-publikacja.json';
const locales = ['pl', 'en', 'es', 'de'] as const;
const actorEmail = 'new-print-batch@ceramics-drop.internal';
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const sha = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const collectionDescriptions: Record<string, string[]> = {
  aurora: ['Falujące pasma, otwarte pętle i miękkie plamy koloru.', 'Wavering bands, open loops and soft pools of colour.', 'Franjas ondulantes, lazos abiertos y manchas suaves de color.', 'Wellige Bänder, offene Schlaufen und weiche Farbflächen.'],
  cirrus: ['Lekkie błękitne formy z wyrazistym pomarańczowym akcentem.', 'Light blue forms with a vivid orange accent.', 'Formas azules ligeras con un acento naranja intenso.', 'Leichte blaue Formen mit einem leuchtenden orangefarbenen Akzent.'],
  cumulonimbus: ['Rozległe warstwy błękitu i ziemistych tonów, przecinane ciemnymi pasmami.', 'Broad layers of blue and earthy tones crossed by dark bands.', 'Amplias capas de azul y tonos terrosos atravesadas por bandas oscuras.', 'Breite Schichten in Blau und Erdtönen, durchzogen von dunklen Bändern.'],
  cumulus: ['Ciepłe drobiny, chłodne płaszczyzny i swobodne linie na jasnym tle.', 'Warm flecks, cool fields and free lines on a pale ground.', 'Motas cálidas, campos fríos y líneas libres sobre un fondo claro.', 'Warme Sprenkel, kühle Flächen und freie Linien auf hellem Grund.'],
  obsidian: ['Organiczne pierścienie i graficzne gesty w stonowanych, ziemistych barwach.', 'Organic rings and graphic gestures in subdued, earthy colours.', 'Anillos orgánicos y gestos gráficos en colores terrosos y contenidos.', 'Organische Ringe und grafische Gesten in gedeckten Erdfarben.'],
  scopulus: ['Wydłużone formy łączą ciepły rdzawy brąz z jasnym błękitem.', 'Elongated forms pair warm rusty brown with pale blue.', 'Formas alargadas combinan marrón oxidado cálido y azul claro.', 'Längliche Formen verbinden warmes Rostbraun mit Hellblau.'],
  unda: ['Przejrzyste błękity i głęboki kobalt w miękkich, płynnych kompozycjach.', 'Translucent blues and deep cobalt in soft, flowing compositions.', 'Azules translúcidos y cobalto intenso en composiciones suaves y fluidas.', 'Durchscheinende Blautöne und tiefes Kobalt in weichen, fließenden Kompositionen.'],
  tachylite: ['Turkusowe i ochrowe pierścienie spotykają smukłe, falujące linie.', 'Turquoise and ochre rings meet slender, wavering lines.', 'Anillos turquesa y ocre se encuentran con líneas finas y ondulantes.', 'Türkise und ockerfarbene Ringe treffen auf schlanke, wellige Linien.'],
};

async function main() {
  const env = loadLocalEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing credentials');
  if (new URL(env.SUPABASE_URL).hostname !== 'wnlysejenowymjdxlnaq.supabase.co') throw new Error('Wrong project');
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const ids = copy.prints.map(p => p.productId);
  const read = async (table: string) => {
    const { data, error } = await db.from(table).select('*');
    if (error) throw error;
    return data;
  };
  const [products, media, collections, collectionDrafts, documents, versions] = await Promise.all(
    ['products', 'product_media', 'collections', 'collection_drafts', 'cms_documents', 'cms_document_versions'].map(read),
  );
  if (products.filter(p => ids.includes(p.id) && p.status === 'draft').length !== 16) throw new Error('Expected 16 drafts');
  const document = documents.find(d => d.kind === 'product_notes' && d.slug === 'fine-art-prints');
  if (!document) throw new Error('Missing product notes document');
  const docVersions = versions.filter(v => v.document_id === document.id);
  const notePlans = locales.map(locale => {
    const current = docVersions.find(v => v.locale === locale && v.status === 'published');
    if (!current) throw new Error(`Missing published ${locale}`);
    if (docVersions.some(v => v.locale === locale && v.version > current.version)) throw new Error(`Unpublished newer ${locale} work exists`);
    const additions = Object.fromEntries(copy.prints.map(p => [p.productId, p[locale]]));
    for (const [id, text] of Object.entries(additions)) if (current.payload.notes[id] && current.payload.notes[id] !== text) throw new Error(`Existing content conflict: ${locale}/${id}`);
    const payload = validateProductNotesPayload('fine-art-prints', { notes: { ...current.payload.notes, ...additions } });
    return { locale, previousVersion: current.version, payload, unchanged: sha(payload) === sha(current.payload) };
  });
  const heroPlans = copy.prints.map(p => {
    const url = `/uploads/fap-${p.productId.slice(3)}.webp`;
    if (!fs.existsSync(`public${url}`)) throw new Error(`Missing hero ${url}`);
    const existing = media.filter(m => m.product_id === p.productId);
    if (existing.length && (existing.length !== 1 || existing[0].url !== url || !existing[0].is_primary)) throw new Error(`Media conflict ${p.productId}`);
    return { product_id: p.productId, url, alt: p.name, position: 0, is_primary: true };
  });
  const collectionPlans = batch.collections.map(c => {
    const fields = buildFields(c.name, c.slug, c.prints.map(p => p.productId)).map(field => field.key === 'description'
      ? { ...field, value: collectionDescriptions[c.slug][locales.indexOf(field.locale as typeof locales[number])] } : field);
    const matching = collectionDrafts.filter(d => d.payload?.name === c.name || d.payload?.fields?.some((f: { key: string; value: string }) => f.key === 'slug' && f.value === c.slug));
    if (matching.length > 1 || (matching.length && sha(matching[0].payload) !== sha({ name: c.name, fields }))) throw new Error(`Existing collection conflict ${c.name}`);
    const prior = matching[0];
    return { id: prior?.collection_id ?? generateCollectionId(), name: c.name, fields, exists: !!prior, published: !!prior && collections.find(r => r.id === prior.collection_id)?.published_revision === 1 };
  });
  const pricing = await readPrintPricingConfig(db);
  const prices = (['30x40', '50x70', '70x100'] as const).flatMap(size => [false, true].map(framed => ({ size, framed,
    ...Object.fromEntries((['pln', 'eur', 'gbp'] as const).map(currency => [currency, priceOfVariant({ size, framed, frameColour: framed ? 'natural' : 'none', mount: false }, currency, pricing)])),
  })));
  console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'apply' : 'dry-run', drafts: 16, heroRows: heroPlans.length, collections: collectionPlans.map(c => c.name), notes: notePlans.map(p => ({ locale: p.locale, previousVersion: p.previousVersion, count: Object.keys(p.payload.notes).length })), prices }, null, 2));
  if (!process.argv.includes('--apply')) return;
  // Collections and media resume by exact payload comparison. A newer
  // unpublished content revision requires operator review before retrying.
  const report = { completedAt: '', status: 'in_progress', productsRemainDraft: true, pricing, prices, mediaRows: 0,
    collections: [] as { id: string; name: string; revision: number }[], notes: [] as { locale: string; version: number; payloadSha256: string }[] };
  const checkpoint = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  checkpoint();
  const missingMedia = heroPlans.filter(p => !media.some(m => m.product_id === p.product_id));
  if (missingMedia.length) {
    const { error } = await db.from('product_media').insert(missingMedia);
    if (error) throw error;
  }
  report.mediaRows = 16; checkpoint();
  for (const c of collectionPlans) {
    if (!c.exists) {
      const { error } = await db.rpc('create_collection_with_draft', { p_id: c.id, p_payload: { name: c.name, fields: c.fields }, p_actor_email: actorEmail });
      if (error) throw error;
    }
    if (!c.published) {
      const { error } = await db.rpc('publish_collection_revision', { p_collection_id: c.id, p_expected_revision: 1, p_actor_email: actorEmail });
      if (error) throw error;
    }
    report.collections.push({ id: c.id, name: c.name, revision: 1 }); checkpoint();
  }
  for (const plan of notePlans) {
    // Preserve every existing published note; do not promote an unrelated draft.
    let version = plan.previousVersion;
    if (!plan.unchanged) {
      const current = await db.from('cms_document_versions').select('version').eq('document_id', document.id).eq('locale', plan.locale).order('version', { ascending: false }).limit(1).single();
      if (current.error || current.data.version !== plan.previousVersion) throw new Error(`Concurrent edit: ${plan.locale}`);
      const saved = await saveDraft({ kind: 'product_notes', slug: 'fine-art-prints', locale: plan.locale, payload: plan.payload, actorEmail, client: db });
      version = saved.version;
      await publishVersion({ kind: 'product_notes', slug: 'fine-art-prints', locale: plan.locale, version, actorEmail, client: db });
    }
    report.notes.push({ locale: plan.locale, version, payloadSha256: sha(plan.payload) }); checkpoint();
  }
  const after = await read('products');
  if (sha(after) !== sha(products)) throw new Error('Product rows changed during content preparation');
  const afterCollections = await read('collections');
  if (sha(afterCollections.filter(c => collections.some(old => old.id === c.id))) !== sha(collections)) throw new Error('Existing collections changed');
  report.completedAt = new Date().toISOString(); report.status = 'published_content_products_still_draft'; checkpoint();
  console.log('Complete: 16 hero rows, 8 published collections, 64 new localized notes. Product statuses unchanged.');
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
