// Offline editorial artifact. No storefront, database, or Notion writes.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { parse } from '@formatjs/icu-messageformat-parser';

const dir = dirname(fileURLToPath(import.meta.url));
const read = (file) => JSON.parse(readFileSync(resolve(dir, file), 'utf8'));
const save = (file, value) => writeFileSync(resolve(dir, file), JSON.stringify(value, null, 2) + '\n');
const baseline = read('baseline-pl.json');
const merge = (target, source) => {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) merge(target[key], value);
    else target[key] = value;
  }
};
const draft = structuredClone(baseline);
merge(draft, read('pl-overrides.json'));
merge(draft, read('legal-overrides.json'));

// Keep numeric product titles and note indices; replace stale launch copy.
for (const [category, copy] of Object.entries(draft.collection)) {
  if (typeof copy !== 'object' || ['sklep', 'fine-art-prints'].includes(category)) continue;
  copy.eyebrow = 'Ceramika — wcześniejsze kolekcje';
  if (category === 'kubki') copy.lead = 'Ręcznie malowane kubki z wcześniejszych kolekcji. Każdy jest osobnym egzemplarzem.';
}
for (const [key] of Object.entries(draft.meta.collections)) {
  if (['sklep', 'showroom', 'fineArtPrints'].includes(key)) continue;
  draft.meta.collections[key] = `${draft.title[key]} Anny Ciok — ręcznie malowana ceramika z wcześniejszych kolekcji. Poznaj przedmioty i umów wizytę w pracowni.`;
}

// The source-number embedded in old descriptions is not the public collection number.
// Keep descriptions about the pictured composition; do not invent visual details.
const curation = JSON.parse(readFileSync(resolve(dir, '../../../config/print-catalog-curation.json'), 'utf8'));
const printNames = Object.fromEntries(curation.collections.flatMap((c) => c.prints.map((p, i) => [p.productId, `${c.name} ${String(i + 1).padStart(2, '0')}`])));
const shortNotes = read('print-notes-pl.json');
draft.notes['fine-art-prints'] = draft.notes['fine-art-prints'].map((note, i) => shortNotes[`fap${String(i + 1).padStart(3, '0')}`] ?? note);

const flatten = (value, prefix = '') => Object.entries(value).flatMap(([key, text]) => {
  const id = prefix ? `${prefix}.${key}` : key;
  return typeof text === 'string' ? [[id, text]] : flatten(text, id);
});
const before = Object.fromEntries(flatten(baseline));
const flat = flatten(draft);
assert.deepEqual(flat.map(([key]) => key).sort(), Object.keys(before).sort(), 'Translation keys/indices changed');
const prohibited = /Anna Ciok Ceramics|czerwcow|5[–-]10|Prodigi|Warszaw|A3\+|\bB[12]\b|nadwyżka przepada|tego samego dnia\./iu;
const matches = flat.filter(([, value]) => prohibited.test(value));
assert.equal(matches.length, 0, `Unreviewed claims: ${matches.map(([key]) => key).join(', ')}`);
for (const [key, value] of flat) {
  try { parse(value); } catch (error) { throw new Error(`Invalid ICU at ${key}: ${error.message}`); }
}
save('pl.json', draft);

const cmsBefore = read('cms-before.json');
const cmsProposals = cmsBefore.map((document) => {
  const published = document.cms_document_versions.find((v) => v.locale === 'pl');
  if (!published) return null;
  const payload = structuredClone(published.payload);
  if (document.kind === 'page' && document.slug === 'home') {
    Object.assign(payload, { heroLine1: draft.home.heroLine1, heroLine2: draft.home.heroLine2, heroTagline: draft.home.heroTagline, ctaLabel: draft.home.heroCta });
  } else if (document.kind === 'page' && document.slug === 'print-pdp') {
    payload.artist = { name: draft.printPdp.artistName, bio: draft.printPdp.artistBio };
    payload.accordions = { productDetails: draft.printPdp.accordionProductDetails, framing: draft.printPdp.accordionFraming, shipping: draft.printPdp.accordionShipping };
  } else if (document.kind === 'product_notes' && document.slug === 'fine-art-prints') {
    // Strict CMS publication accepts the curated IDs only. Retired entries
    // remain intact in cms-before.json and the historical language baseline.
    payload.notes = Object.fromEntries(Object.keys(printNames).map((id) => [id, shortNotes[id]]));
  }
  return { kind: document.kind, slug: document.slug, locale: 'pl', baseVersion: published.version, baseUpdatedAt: document.updated_at, basePayloadSha256: createHash('sha256').update(JSON.stringify(published.payload)).digest('hex'), approval: 'pending', changed: JSON.stringify(payload) !== JSON.stringify(published.payload), payload };
}).filter(Boolean);
save('cms-proposals-pl.json', cmsProposals);

