# Content Phase Implementation Plan — Anna Ciok Ceramics

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the wired-but-empty Next.js scaffold with the real content from `design/` — 88-piece product data, trilingual copy (PL/EN/ES), and the markup for every page and component — so the storefront renders pixel-faithfully to the prototype in all three languages.

**Architecture:** The scaffold (routes, components, cart store, CSS tokens, fonts) is complete and correct; this phase only adds *content*. Three sources are authoritative and must be ported verbatim: `design/assets/shop.js` (product registry + cart/lightbox/checkout behaviour), `design/assets/i18n-dict.js` (the PL·EN·ES string dictionary), and the `design/*.html` page templates (markup structure). We port the dictionary into next-intl JSON catalogs (nested namespaces + ICU plurals), implement `getProducts()` from the shop.js generator, and render each component/page by translating its static HTML into JSX that reuses the existing CSS class names. Rich inline copy (`<em>` accents, `<strong>`, `<br>`, inline links) renders through next-intl `t.rich()` with a shared tag map.

**Tech Stack:** Next.js 16 (App Router, RSC) · React 19 · TypeScript · next-intl 4 (trilingual, `as-needed` prefix) · Zustand (cart) · Vitest (data-layer tests, added in Task 0). Plain `<img>` (not next/image), matching the scaffold.

---

## Source-of-truth file map

| What | Source file | Notes |
|---|---|---|
| Product generator, SOLD set, measures, NOTES (descriptions) | `design/assets/shop.js` | `PRODUCTS` loop (lines 336–398), `SOLD` (334), `NOTES` (15–328) |
| String dictionary PL/EN/ES | `design/assets/i18n-dict.js` | PL 9–197 · EN 200–388 · ES 391–581 |
| Header/Footer/announce markup | `design/assets/shop.js` `renderChrome()` | lines 456–531 |
| Gallery tile / selection bar / lightbox / cart / checkout / contact-form behaviour | `design/assets/shop.js` | lines 533–822 |
| Home markup | `design/index.html` | |
| Studio markup | `design/O-studiu.html` | |
| Collection markup (×7) | `design/Kubki.html`, `Wazony.html`, `Wazony-duze.html`, `Talerzyki.html`, `Talerze-duze.html`, `Duze-michy.html`, `Miski-falowane.html` | all identical structure, different head copy |
| Contact markup | `design/Kontakt.html` | |
| Cart page shell | `design/Koszyk.html` | |
| Prose/legal markup | `design/Dostawa-i-zwroty.html`, `Regulamin.html`, `Polityka-prywatnosci.html` | |
| Product images (88 PNG) | `design/uploads/*.png` | copy to `public/uploads/` (Task 12) |

---

## Global content-porting rules (the transformation contract)

These rules apply to **every** ported string and template. Tasks reference them instead of repeating.

**R1 — Rich tags.** Design strings embed `<em>`, `<strong>`, `<b>`, `<br>`. Keep `<em>`, `<strong>`, `<b>` verbatim in the JSON message; **convert every `<br>` to `<br/>`** (next-intl requires balanced/self-closed tags). Render such strings with `t.rich(key, richTags)` (the shared map from Task 3). Strings with **no** tags use plain `t(key)`.

**R2 — Inline links.** A few prose strings embed `<a class="inline" href="…">label</a>`. In the JSON, replace the anchor with `<link>label</link>`. At the call site, pass a `link` renderer in addition to `richTags`:
- mailto: `link: (c) => <a className="inline" href="mailto:hej@annaciok.pl">{c}</a>`
- internal: `link: (c) => <Link className="inline" href="/dostawa-i-zwroty">{c}</Link>` (use `@/i18n/navigation` `Link`; rewrite the `.html` href to the Next route).

**R3 — Pluralization → ICU.** Replace the dictionary's `*_word_0/1/2` triples + manual `plural()` with ICU plural messages. PL uses `one/few/many/other`; EN/ES use `one/other`. Example mapping for "pieces selected":
```
"selbar": { "word": "{count, plural, one {praca wybrana} few {prace wybrane} many {prac wybranych} other {prac wybranych}}" }
```
Call as `t('selbar.word', { count: n })`. (We emit only the word; the number is rendered separately as `<em>{n}</em>` to preserve the design's styling.)

**R4 — Internal routes.** Design hrefs map to Next routes (locale-aware `Link` from `@/i18n/navigation`):
`Kubki.html`→`/kubki`, `Wazony.html`→`/wazony`, `Wazony-duze.html`→`/wazony-duze`, `Talerzyki.html`→`/talerzyki`, `Talerze-duze.html`→`/talerze-duze`, `Duze-michy.html`→`/duze-michy`, `Miski-falowane.html`→`/miski-falowane`, `Koszyk.html`→`/koszyk`, `O-studiu.html`→`/o-studiu`, `O-studiu.html#proces`→`/o-studiu#proces`, `Kontakt.html`→`/kontakt`, `Dostawa-i-zwroty.html`→`/dostawa-i-zwroty`, `Regulamin.html`→`/regulamin`, `Polityka-prywatnosci.html`→`/polityka-prywatnosci`, `index.html`→`/`. External: `mailto:hej@annaciok.pl`, `https://instagram.com` (plain `<a>`).

**R5 — Asset paths.** `uploads/foo.png`→`/uploads/foo.png`; `assets/logotype.png`→`/logotype.png` (already in `public/`).

**R6 — Drop the design-tool noise.** Omit `data-screen-label`, `data-page`, `data-title-key`, `data-i18n`, `data-i18n-attr`, and the `<script>` tags — they are prototype/Claude-Design artifacts with no place in the React app.

**R7 — Currency.** Always render prices via `euro()` from `@/lib/format` (`€ 22`), never hardcode.

**R8 — Category slug ↔ note key.** Product descriptions (`NOTES`) live under the **route slug** in messages (`notes.kubki`, `notes.wazony-duze`, …). The shop.js `NOTES` object keys differ from route slugs — map on port: `kubki→kubki`, `wazony→wazony`, `wazyduze→wazony-duze`, `talerze→talerzyki`, `talerzeduze→talerze-duze`, `michy→duze-michy`, `miski→miski-falowane`.

**R9 — Singular product names.** shop.js `NAME_KEY` maps category→singular key (`mug/vase/bigvase/dish/plate/largebowl/wavybowl`). Store these under `product.<key>` in messages and add `singularKey` to the `Category` registry.

---

## Message catalog namespace schema

All three catalogs (`messages/pl.json`, `en.json`, `es.json`) share this structure. Every key from `design/assets/i18n-dict.js` maps into exactly one namespace below. Port **all three locales** for **every** key.

```jsonc
{
  "title":   { "home","kubki","wazony","wazonyDuze","talerzyki","talerzeDuze","duzeMichy","miskiFalowane","koszyk","studio","kontakt","dostawa","regulamin","polityka" }, // from title_*
  "nav":     { "sklep","kubki","wazony","wazonyDuze","talerzyki","talerzeDuze","duzeMichy","miskiFalowane","studio","kontakt" }, // from nav_*  (NOTE: matches CATEGORIES[*].nameKey already = "nav.kubki" etc.)
  "aria":    { "cart","zoom","close","prev","next" },               // aria_*
  "footer":  { "tagline","blurb","hShop","hStudio","hInfo","hKontakt","koszyk","oArtystce","proces","dostawa","regulamin","polityka","odbior","copy","proto","nopay" }, // foot_*
  "product": { "mug","vase","bigvase","dish","plate","largebowl","wavybowl" },  // singular names (mug,vase,…)
  "gallery": { "sold" },                                            // sold
  "selbar":  { "clear","go","word"(ICU),"total" },                  // sel_*
  "lightbox":{ "drop","add","in","specDims","specTech","specCopy","specTechVal","specCopyVal","approx" }, // lb_*, spec_*, approx
  "cart":    { "emptyH","emptyP","seeMugs","seeVases","seeBigvases","seeDishes","seePlates","seeLargebowls","seeWavybowls",
               "eyebrow","label","word"(ICU),"oneoff","remove","summary","pieces","delivery","free","total","checkout","fineprint","simBanner" },
  "ship":    { "courierT","courierD","courierPrice","pickupT","pickupD","pickupPrice" },
  "confirm": { "eyebrow","h","p1","order","worth","tail","word"(ICU),"orderno","back","more" },
  "home":    { "heroEyebrow","heroTitle","heroSub","heroCta1","heroCta2","heroMetaName","heroMetaDesc",
               "marquee"(string[4]),"colEyebrow","colTitle","colLead",
               "card": { "mug":{num,desc,cta}, "vase":{…}, "bigvase":{…}, "dish":{…}, "plate":{…}, "largebowl":{…}, "wavybowl":{…} },
               "storyEyebrow","storyTitle","storyP1","storyP2","storyP3","storyCta1","storyCta2",
               "craftEyebrow","craftTitle","craft1H","craft1P","craft2H","craft2P","craft3H","craft3P",
               "ctEyebrow","ctH","ctP","ctBtn","ctLEmail","ctLIg","ctVIg","ctLStudio","ctVStudio","ctLShip","ctVShip" },
  "collection": { "hint",
               "kubki":{eyebrow,title,lead}, "wazony":{…}, "wazony-duze":{…}, "talerzyki":{…},
               "talerze-duze":{…}, "duze-michy":{…}, "miski-falowane":{…} },  // from kub_/waz_/wd_/tl_/tp_/mb_/wb_ + shop_hint
  "studio":  { "eyebrow","h1","lead","storyEyebrow","storyH","storyP1","storyP2","storyP3",
               "factsEyebrow","factsH","fact1K","fact1V","fact1D","fact2K","fact2V","fact2D","fact3K","fact3V","fact3D","fact4K","fact4V","fact4D",
               "procEyebrow","procH","p1H","p1P","p2H","p2P","p3H","p3P","ctaH","ctaP","ctaB1","ctaB2" },  // st_*, fact*
  "contact": { "eyebrow","h1","lead","fName","fNamePh","fEmail","fEmailPh","fTopic",
               "topic1","topic2","topic3","topic4","topic5","fMsg","fMsgPh","submit","note","sentH","sentP",
               "sideH","lEmail","lIg","vIg","lStudio","vStudio","lShip","vShip","lReply","vReply" },  // k_*
  "shipping":{ "eyebrow","h1","lead","toc","toc1".."toc6","updated",
               "s1H","s1P","s1Li1","s1Li2","s1Li3","s2H","s2P","s2Note","s3H","s3P","s4H","s4P",
               "s5H","s5P","s5Li1","s5Li2","s5Li3","s6H","s6P" },  // d_*
  "terms":   { "eyebrow","h1","lead","toc","toc1".."toc7","updated","protoNote",
               "s1H","s1P1","s1P2","s2H","s2P","s2Li1","s2Li2","s3H","s3P","s4H","s4P","s5H","s5P","s6H","s6P","s7H","s7P" },  // r_*
  "privacy": { "eyebrow","h1","lead","toc","toc1".."toc6","updated","protoNote",
               "s1H","s1P","s2H","s2Li1","s2Li2","s2Li3","s2P","s3H","s3P","s4H","s4P","s5H","s5P","s6H","s6P" },  // p_*
  "notes":   { "kubki":[…22], "wazony":[…8], "wazony-duze":[…9], "talerzyki":[…15],
               "talerze-duze":[…12], "duze-michy":[…6], "miski-falowane":[…16] }  // from shop.js NOTES (R8)
}
```

> The existing scaffold already references `nav.kubki` etc. via `CATEGORIES[*].nameKey` — that is why `nav` is a top-level namespace with those exact subkeys. Do not rename.

---

## Task 0: Add Vitest for data-layer tests

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (add `test` script + devDependency)

- [ ] **Step 1: Install Vitest**

Run: `npm install -D vitest@^2`
Expected: `vitest` appears under devDependencies; lockfile updates.

- [ ] **Step 2: Create the Vitest config with the `@/` alias**

Create `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Add the test script**

In `package.json` `scripts`, add:
```json
"test": "vitest run"
```

- [ ] **Step 4: Smoke-test the runner**

Run: `npx vitest run`
Expected: exits 0 with "No test files found" (no tests yet).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add vitest for data-layer tests"
```

---

## Task 1: Implement `getProducts()` (88 pieces) + type/registry additions

**Files:**
- Modify: `src/lib/types.ts` (add `noteIndex` to `Product`, `singularKey` to `Category`)
- Modify: `src/lib/products.ts` (add `singularKey` per category; implement `getProducts()`)
- Test: `src/lib/products.test.ts`

Reference: `design/assets/shop.js` lines 334–398 (SOLD set + the seven generation loops, including the two file-number skip lists for `wazony-duze` and `talerze-duze`).

- [ ] **Step 1: Write the failing test**

Create `src/lib/products.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  getProducts,
  getProductsByCategory,
  getProductById,
  CATEGORY_ORDER,
} from './products';

describe('getProducts', () => {
  it('builds exactly 88 pieces', () => {
    expect(getProducts()).toHaveLength(88);
  });

  it('has the right count per category', () => {
    const counts = { kubki: 22, wazony: 8, 'wazony-duze': 9, talerzyki: 15, 'talerze-duze': 12, 'duze-michy': 6, 'miski-falowane': 16 };
    for (const slug of CATEGORY_ORDER) {
      expect(getProductsByCategory(slug)).toHaveLength(counts[slug]);
    }
  });

  it('marks exactly the five sold pieces', () => {
    const sold = getProducts().filter((p) => p.sold).map((p) => p.id).sort();
    expect(sold).toEqual(['k04', 'k11', 'k19', 'v02', 'v06']);
  });

  it('maps image files, honouring the skip lists', () => {
    expect(getProductById('k01')!.image).toBe('/uploads/kubek-1.png');
    expect(getProductById('v01')!.image).toBe('/uploads/waza-mala-1.png');
    // wazony-duze skips file 2: d02 → waza-duza-3.png
    expect(getProductById('d02')!.image).toBe('/uploads/waza-duza-3.png');
    // talerze-duze skips file 12: p12 → talerz-duzy-13.png
    expect(getProductById('p12')!.image).toBe('/uploads/talerz-duzy-13.png');
    expect(getProductById('w16')!.image).toBe('/uploads/miski-falowane-16.png');
  });

  it('sets price, measure and noteIndex from the category', () => {
    const k = getProductById('k01')!;
    expect(k).toMatchObject({ price: 22, measure: '9 × 9 cm · 300 ml', num: '01', noteIndex: 0 });
    expect(getProductById('d02')!.noteIndex).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/products.test.ts`
Expected: FAIL — `getProducts()` returns `[]`, so length is 0.

- [ ] **Step 3: Add `noteIndex` to `Product` and `singularKey` to `Category`**

In `src/lib/types.ts`, inside `interface Product` add:
```ts
  /** 0-based index into the category's `notes` array (description lookup). */
  noteIndex: number;
```
Inside `interface Category` add:
```ts
  /** i18n key for the singular product name (e.g. `mug`). */
  singularKey: string;
```

- [ ] **Step 4: Add `singularKey` to each category in the registry**

In `src/lib/products.ts`, extend each `CATEGORIES` entry with `singularKey`:
```ts
  kubki: { slug: 'kubki', nameKey: 'nav.kubki', singularKey: 'mug', price: 22, measure: '9 × 9 cm · 300 ml', count: 22 },
  wazony: { slug: 'wazony', nameKey: 'nav.wazony', singularKey: 'vase', price: 50, measure: '18 × 16 cm', count: 8 },
  'wazony-duze': { slug: 'wazony-duze', nameKey: 'nav.wazonyDuze', singularKey: 'bigvase', price: 95, measure: '24 × 20 cm', count: 9 },
  talerzyki: { slug: 'talerzyki', nameKey: 'nav.talerzyki', singularKey: 'dish', price: 25, measure: '⌀ 12 cm', count: 15 },
  'talerze-duze': { slug: 'talerze-duze', nameKey: 'nav.talerzeDuze', singularKey: 'plate', price: 65, measure: '⌀ 28 cm', count: 12 },
  'duze-michy': { slug: 'duze-michy', nameKey: 'nav.duzeMichy', singularKey: 'largebowl', price: 75, measure: '⌀ 26 × 14 cm', count: 6 },
  'miski-falowane': { slug: 'miski-falowane', nameKey: 'nav.miskiFalowane', singularKey: 'wavybowl', price: 38, measure: '⌀ 16 × 9 cm', count: 16 },
```

- [ ] **Step 5: Implement `getProducts()`**

In `src/lib/products.ts`, replace the stub `getProducts()` with:
```ts
const SOLD = new Set(['k04', 'k11', 'k19', 'v02', 'v06']);

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const range = (a: number, b: number) =>
  Array.from({ length: b - a + 1 }, (_, i) => a + i);

type Spec = {
  slug: CategorySlug;
  prefix: string;
  imageBase: string;
  /** Image file numbers, in display order (skips reflect missing files). */
  files: number[];
};

const SPECS: Spec[] = [
  { slug: 'kubki', prefix: 'k', imageBase: 'kubek', files: range(1, 22) },
  { slug: 'wazony', prefix: 'v', imageBase: 'waza-mala', files: range(1, 8) },
  { slug: 'wazony-duze', prefix: 'd', imageBase: 'waza-duza', files: [1, 3, 4, 5, 6, 7, 8, 9, 10] },
  { slug: 'talerzyki', prefix: 't', imageBase: 'talerz-maly', files: range(1, 15) },
  { slug: 'talerze-duze', prefix: 'p', imageBase: 'talerz-duzy', files: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13] },
  { slug: 'duze-michy', prefix: 'b', imageBase: 'duza-micha', files: range(1, 6) },
  { slug: 'miski-falowane', prefix: 'w', imageBase: 'miski-falowane', files: range(1, 16) },
];

export function getProducts(): Product[] {
  const products: Product[] = [];
  for (const spec of SPECS) {
    const cat = CATEGORIES[spec.slug];
    spec.files.forEach((file, i) => {
      const num = pad(i + 1);
      const id = `${spec.prefix}${num}`;
      products.push({
        id,
        category: spec.slug,
        num,
        image: `/uploads/${spec.imageBase}-${file}.png`,
        price: cat.price,
        measure: cat.measure,
        sold: SOLD.has(id),
        noteIndex: i,
      });
    });
  }
  return products;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/lib/products.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add src/lib/types.ts src/lib/products.ts src/lib/products.test.ts
git commit -m "feat(data): build the 88-piece product registry"
```

---

## Task 2: Port the i18n catalogs (PL · EN · ES)

**Files:**
- Modify: `messages/pl.json`, `messages/en.json`, `messages/es.json`

This is a faithful port of `design/assets/i18n-dict.js` into the namespace schema above, applying R1 (`<br>`→`<br/>`), R2 (`<a>`→`<link>`), R3 (plural triples → ICU), R8 (note keys → route slugs). **Every key in each locale block must be ported.** Work one locale at a time; keep all three files structurally identical.

- [ ] **Step 1: Port `messages/pl.json`**

Build the full PL catalog from `design/assets/i18n-dict.js` lines 9–197 + the PL `NOTES` arrays in `design/assets/shop.js` lines 16–118. Representative excerpt (continue for **all** namespaces in the schema):
```jsonc
{
  "title": {
    "home": "Anna Ciok Ceramics — Drop czerwcowy 2026",
    "kubki": "Kubki — Anna Ciok Ceramics",
    "wazony": "Wazony — Anna Ciok Ceramics",
    "wazonyDuze": "Wazony duże — Anna Ciok Ceramics",
    "talerzyki": "Talerzyki — Anna Ciok Ceramics",
    "talerzeDuze": "Talerze duże — Anna Ciok Ceramics",
    "duzeMichy": "Duże michy — Anna Ciok Ceramics",
    "miskiFalowane": "Miski falowane — Anna Ciok Ceramics",
    "koszyk": "Koszyk — Anna Ciok Ceramics",
    "studio": "O studiu — Anna Ciok Ceramics",
    "kontakt": "Kontakt — Anna Ciok Ceramics",
    "dostawa": "Dostawa i zwroty — Anna Ciok Ceramics",
    "regulamin": "Regulamin — Anna Ciok Ceramics",
    "polityka": "Polityka prywatności — Anna Ciok Ceramics"
  },
  "nav": {
    "sklep": "Sklep", "kubki": "Kubki", "wazony": "Wazony", "wazonyDuze": "Wazony duże",
    "talerzyki": "Talerzyki", "talerzeDuze": "Talerze duże", "duzeMichy": "Duże michy",
    "miskiFalowane": "Miski falowane", "studio": "O studiu", "kontakt": "Kontakt"
  },
  "selbar": {
    "clear": "Wyczyść",
    "go": "Przejdź do kasy",
    "total": "· razem",
    "word": "{count, plural, one {praca wybrana} few {prace wybrane} many {prac wybranych} other {prac wybranych}}"
  },
  "home": {
    "heroEyebrow": "Drop czerwcowy 2026 — Nº 01",
    "heroTitle": "Każda sztuka jedna, <em>malowana ręką.</em>",
    "heroSub": "Osiemdziesiąt osiem ceramicznych prac z mojej małej pracowni — kubki, wazony, duże wazony, talerzyki, talerze, duże michy i miski falowane. Lepione i malowane pojedynczo, więc żadna druga taka nie istnieje. Wybierasz dokładnie ten egzemplarz, który widzisz na zdjęciu.",
    "marquee": ["malowane ręką", "jedyne w swoim rodzaju", "robione powoli", "prosto z pracowni"],
    "card": {
      "mug": { "num": "22 prace · € 22 każda", "desc": "Codzienne kubki do porannej kawy — palmy, cytryny, muszle i kaktusy malowane szkliwem.", "cta": "Wybierz kubek" }
      /* …vase, bigvase, dish, plate, largebowl, wavybowl from card_*_* … */
    }
  },
  "shipping": {
    "s1P": "Każdą pracę wysyłam kurierem na terenie całej Polski. Koszt przesyłki to <strong>€ 18</strong> niezależnie od liczby zamówionych prac — jeśli kupujesz kilka, jadą razem w jednej paczce.",
    "updated": "Prototyp sklepu<br/>Aktualizacja: czerwiec 2026"
    /* … */
  },
  "terms": {
    "s4P": "Zamówienia nadaję w ciągu 3–5 dni roboczych od zaksięgowania płatności. Szczegóły dotyczące kosztów, terminów i odbioru osobistego opisane są na stronie <link>Dostawa i zwroty</link>."
    /* … */
  },
  "notes": {
    "kubki": [
      "Niebieski kwiat na wysokiej łodydze. Malowany jednym tchem.",
      "Błękitna palma z terakotowymi orzechami. Lato zamknięte w kubku."
      /* …all 22, in order, from shop.js NOTES.pl.kubki … */
    ],
    "wazony-duze": [ /* …9, from shop.js NOTES.pl.wazyduze … */ ]
    /* …all 7 categories under their ROUTE slugs (R8) … */
  }
  /* …every other namespace from the schema… */
}
```
Notes on the marquee (`mq_line`): drop the inline `<span class="md"></span>` separators and split into the 4-phrase array shown. The `<span class="dot"></span>` in `announce` is not part of the string — `announce` is plain text.

- [ ] **Step 2: Validate PL JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('messages/pl.json','utf8')); console.log('ok')"`
Expected: `ok` (no parse error).