const location = (key) => {
  const section = key.split('.')[0];
  return ({ home: '/', collection: '/sklep i kategorie', print: 'Konfigurator Fine Art Print', printPdp: 'Karta Fine Art Print', notes: 'Opis produktu', showroom: '/showroom', studio: '/o-studiu', contact: '/kontakt', galleryPage: '/gallery', cart: '/koszyk', return: '/koszyk/return', returns: '/zwrot', account: '/konto', giftCard: '/karta-podarunkowa', terms: '/regulamin', privacy: '/polityka-prywatnosci', shipping: '/dostawa-i-zwroty', meta: 'SEO', nav: 'Menu', footer: 'Stopka' })[section] ?? section;
};
const dependency = (key) => {
  if (/giftCard|giftBalance|emailGift|emailRefund|invoice/.test(key)) return 'Saldo, rozliczenia i zwroty kart';
  if (/shipping|terms|privacy|returns|deliveryNotice|accordionShipping|Delivery|DeliveryNote/.test(key)) return 'Dokumenty, dostawa i zwroty — otwarte warunki';
  if (/showroom|ceramics|collection|filter|lightbox|cart|ceramic/.test(key)) return 'Routing i dostępność według aktywnego dropu';
  return 'Akceptacja PL, zgodne EN/ES/DE i publikacja';
};
const retired = /^(cart\.see|showroom\.(interest|emailLabel|messageLabel|consentLabel|privacyNote|submit)|returns\.(label|success|ineligible|unavailable|rateLimited|error))/;
const records = flat.map(([id, text]) => {
  const note = id.match(/^notes\.fine-art-prints\.(\d+)$/);
  const productId = note ? `fap${String(Number(note[1]) + 1).padStart(3, '0')}` : undefined;
  return { id, area: location(id), source: `messages/pl.json → ${id}${productId ? ` · ${productId} · ${printNames[productId] ?? 'Wzór archiwalny — nie aktywować'}` : ''}`, approval: 'pending', disposition: retired.test(id) ? 'retire-with-old-ui' : 'retain-or-update', ...(productId ? { productId, productName: printNames[productId] ?? 'Wzór archiwalny — nie aktywować' } : {}), dependency: retired.test(id) ? 'Wycofać z dawnym UI — nie publikować tych pól' : dependency(id), text, before: before[id], changed: text !== before[id] };
});
const additionalSources = { identity: 'src/lib/site.ts; src/lib/email-addresses.ts; Header; Footer; SEO; dokumenty', custom: 'src/app/[locale]/kontakt; src/app/[locale]/o-studiu; CTA mailto:ania@ciok.art', ceramics: 'src/lib/inventory.ts; src/lib/checkout.ts; kafelki/PDP/showroom; RPC rezerwacji', giftBalance: 'src/app/api/checkout/route.ts; koszyk; konto; przyszła księga salda', dimensions: 'src/components/shop/PrintConfigurator.tsx; macierz wymiarów wariantów', invoice: 'src/lib/invoice.ts; src/lib/admin; przyszłe rozliczenia źródeł płatności' };
for (const [id, text] of flatten(read('additional-pl.json'))) {
  const section = id.split('.')[0];
  const source = additionalSources[section] ?? (section.startsWith('emailNewsletter') ? 'src/lib/newsletter.ts' : 'src/lib/email.ts; src/lib/email-layout.ts');
  records.push({ id: `new.${id}`, area: section, source, approval: 'pending', dependency: dependency(id), text, before: '', changed: true });
}
for (const document of cmsProposals) {
  for (const [id, text] of flatten(document.payload)) {
    if (id.startsWith('media.')) continue;
    records.push({ id: `cms.${document.kind}.${document.slug}.${id}`, area: `CMS ${document.slug}`, source: `cms_documents / cms_document_versions → ${document.kind}:${document.slug}:pl:v${document.baseVersion}`, approval: 'pending', dependency: dependency(document.slug), text, before: '', changed: document.changed });
  }
}
save('register-pl.json', records);