- [ ] **Step 3: Port `messages/en.json`** from i18n-dict.js lines 200–388 + `NOTES.en` (shop.js 120–222). EN plural messages use only `one`/`other`, e.g. `"word": "{count, plural, one {piece selected} other {pieces selected}}"`. Same namespace structure as PL.

- [ ] **Step 4: Validate EN JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('messages/en.json','utf8')); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 5: Port `messages/es.json`** from i18n-dict.js lines 391–581 + `NOTES.es` (shop.js 224–326). ES plural messages use `one`/`other`. Same structure.

- [ ] **Step 6: Validate ES JSON + key-parity check**

Run:
```bash
node -e "const f=l=>Object.keys(require('flat')?{}:{});" 2>/dev/null; node -e "
const fs=require('fs');
const flat=(o,p='')=>Object.entries(o).flatMap(([k,v])=>v&&typeof v==='object'&&!Array.isArray(v)?flat(v,p+k+'.'):[p+k]);
const ks=l=>new Set(flat(JSON.parse(fs.readFileSync('messages/'+l+'.json','utf8'))));
const [pl,en,es]=['pl','en','es'].map(ks);
const diff=(a,b)=>[...a].filter(x=>!b.has(x));
console.log('en missing:',diff(pl,en)); console.log('es missing:',diff(pl,es)); console.log('extra en:',diff(en,pl));
"
```
Expected: all arrays empty (`[]`). Fix any mismatch before committing.

- [ ] **Step 7: Commit**

```bash
git add messages/pl.json messages/en.json messages/es.json
git commit -m "feat(i18n): port PL/EN/ES message catalogs"
```

---

## Task 3: Shared rich-text tag map + Icon completion

**Files:**
- Create: `src/components/ui/richTags.tsx`
- Modify: `src/components/ui/Icon.tsx` (no path changes expected — verify all needed names exist)

Reference: shop.js icon set (lines 441–453) is already mirrored in `Icon.tsx`. Confirm names cover: `cart, check, arrow, close, chevron-left, chevron-right, trash, info`. (`zoom, spark` exist but are unused — leave them.)

- [ ] **Step 1: Create the shared tag map**

Create `src/components/ui/richTags.tsx`:
```tsx
import type { ReactNode } from 'react';

/**
 * Tag renderers for next-intl `t.rich(...)`. Mirrors the inline HTML the
 * design copy uses (em accents, strong, b, line breaks). For inline links,
 * spread this and add a `link` renderer at the call site (see plan R2).
 */
export const richTags = {
  em: (chunks: ReactNode) => <em>{chunks}</em>,
  strong: (chunks: ReactNode) => <strong>{chunks}</strong>,
  b: (chunks: ReactNode) => <b>{chunks}</b>,
  br: () => <br />,
};
```

- [ ] **Step 2: Verify the build still type-checks**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/richTags.tsx
git commit -m "feat(ui): shared rich-text tag map for next-intl"
```

---

## Task 4: Layout chrome — Header, Footer, Announce

**Files:**
- Modify: `src/components/layout/Header.tsx`
- Modify: `src/components/layout/Footer.tsx`
- Modify: `src/components/layout/Announce.tsx`

Reference: shop.js `renderChrome()` lines 456–531.

- [ ] **Step 1: Announce — wire the announcement copy**

`Announce` is a server-rendered child of `Header`. Change `Header` to pass the translated announcement in (keep `Announce` dumb). In `Announce.tsx` no change needed beyond accepting `children` (it already does). The copy comes from `header`/`announce` — store it as top-level `announce` in messages? It is currently `footer`-adjacent. Put `announce` under a top-level key. Update schema usage: add `"announce"` as a top-level message key (PL "Drop czerwcowy 2026 — 88 prac, każda jedyna w swoim rodzaju", EN/ES per dict). **Add this key in Task 2 catalogs** (top level). Render in `Header` (Step 2).

- [ ] **Step 2: Header — translated nav + active state**

Replace the hardcoded labels in `src/components/layout/Header.tsx`. It is a server component; use `getTranslations`. Active state: `Header` doesn't know the current route by default — use the locale-aware pathname via a tiny client wrapper is overkill; instead keep the design's behaviour (Shop link active on any collection page) by reading the pathname in a `'use client'` boundary **only** for active classes. Simplest faithful approach: keep `Header` server-rendered without active classes (the design's active state is cosmetic). If active styling is desired, defer to a follow-up. Implement:
```tsx
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Icon } from '@/components/ui/Icon';
import { Announce } from './Announce';
import { LangSwitch } from './LangSwitch';
import { CartCount } from './CartCount';

export async function Header() {
  const t = await getTranslations();
  return (
    <>
      <Announce>{t('announce')}</Announce>
      <header className="header">
        <div className="header-inner">
          <nav className="nav-left">
            <Link className="nav-link" href="/kubki">{t('nav.sklep')}</Link>
            <Link className="nav-link" href="/o-studiu">{t('nav.studio')}</Link>
          </nav>
          <Link className="brand" href="/">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logotype.png" alt="Anna Ciok Ceramics" width={48} height={48} />
            <span className="brand-word">ANNA CIOK<small>CERAMICS</small></span>
          </Link>
          <div className="nav-right">
            <Link className="nav-link" href="/kontakt">{t('nav.kontakt')}</Link>
            <LangSwitch />
            <Link className="icon-btn" href="/koszyk" aria-label={t('aria.cart')}>
              <Icon name="cart" />
              <CartCount />
            </Link>
          </div>
        </div>
      </header>
    </>
  );
}
```
> `Header` is already imported and rendered in `layout.tsx`. Changing it to `async` is fine in RSC. Verify `layout.tsx` renders `<Header />` (it does) — no await needed by the caller.

- [ ] **Step 3: Footer — translated 5-column markup**

Reference shop.js lines 488–528. Replace `src/components/layout/Footer.tsx` body with translated labels: brand (`footer.tagline`, `footer.blurb`), Shop column (loop `CATEGORY_ORDER` → `t(CATEGORIES[slug].nameKey)` + Koszyk link `footer.koszyk`), Studio column (`footer.oArtystce`→`/o-studiu`, `footer.proces`→`/o-studiu#proces`, `nav.kontakt`→`/kontakt`), Info column (`footer.dostawa/regulamin/polityka`), Kontakt column (mailto, Instagram, `footer.odbior`→`/kontakt`), and `footer-bot` row (`footer.copy`, `footer.proto`, `footer.nopay`). Use `getTranslations` (server component). Import `CATEGORIES, CATEGORY_ORDER` from `@/lib/products`.

- [ ] **Step 4: Verify chrome renders in all locales**