const escape = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const format = (s) => escape(s).replace(/&lt;(\/?)(em|b|strong)&gt;/g, '<$1$2>').replaceAll('\n', '<br>');
const groups = [...new Set(records.map((r) => r.area))];
const html = `<!doctype html><html lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anna Ciok Studio — copy PL do akceptacji</title>
<style>*{box-sizing:border-box}body{margin:0;color:#282521;background:#f8f6f1;font:16px/1.65 system-ui,sans-serif}header,main{max-width:1120px;margin:auto;padding:28px}header{padding-top:60px}h1{font:normal clamp(36px,6vw,64px)/1.12 Georgia,serif;max-width:760px}h2{font:normal 32px Georgia,serif}.tag,small{color:#6e655b;font-size:12px;letter-spacing:.04em}.tag{background:#eee4cd;padding:5px 10px;border-radius:5px;display:inline-block}nav{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0}a{color:#453a2d}nav a{border:1px solid #d4cabe;padding:8px 14px;border-radius:4px;text-decoration:none}.filters{display:flex;gap:16px;flex-wrap:wrap;position:sticky;top:0;background:#f8f6f1;padding:16px 0;border-bottom:1px solid #ccc;z-index:1}input[type=search]{font:inherit;padding:10px;border:1px solid #a59887;border-radius:4px;flex:1;min-width:200px}article{border-top:1px solid #d4cabe;padding:24px 0}.text{font-size:19px;max-width:860px;white-space:normal}code{font-size:12px;overflow-wrap:anywhere}details{margin-top:16px;background:#efede6;padding:10px}summary{cursor:pointer}section{scroll-margin-top:100px}.source{font-size:12px;overflow-wrap:anywhere}.notice{border-left:3px solid #a38a55;padding-left:18px;max-width:880px}.mock{background:#ece7dc;padding:36px;margin:28px 0;border-radius:6px}.mock h2{font-size:42px;margin:0}.cta{display:inline-block;background:#37352d;color:white;padding:10px 18px;margin-top:12px}button{font:inherit;padding:10px}.count{align-self:center} [hidden]{display:none!important}@media(max-width:600px){header,main{padding:20px}.mock{padding:22px}.text{font-size:17px}.filters{position:static}}@media print{.filters,nav{display:none}.mock{break-inside:avoid}article{break-inside:avoid}}</style>
<header><small>ANNA CIOK STUDIO · 09.09.2026</small><h1>Polskie teksty<br>do zatwierdzenia.</h1><p class="notice">Propozycja redakcyjna. ${records.length} wpisów z przypisaniem źródeł. Ten podgląd nie publikuje zmian. Treści o kartach wymagają obsługi salda, a polityka dostaw — potwierdzenia terminów i kierunków.</p>
<div class="mock"><small>STRONA GŁÓWNA — PROPOZYCJA TREŚCI</small><h2>${format(draft.home.heroLine1)}<br>${format(draft.home.heroLine2)}</h2><p>${escape(draft.home.heroTagline)}</p><span class="cta">${escape(draft.home.heroCta)} → /sklep</span></div>
<nav><a href="documents-pl.md">Dokumenty i otwarte kwestie</a><a href="pl.json">PL JSON</a><a href="cms-proposals-pl.json">Zmiany CMS</a><a href="register-pl.json">Rejestr źródeł</a></nav></header>
<main><div class="filters"><input id="search" type="search" aria-label="Szukaj w tekstach i źródłach" placeholder="Szukaj tekstu, strony lub klucza"><label><input id="changed" type="checkbox"> Tylko zmienione</label><span id="count" class="count" aria-live="polite"></span></div><nav>${groups.map((g, i) => `<a href="#g${i}">${escape(g)}</a>`).join('')}</nav>
${groups.map((g, i) => `<section id="g${i}"><h2>${escape(g)}</h2>${records.filter((r) => r.area === g).map((r) => `<article data-changed="${r.changed}"><div class="tag">Do akceptacji · ${r.changed ? 'propozycja zmiany' : 'zachowane brzmienie'}</div><p class="text">${format(r.text) || '<em>Puste pole — ukrycie niepotwierdzonej etykiety</em>'}</p><code>${escape(r.id)}</code><p class="source">Źródło: ${escape(r.source)}<br>Warunek: ${escape(r.dependency)}</p>${r.changed && r.before ? `<details><summary>Poprzednia treść</summary>${format(r.before)}</details>` : ''}</article>`).join('')}</section>`).join('')}
<section><h2>Dokumenty do zatwierdzenia</h2><div style="white-space:pre-wrap">${escape(readFileSync(resolve(dir, 'documents-pl.md'), 'utf8'))}</div></section>
</main><script>const search=document.querySelector('#search'),changed=document.querySelector('#changed');function filter(){let count=0;document.querySelectorAll('article').forEach(a=>{a.hidden=(!a.textContent.toLocaleLowerCase('pl').includes(search.value.toLocaleLowerCase('pl')))||(changed.checked&&a.dataset.changed!=='true');if(!a.hidden)count++});document.querySelectorAll('section[id]').forEach(s=>s.hidden=![...s.querySelectorAll('article')].some(a=>!a.hidden));document.querySelector('#count').textContent=count+' wpisów'}search.addEventListener('input',filter);changed.addEventListener('change',filter);filter();</script></html>`;
writeFileSync(resolve(dir, 'preview.html'), html.replace('<style>', '<style>body{overflow-wrap:anywhere}'));
// Compact standalone mirror fits Notion's 200 KiB text-attachment limit.
const sources = [];
const deps = [...new Set(records.map((r) => r.dependency))];
const rows = records.map((r) => {
  const source = r.id.startsWith('cms.') || r.id.startsWith('new.') ? r.source : 'messages/pl.json';
  if (!sources.includes(source)) sources.push(source);
  return [r.id, r.text, groups.indexOf(r.area), sources.indexOf(source), deps.indexOf(r.dependency)];
});
const data = JSON.stringify({ rows, groups, sources, deps }).replaceAll('<', '\\u003c');
const notionHtml = `<!doctype html><html lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anna Ciok Studio — propozycja PL</title><style>body{font:16px/1.6 system-ui;background:#f8f6f1;color:#282521;max-width:960px;margin:auto;padding:24px;overflow-wrap:anywhere}h1,h2{font-family:Georgia,serif}h1{font-size:40px}input{font:inherit;width:100%;padding:12px;box-sizing:border-box}article{border-bottom:1px solid #ccc;padding:20px 0}small{color:#63594f}pre{white-space:pre-wrap}a{color:inherit}</style><h1>Polskie teksty do akceptacji</h1><p>Anna Ciok Studio · 09.09.2026. Wszystkie wpisy: do akceptacji. Brak publikacji sklepu. Teksty dotyczące nowych funkcji wymagają ich wdrożenia. Ta kopia zawiera pełny zestaw propozycji; lokalny podgląd pokazuje również poprzednie brzmienie.</p><input type="search" id="q" aria-label="Szukaj tekstów" placeholder="Szukaj tekstu lub klucza"><p id="count" aria-live="polite"></p><main id="items"></main><h2>Dokumenty i warunki publikacji</h2><pre>${escape(readFileSync(resolve(dir, 'documents-pl.md'), 'utf8'))}</pre><script>const d=${data};function show(){const q=document.querySelector('#q').value.toLocaleLowerCase('pl'),root=document.querySelector('#items');root.replaceChildren();let n=0;for(let i=0;i<d.groups.length;i++){const rows=d.rows.filter(r=>r[2]===i&&(r[0]+' '+r[1]+' '+d.groups[i]).toLocaleLowerCase('pl').includes(q));if(!rows.length)continue;const h=document.createElement('h2');h.textContent=d.groups[i];root.append(h);for(const r of rows){const a=document.createElement('article'),p=document.createElement('p'),s=document.createElement('small');p.textContent=r[1];s.textContent='Do akceptacji · '+r[0]+' · Źródło: '+d.sources[r[3]]+' · Warunek: '+d.deps[r[4]];a.append(p,s);root.append(a);n++}}document.querySelector('#count').textContent=n+' wpisów'}document.querySelector('#q').addEventListener('input',show);show();</script></html>`;
assert.ok(Buffer.byteLength(notionHtml, 'utf8') < 200 * 1024, 'Notion mirror exceeds inline upload size');
writeFileSync(resolve(dir, 'notion-preview.html'), notionHtml);
save('verification.json', { translationKeys: flat.length, registerEntries: records.length, cmsDocuments: cmsProposals.length, changedCmsDocuments: cmsProposals.filter((d) => d.changed).length, curatedPrintNames: Object.values(printNames), icu: 'passed', keyParity: 'passed', prohibitedClaims: 'passed', approval: 'pending' });
console.log(JSON.stringify({ keys: flat.length, records: records.length, cmsChanges: cmsProposals.filter((d) => d.changed).length }));