Run: `npm run build`
Expected: build succeeds; no "missing message" errors for `nav.*`, `footer.*`, `announce`, `aria.cart`.

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/Header.tsx src/components/layout/Footer.tsx src/components/layout/Announce.tsx
git commit -m "feat(layout): translated header, footer, announcement bar"
```

---

## Task 5: Shop components content — ProductTile, SelectionBar, Lightbox, Gallery

**Files:**
- Modify: `src/components/shop/ProductTile.tsx`
- Modify: `src/components/shop/SelectionBar.tsx`
- Modify: `src/components/shop/Lightbox.tsx`
- Modify: `src/components/shop/Gallery.tsx` (only if a wrapper change is needed — likely none)

All are `'use client'`; use `useTranslations()` from `next-intl`. Reference shop.js `tileHTML` (568–580), `updateSelbar` (619–626), `paintLightbox` (693–710).

- [ ] **Step 1: ProductTile — name, price, sold/add/in labels**

In `ProductTile.tsx`, derive the singular name from the category registry and translate labels:
```tsx
import { useTranslations } from 'next-intl';
import { CATEGORIES } from '@/lib/products';
// …
const t = useTranslations();
const name = t(`product.${CATEGORIES[product.category].singularKey}`);
```
Then: `alt`/meta name → `` `${name} Nº ${product.num}` ``; sold tag → `t('gallery.sold')`; add button text → `selected ? t('lightbox.in') : t('lightbox.add')`; the `.tile-meta .nm` shows `` `${name} Nº ${product.num}` `` and `.pr` shows `euro(product.price)`. Keep the existing select/toggle wiring.

- [ ] **Step 2: SelectionBar — pluralized count + labels**

In `SelectionBar.tsx`: render count as `<em>{n}</em> {t('selbar.word', { count: n })}`, total as `` `${t('selbar.total')} ${euro(total)}` `` (design shows "· razem € X"); clear button → `t('selbar.clear')`; go link → `t('selbar.go')` + arrow icon. Keep cart-store wiring + `/koszyk` link.

- [ ] **Step 3: Lightbox — eyebrow, name, note, specs, add button**

In `Lightbox.tsx`:
```tsx
const t = useTranslations();
const cat = product ? CATEGORIES[product.category] : undefined;
const name = cat ? t(`product.${cat.singularKey}`) : '';
const notes = t.raw(`notes.${product?.category}`) as string[] | undefined;
const note = product && notes ? notes[product.noteIndex] : '';
```
Render: eyebrow `` `${t(cat.nameKey)} — ${t('lightbox.drop')}` ``; `<h3>{name} <em>Nº {product.num}</em></h3>`; price `euro`; `.lb-note` → `note`; `.lb-specs` → three `.lb-spec` rows:
```tsx
<div className="lb-spec"><span className="k">{t('lightbox.specDims')}</span><span className="v">{`${t('lightbox.approx')} ${product.measure}`}</span></div>
<div className="lb-spec"><span className="k">{t('lightbox.specTech')}</span><span className="v">{t('lightbox.specTechVal')}</span></div>
<div className="lb-spec"><span className="k">{t('lightbox.specCopy')}</span><span className="v">{t('lightbox.specCopyVal')}</span></div>
```
add button → `inCart ? t('lightbox.in') : t('lightbox.add')` + arrow/check icon; aria labels → `t('aria.close/prev/next')`.

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: succeeds; no missing-message errors for `product.*`, `selbar.*`, `lightbox.*`, `notes.*`, `gallery.sold`.

- [ ] **Step 5: Commit**

```bash
git add src/components/shop/ProductTile.tsx src/components/shop/SelectionBar.tsx src/components/shop/Lightbox.tsx src/components/shop/Gallery.tsx
git commit -m "feat(shop): translated tile, selection bar, lightbox"
```

---

## Task 6: Collection pages — CollectionScreen content + per-page metadata

**Files:**
- Modify: `src/components/shop/CollectionScreen.tsx`
- Modify: all seven `src/app/[locale]/<slug>/page.tsx` (add `generateMetadata`)

Reference: `design/Kubki.html` (shop-head + shop-switch + shop-hint + gallery). The seven pages share `CollectionScreen`; per-collection copy lives under `collection.<slug>`.

- [ ] **Step 1: CollectionScreen — head, switcher, hint**

Rewrite `CollectionScreen.tsx` (server component) using `getTranslations`:
```tsx
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { CATEGORIES, CATEGORY_ORDER, getProductsByCategory } from '@/lib/products';
import type { CategorySlug } from '@/lib/types';
import { Icon } from '@/components/ui/Icon';
import { Gallery } from './Gallery';
import { richTags } from '@/components/ui/richTags';

export async function CollectionScreen({ slug }: { slug: CategorySlug }) {
  const t = await getTranslations();
  const products = getProductsByCategory(slug);
  return (
    <>
      <section className="shop-head">
        <div className="shop-head-inner">
          <div>
            <div className="eyebrow">{t(`collection.${slug}.eyebrow`)}</div>
            <h1>{t.rich(`collection.${slug}.title`, richTags)}</h1>
            <p className="lead">{t(`collection.${slug}.lead`)}</p>
          </div>
          <div className="shop-switch">
            {CATEGORY_ORDER.map((s) => (
              <Link key={s} href={`/${s}`} className={s === slug ? 'active' : undefined}>
                {t(CATEGORIES[s].nameKey)}
              </Link>
            ))}
          </div>
        </div>
      </section>
      <div className="shop-hint">
        <span className="ic"><Icon name="check" /></span>
        <p>{t.rich('collection.hint', richTags)}</p>
      </div>
      <Gallery products={products} />
    </>
  );
}
```
> `collection.hint` contains `<b>` tags (R1) — handled by `richTags.b`.

- [ ] **Step 2: Add `generateMetadata` to each collection page**

For each of the seven pages, add (example for `kubki/page.tsx`):
```tsx
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return { title: t('title.kubki') };
}
```
Map each page to its `title.*` key: kubki→`title.kubki`, wazony→`title.wazony`, wazony-duze→`title.wazonyDuze`, talerzyki→`title.talerzyki`, talerze-duze→`title.talerzeDuze`, duze-michy→`title.duzeMichy`, miski-falowane→`title.miskiFalowane`. Keep the existing `<CollectionScreen slug="…" />` body.

- [ ] **Step 3: Verify all seven collections build in three locales**

Run: `npm run build`
Expected: succeeds; `collection.*` keys resolve for every slug.

- [ ] **Step 4: Commit**

```bash
git add src/components/shop/CollectionScreen.tsx "src/app/[locale]/kubki/page.tsx" "src/app/[locale]/wazony/page.tsx" "src/app/[locale]/wazony-duze/page.tsx" "src/app/[locale]/talerzyki/page.tsx" "src/app/[locale]/talerze-duze/page.tsx" "src/app/[locale]/duze-michy/page.tsx" "src/app/[locale]/miski-falowane/page.tsx"
git commit -m "feat(collections): translated collection screen + metadata"
```

---

## Task 7: Cart + checkout — CartView and the koszyk page

**Files:**
- Modify: `src/components/shop/CartView.tsx`
- Modify: `src/app/[locale]/koszyk/page.tsx` (sim banner + `generateMetadata`)

Reference: shop.js `renderCart` (714–788), `shipOpt` (783–788), `checkout` (790–811). Behaviour: empty state; item rows; summary with two shipping options (kurier €18 / odbior gratis) persisted to `sessionStorage('acc_ship')`; delivery line; total; checkout → confirmation screen with random order number; clears cart on confirm.

- [ ] **Step 1: Implement CartView (client component)**

Rewrite `CartView.tsx`. Use `useCart` (ids, remove, clear), `getProductById` + `CATEGORIES`, `useTranslations`, `euro`, local `useState` for `ship` (init from `sessionStorage`) and a `done` flag (confirmation). Key pieces:
- Empty: `cart.emptyH` (rich, has `<em>`), `cart.emptyP`, then 7 ghost buttons (`cart.seeMugs`…`cart.seeWavybowls`) linking to each collection + a primary to `/kubki`.
- Rows: per id → thumb (link to `/${category}`), `` `${name} Nº ${num}` `` (h4), meta `` `${name} ${t('cart.oneoff')}` ``, price, remove button (`cart.remove` + trash icon).
- Head: eyebrow `cart.eyebrow`; `<h1>{t('cart.label')} <em>—</em> {n} {t('cart.word',{count:n})}</h1>`.
- Summary: `cart.summary`; pieces row `` `${t('cart.pieces')} (${n})` `` + `euro(subtotal)`; two `ship-opt` blocks via a helper (titles/desc/price from `ship.*`, `sel` class when active, click sets ship + persists); delivery row (`cart.delivery` → `euro(18)` or `cart.free`); total row (`cart.total` → `euro(subtotal + shipCost)`); checkout button (`cart.checkout` + arrow); fineprint `cart.fineprint` (rich, `<br/>`).
- Checkout → confirmation: seal (check icon), `confirm.eyebrow`, `confirm.h` (rich), `confirm.p1`, a line built from `confirm.order` + `<b>{n} {t('confirm.word',{count:n})}</b>` + `confirm.worth` + `<b>{euro(total)}</b>` + `confirm.tail`, `` `${t('confirm.orderno')} ACC-${random}` ``, buttons `confirm.back`→`/`, `confirm.more`→`/kubki`. On mount of confirmation, call `clear()`.

Shipping helper signature (mirror `shipOpt`):
```tsx
function ShipOption({ id, active, onPick, title, desc, price }: {...}) { /* .ship-opt markup */ }
```
Generate the random order number client-side once (e.g. `useState(() => 'ACC-' + (1000 + Math.floor(Math.random()*9000)))`). Subtotal = `ids.reduce((s,id)=>s+(getProductById(id)?.price ?? 0),0)`.

- [ ] **Step 2: koszyk page — sim banner + metadata**

Reference `design/Koszyk.html`. In `src/app/[locale]/koszyk/page.tsx`: render the `.sim-banner` (info icon + `t('cart.simBanner')`) above `<main id="cart-root"><CartView /></main>`-equivalent, and add `generateMetadata` → `title.koszyk`. The page is a server component that renders the client `CartView`; the sim-banner text needs `getTranslations`.

- [ ] **Step 3: Verify build + cart key resolution**

Run: `npm run build`
Expected: succeeds; `cart.*`, `ship.*`, `confirm.*` resolve.

- [ ] **Step 4: Commit**

```bash
git add src/components/shop/CartView.tsx "src/app/[locale]/koszyk/page.tsx"
git commit -m "feat(cart): item rows, shipping, simulated checkout + confirmation"
```

---

## Task 8: Home page

**Files:**
- Modify: `src/app/[locale]/page.tsx`
- Use: `src/components/ui/Marquee.tsx`, `SectionHead.tsx` (already built)

Reference: `design/index.html`. Sections: hero, marquee, collections grid (7 cards), studio story, "how it works" (craft), contact band. Server component + `getTranslations` + `t.rich` (richTags) for every headline with `<em>`.

- [ ] **Step 1: Build the collection-card cover map**

Add a local constant mapping each slug to its home cover image (from `design/index.html`):
```tsx
const COVER: Record<CategorySlug, string> = {
  kubki: '/uploads/kubek-12.png',
  wazony: '/uploads/waza-mala-3.png',
  'wazony-duze': '/uploads/waza-duza-7.png',
  talerzyki: '/uploads/talerz-maly-2.png',
  'talerze-duze': '/uploads/talerz-duzy-1.png',
  'duze-michy': '/uploads/duza-micha-1.png',
  'miski-falowane': '/uploads/miski-falowane-9.png',
};
```

- [ ] **Step 2: Implement the page**

Translate `design/index.html` to JSX:
- **Hero** (`.hero` → `.hero-inner` → `.hero-copy` + `.hero-art`): eyebrow `home.heroEyebrow`; `<h1 className="hero-title">{t.rich('home.heroTitle', richTags)}</h1>`; sub `home.heroSub`; actions: primary `/kubki` (`home.heroCta1` + arrow), ghost `/wazony` (`home.heroCta2`); art `<img src="/uploads/kubek-2.png">` + `.hero-art-meta` (`home.heroMetaName`, `home.heroMetaDesc`, `€ 22`).
- **Marquee**: `<Marquee items={t.raw('home.marquee') as string[]} />`.
- **Collections** (`.section.collections`): `SectionHead` eyebrow `home.colEyebrow` + title `t.rich('home.colTitle', richTags)`, aside `<p>` `home.colLead`. Grid: `CATEGORY_ORDER.map(slug => <Link className="collection" href={`/${slug}`}>`) with `<img src={COVER[slug]}>`, `.shade`, `.col-content` → `.num` = `t(`home.card.${singularKey}.num`)`, `<h3>` = `t(CATEGORIES[slug].nameKey)`, `<p>` = `t(`home.card.${singularKey}.desc`)`, `.col-cta` = `t(`home.card.${singularKey}.cta`)` + arrow. (singularKey via `CATEGORIES[slug].singularKey`.)
- **Studio story** (`.story`): art `<img src="/uploads/waza-mala-1.png">` + `<span className="signature">Anna</span>`; text: eyebrow `home.storyEyebrow`, `<h2 className="section-title">{t.rich('home.storyTitle', richTags)}</h2>`, three `<p>` (`home.storyP1/2/3`), actions primary `/kubki` (`home.storyCta1`+arrow) + ghost `/kontakt` (`home.storyCta2`).
- **Craft** (`.section.craft` id="jak"): SectionHead `home.craftEyebrow` + `t.rich('home.craftTitle', richTags)`; three `.craft-item` with `.num` 01/02/03, `<h4>{t.rich('home.craft1H', richTags)}</h4>`, `<p>{t('home.craft1P')}</p>` (and 2/3).
- **Contact band** (`.section.contact` id="kontakt"): eyebrow `home.ctEyebrow`, `<h3>{t.rich('home.ctH', richTags)}</h3>`, `<p>{t('home.ctP')}</p>`, primary `mailto:hej@annaciok.pl` (`home.ctBtn`+arrow); `.contact-list` four `.contact-row` (`home.ctLEmail`→`hej@annaciok.pl`, `home.ctLIg`→`home.ctVIg`, `home.ctLStudio`→`home.ctVStudio`, `home.ctLShip`→`home.ctVShip`).

Add `generateMetadata` → `title.home`. Keep `setRequestLocale(locale)`.

> Note: `fade-in` classes from the design drive an IntersectionObserver in shop.js that doesn't exist here. Either omit `fade-in` (content shows immediately) or keep the class as a no-op. **Omit** `fade-in` to avoid invisible content (the CSS may start them at opacity 0). Verify against `site.css` `.fade-in` rule — if it sets `opacity:0` without a `.visible` toggler, do **not** emit the class.

- [ ] **Step 3: Verify build + visual check**

Run: `npm run build`
Expected: succeeds; all `home.*` keys resolve.

- [ ] **Step 4: Commit**

```bash
git add "src/app/[locale]/page.tsx"
git commit -m "feat(home): hero, collections, story, craft, contact band"
```

---

## Task 9: Studio page (`/o-studiu`)

**Files:**
- Modify: `src/app/[locale]/o-studiu/page.tsx`

Reference: `design/O-studiu.html`. Sections: page-head, history story, facts grid (4), process (craft, id="proces"), CTA band. Server component, `getTranslations`, `t.rich` for `<em>`/`<strong>` headlines and `fact*V` values (which contain `<em>`).

- [ ] **Step 1: Implement the page**

- **page-head**: eyebrow `studio.eyebrow`, `<h1>{t.rich('studio.h1', richTags)}</h1>`, `<p className="lead">{t('studio.lead')}</p>`.
- **Story** (`.story`): `<img src="/uploads/waza-mala-1.png">` + signature "Anna"; eyebrow `studio.storyEyebrow`, `<h2>{t.rich('studio.storyH', richTags)}</h2>`, three `<p>` `studio.storyP1/2/3`.
- **Facts** (`.section.facts`): SectionHead `studio.factsEyebrow` + `t.rich('studio.factsH', richTags)`; `.facts-grid` four `.fact`: `.k`=`studio.fact1K`, `.v`=`t.rich('studio.fact1V', richTags)` (contains `<em>°C</em>` etc.), `.d`=`studio.fact1D` (×4).
- **Process** (`.section.craft` id="proces"): SectionHead `studio.procEyebrow` + `t.rich('studio.procH', richTags)`; three `.craft-item` 01/02/03 with `t.rich('studio.p1H', richTags)` + `t('studio.p1P')` (×3).
- **CTA band** (`.section.cta-band`): `<h2>{t.rich('studio.ctaH', richTags)}</h2>`, `<p>{t('studio.ctaP')}</p>`, primary `/kubki` (`studio.ctaB1`+arrow) + ghost `/wazony` (`studio.ctaB2`).

Add `generateMetadata` → `title.studio`. Apply the same `fade-in` caution as Task 8.

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: succeeds; `studio.*` keys resolve.

- [ ] **Step 3: Commit**

```bash
git add "src/app/[locale]/o-studiu/page.tsx"
git commit -m "feat(studio): about page — story, facts, process, CTA"
```

---

## Task 10: Contact page (`/kontakt`)

**Files:**
- Create: `src/components/shop/ContactForm.tsx` (client — submit toggles sent state)
- Modify: `src/app/[locale]/kontakt/page.tsx`

Reference: `design/Kontakt.html` + shop.js `renderContactForm` (814–822). The form does not send; on submit it reveals the `.form-sent` panel (toggle `sent` class on the form) and scrolls to top.

- [ ] **Step 1: Create ContactForm (client component)**

```tsx
'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@/components/ui/Icon';
import { richTags } from '@/components/ui/richTags';

export function ContactForm() {
  const t = useTranslations();
  const [sent, setSent] = useState(false);
  return (
    <form
      className={`contact-form${sent ? ' sent' : ''}`}
      onSubmit={(e) => { e.preventDefault(); setSent(true); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
    >
      {/* .form-fields: name, email, topic <select> (topic1..5), message, submit (k_submit + arrow), note (k_note rich <br/>) */}
      {/* .form-sent: .seal check icon, <h3>{t.rich('contact.sentH', richTags)}</h3>, <p>{t('contact.sentP')}</p> */}
    </form>
  );
}
```
Fill fields per `design/Kontakt.html` lines 22–52: labels `contact.fName/fEmail/fTopic/fMsg`, placeholders `contact.fNamePh/fEmailPh/fMsgPh`, options `contact.topic1..topic5`, submit `contact.submit`, note `contact.note` (rich, `<br/>`).

- [ ] **Step 2: Implement the page**

`src/app/[locale]/kontakt/page.tsx` (server): page-head (eyebrow `contact.eyebrow`, `<h1>{t.rich('contact.h1', richTags)}</h1>`, lead `contact.lead`); then `.contact-page` containing `<ContactForm />` and `<aside className="contact-side">` (h3 `contact.sideH` + `.contact-list` rows: `contact.lEmail`→`hej@annaciok.pl`, `contact.lIg`→`contact.vIg`, `contact.lStudio`→`contact.vStudio`, `contact.lShip`→`contact.vShip`, `contact.lReply`→`contact.vReply`). Add `generateMetadata` → `title.kontakt`.

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: succeeds; `contact.*` keys resolve.

- [ ] **Step 4: Commit**

```bash
git add src/components/shop/ContactForm.tsx "src/app/[locale]/kontakt/page.tsx"
git commit -m "feat(contact): form with simulated sent state + contact details"
```

---

## Task 11: Prose / legal pages (dostawa-i-zwroty, regulamin, polityka-prywatnosci)

**Files:**
- Modify: `src/app/[locale]/dostawa-i-zwroty/page.tsx`
- Modify: `src/app/[locale]/regulamin/page.tsx`
- Modify: `src/app/[locale]/polityka-prywatnosci/page.tsx`

Reference: `design/Dostawa-i-zwroty.html`, `Regulamin.html`, `Polityka-prywatnosci.html`. Shared structure: `.page-head` + `.prose-wrap` (`.prose-toc` nav with `.toc-label`, `<ul>` of anchor links, `.updated`) + `.prose` (optional `.note`, then `<section id>` blocks with `<h2>` + `<p>`/`<ul class="bullets">`). Some bodies contain inline links (R2) and `<strong>` (R1). Render each page directly (no shared abstraction — the three differ enough that inline JSX is clearer).

- [ ] **Step 1: Shipping page (`/dostawa-i-zwroty`)**

Translate `design/Dostawa-i-zwroty.html`:
- page-head: `shipping.eyebrow`, `t.rich('shipping.h1', richTags)`, `shipping.lead`.
- toc: `.toc-label`=`shipping.toc`; `<li><a href="#wysylka">{t('shipping.toc1')}</a></li>` … `#czas`/toc2, `#pakowanie`/toc3, `#odbior`/toc4, `#zwroty`/toc5, `#uszkodzenia`/toc6; `.updated`=`t.rich('shipping.updated', richTags)` (`<br/>`).
- prose sections: `#wysylka` (h2 `shipping.s1H`, p `t.rich('shipping.s1P', richTags)` (has `<strong>`), `<ul class="bullets">` li `shipping.s1Li1/2/3`); `#czas` (`shipping.s2H`, `t.rich('shipping.s2P', richTags)`, `.note`>p `shipping.s2Note`); `#pakowanie` (`shipping.s3H`, `shipping.s3P`); `#odbior` (`shipping.s4H`, `shipping.s4P`); `#zwroty` (`shipping.s5H`, `t.rich('shipping.s5P', { ...richTags, link: mailtoLink })` (has `<strong>` + mailto `<link>`), bullets `s5Li1/2/3`); `#uszkodzenia` (`shipping.s6H`, `shipping.s6P`).
- `generateMetadata` → `title.dostawa`.
where `mailtoLink = (c) => <a className="inline" href="mailto:hej@annaciok.pl">{c}</a>`.

- [ ] **Step 2: Terms page (`/regulamin`)**

Translate `design/Regulamin.html`:
- page-head: `terms.eyebrow`, `t.rich('terms.h1', richTags)`, `terms.lead`.
- toc: `terms.toc` + `terms.toc1..toc7` → anchors `#ogolne`,`#zamowienia`,`#ceny`,`#realizacja`,`#odstapienie`,`#reklamacje`,`#postanowienia`; `.updated` `t.rich('terms.updated', richTags)`.
- prose: leading `.note`>p `terms.protoNote`; `#ogolne` (`terms.s1H`, `t.rich('terms.s1P1', { ...richTags, link: mailtoLink })` (mailto), p `terms.s1P2`); `#zamowienia` (`terms.s2H`, `terms.s2P`, bullets `s2Li1/2`); `#ceny` (`terms.s3H`, `terms.s3P`); `#realizacja` (`terms.s4H`, `t.rich('terms.s4P', { ...richTags, link: dostawaLink })` (internal link)); `#odstapienie` (`terms.s5H`, `terms.s5P`); `#reklamacje` (`terms.s6H`, `terms.s6P`); `#postanowienia` (`terms.s7H`, `terms.s7P`).
- `generateMetadata` → `title.regulamin`.
where `dostawaLink = (c) => <Link className="inline" href="/dostawa-i-zwroty">{c}</Link>`.

- [ ] **Step 3: Privacy page (`/polityka-prywatnosci`)**

Translate `design/Polityka-prywatnosci.html`:
- page-head: `privacy.eyebrow`, `t.rich('privacy.h1', richTags)`, `privacy.lead`.
- toc: `privacy.toc` + `privacy.toc1..toc6` → anchors `#administrator`,`#dane`,`#cel`,`#czas`,`#cookies`,`#prawa`; `.updated` rich.
- prose: leading `.note`>p `privacy.protoNote`; `#administrator` (`privacy.s1H`, `t.rich('privacy.s1P', { ...richTags, link: mailtoLink })`); `#dane` (`privacy.s2H`, `<ul class="bullets">` `s2Li1/2/3`, then p `privacy.s2P`); `#cel` (`privacy.s3H`, `privacy.s3P`); `#czas` (`privacy.s4H`, `privacy.s4P`); `#cookies` (`privacy.s5H`, `privacy.s5P`); `#prawa` (`privacy.s6H`, `privacy.s6P`).
- `generateMetadata` → `title.polityka`.

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: succeeds; `shipping.*`, `terms.*`, `privacy.*` keys resolve in all three locales.

- [ ] **Step 5: Commit**

```bash
git add "src/app/[locale]/dostawa-i-zwroty/page.tsx" "src/app/[locale]/regulamin/page.tsx" "src/app/[locale]/polityka-prywatnosci/page.tsx"
git commit -m "feat(prose): shipping, terms and privacy pages"
```

---

## Task 12: Product images → `public/uploads/`

**Files:**
- Create: `public/uploads/*.png` (88 product images + nothing else)

The 88 PNGs referenced by `getProducts()` and the home covers/hero/story live in `design/uploads/`. Copy **only the product PNGs** (not the fonts/`Colors.pdf`/`Logotype.png`, which are already in `public/`).

- [ ] **Step 1: Copy the product images**

Run (PowerShell):
```powershell
New-Item -ItemType Directory -Force public/uploads | Out-Null
Get-ChildItem design/uploads -Filter *.png |
  Where-Object { $_.Name -match '^(kubek|waza-mala|waza-duza|talerz-maly|talerz-duzy|duza-micha|miski-falowane)-\d+\.png$' } |
  Copy-Item -Destination public/uploads
(Get-ChildItem public/uploads -Filter *.png).Count
```
Expected: `88`.

- [ ] **Step 2: Verify every product image path exists on disk**

Run:
```bash
node -e "
const {getProducts}=require('./src/lib/products.ts');" 2>/dev/null || node --input-type=module -e "
import fs from 'node:fs';
const dir='public/uploads';
const have=new Set(fs.readdirSync(dir));
const covers=['kubek-12','waza-mala-3','waza-duza-7','talerz-maly-2','talerz-duzy-1','duza-micha-1','miski-falowane-9','kubek-2','waza-mala-1'].map(n=>n+'.png');
const missingCovers=covers.filter(c=>!have.has(c));
console.log('files:',have.size,'missing covers/hero:',missingCovers);
"
```
Expected: `files: 88` and `missing covers/hero: []`. (The covers/hero/story images are a subset of the 88; confirm they copied.)

- [ ] **Step 3: Decide on git tracking of images**

> **Note (flag to user):** 88 PNGs at 3–5 MB each ≈ ~300 MB. Committing them bloats the repo permanently. Options: (a) commit as-is; (b) add `public/uploads/` to `.gitignore` and document a copy step; (c) optimize to WebP via a `sharp` script (separate follow-up — would change `getProducts` extensions to `.webp`). Default for this task: **commit as-is** unless the user opts otherwise. If ignoring instead, add `public/uploads/` to `.gitignore` and skip the `git add` below.

- [ ] **Step 4: Commit**

```bash
git add public/uploads
git commit -m "assets: add 88 product images"
```

---

## Task 13: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Lint**

Run: `npm run lint`
Expected: no errors (warnings acceptable only if pre-existing).

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Unit tests**

Run: `npm test`
Expected: PASS (products + any format tests).

- [ ] **Step 4: Production build (static-prerenders every route × locale)**

Run: `npm run build`
Expected: succeeds with no "missing message" / "insufficient plural" / type errors. This is the strongest gate — it renders all 14 routes × 3 locales at build time, so any unresolved i18n key surfaces here.

- [ ] **Step 5: Manual preview pass (use the `run` skill or `npm run dev`)**

Walk every surface in **all three locales** (switch via the header pill):
- Home: hero art + meta, marquee scrolls, 7 collection cards with correct covers, story signature, craft steps, contact band.
- Each collection: head copy + Nº range, switcher highlights active, hint, tiles show name/Nº/price, sold pieces show the sold tag and are not selectable.
- Tile select toggles the selection bar (pluralized count + total); clear works; "go to checkout" navigates.
- Lightbox: open from a tile, prev/next paging, eyebrow/name/note/specs/price, add↔in-cart toggle, esc/scrim close.
- Cart: empty state buttons; with items → rows, remove, shipping toggle (kurier €18 ↔ odbior gratis) updates delivery + total; checkout → confirmation with order number; cart clears.
- Studio, Contact (submit → sent panel), Shipping/Terms/Privacy (TOC anchors jump, inline links work).
- Header/Footer links + cart badge count persist across navigation and reload (localStorage).

- [ ] **Step 6: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "fix: content-phase verification adjustments"
```

---

## Self-review (performed against the spec)

- **Spec coverage:** Every content-phase deliverable from `README.md` is covered — page/component markup (Tasks 4–11), i18n catalogs PL/EN/ES (Task 2), `getProducts()` from shop.js (Task 1), product images to `public/uploads/` (Task 12), trilingual product descriptions (Task 2 `notes`). All 14 routes (home, 7 collections, koszyk, o-studiu, kontakt, 3 legal) have content + metadata.
- **Type consistency:** `noteIndex` (added to `Product` in Task 1) is consumed in Tasks 5/—; `singularKey` (added to `Category` in Task 1) is consumed in Tasks 5/6/8; `richTags` (Task 3) is consumed in Tasks 4–11; `notes.<route-slug>` (Task 2, R8) matches the `t.raw(\`notes.${product.category}\`)` access in Task 5. Catalog namespaces in Task 2 match every `t(...)`/`t.rich(...)` key referenced in Tasks 4–11.
- **Known decision flagged:** image repo-size trade-off (Task 12 Step 3) — left to the user; default is commit-as-is.
- **Caveat to verify during execution:** whether the scaffold's bare `<NextIntlClientProvider>` in `layout.tsx` auto-inherits messages for client components (next-intl 4 feature). If client components throw "No messages were configured", pass `messages={await getMessages()}` to the provider — single-line fix, verified by Task 5 Step 4 build.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-02-content-phase.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
