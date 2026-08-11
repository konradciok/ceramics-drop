> **Archived 2026-08-11 — shipped.** Implemented and merged as PR #237 (`97a17f5`). Current feature state lives in `docs/STATUS.md` (Print PDP sections row); architecture in `AGENTS.md` (CMS content layer). Kept for rationale only.

# Print PDP — Admin-Managed Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the fine-art-print PDP with three admin-managed info accordions, an "About the Artist" band, and an expandable product note — content edited in the existing lightweight CMS, with `messages/*.json` as fallback.

**Architecture:** One new CMS document `page:print-pdp` (fixed zod schema, per-locale versioned payloads) rides the existing draft→preview→publish pipeline. The PDP reads it via a new `getPrintPdpContent()` helper (preview > published > messages fallback) and renders three new presentational components. The admin gets a second fixed-fields editor variant next to the existing notes editor.

**Tech Stack:** Next.js 16 App Router (server components), zod, Supabase (`cms_documents`/`cms_document_versions` — no new tables, no migration), next-intl, vitest, plain CSS with tokens.

**Spec:** `docs/archive/2026-08-10-print-pdp-sections-design.md`

## Global Constraints

- Build stays `next build --webpack` — never Turbopack (breaks OpenNext/Workers).
- No new DB tables or migrations — the CMS tables already exist.
- Plain CSS in `src/styles/site.css` with `--c-*`/`--f-*`/`--r-*` tokens; no CSS-in-JS.
- Native `<img>` + `srcSet()` from `src/lib/images.ts` — never `next/image`.
- Server components by default; `'use client'` only where state/browser APIs are needed.
- All four locales (`pl`, `en`, `es`, `de`) get message keys in the same commit — edit all four `messages/*.json` directly (Notion sync is PL-only).
- Purchase behaviour (gallery, configurator, pricing, More Prints) must not change.
- Conventional Commits (`feat:`/`fix:`/`docs:` …).
- **Local `.env.local`/`.dev.vars` point at the PRODUCTION Supabase project.** During verification never *publish* the print-pdp document from a local session — draft + preview only.
- Windows note: `npm run test` has 4 known local-only vitest failures (path/timing). Diff failures against `main` before blaming your change; per-file `npx vitest run <file>` on the files you touch must pass cleanly.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/cms/types.ts` (modify) | `PRINT_PDP_SLUG` const + `PrintPdpPayload` type |
| `src/lib/cms/schemas.ts` (modify) | `printPdpSchema` (empty-allowed plain text) + `validateCmsPayload` case |
| `src/lib/cms/schemas.test.ts` (modify) | schema acceptance/rejection tests |
| `src/lib/cms/print-pdp.ts` (create) | fallback builder, `splitParagraphs`, `getPrintPdpContent` read helper |
| `src/lib/cms/print-pdp.test.ts` (create) | fallback + paragraph-split tests |
| `messages/{pl,en,es,de}.json` (modify) | `printPdp.*` UI labels + fallback copy |
| `src/lib/editorial-images.ts` (modify) | `PRINT_PDP_ARTIST_IMAGE` export |
| `src/components/shop/ExpandableText.tsx` (create) | client island: line-clamp + read-more toggle |
| `src/components/shop/PdpAccordions.tsx` (create) | server: native `<details>` stack, hides empty sections |
| `src/components/shop/AboutArtistSection.tsx` (create) | server: full-width artist band, hidden when bio empty |
| `src/styles/site.css` (modify) | `.pdp-accordions`, `.about-artist`, `.x-text` styles |
| `src/components/shop/PrintProductScreen.tsx` (modify) | swap spec block → accordions, note → ExpandableText, add artist band |
| `src/app/[locale]/(pdp)/[slug]/[id]/page.tsx` (modify) | fetch print-pdp content in the print branch |
| `src/lib/admin/content.ts` (modify) | generalise registry to `EDITABLE_DOCUMENTS`, kind-aware items/default payloads/summaries |
| `src/app/admin/content/[kind]/[slug]/editor-shared.ts` (create) | shared `postJson` + `FieldErrors` for both editors |
| `src/app/admin/content/[kind]/[slug]/PrintPdpEditor.tsx` (create) | fixed-fields editor (artist + 3 accordions) |
| `src/app/admin/content/[kind]/[slug]/ContentEditor.tsx` (modify) | import shared `postJson` (extraction only) |
| `src/app/admin/content/[kind]/[slug]/page.tsx` (modify) | pick editor variant by kind |
| `src/app/api/admin/content/preview/route.ts` (modify) | preview path for `page:print-pdp` (+ fix stale `fap01` path) |

Branch: create `feat/print-pdp-sections` from current HEAD before Task 1:

```bash
git checkout -b feat/print-pdp-sections
```

---

### Task 1: CMS payload type, schema, and validation tests

**Files:**
- Modify: `src/lib/cms/types.ts`
- Modify: `src/lib/cms/schemas.ts`
- Test: `src/lib/cms/schemas.test.ts`

**Interfaces:**
- Produces: `PRINT_PDP_SLUG = 'print-pdp'` and `type PrintPdpPayload` (from `@/lib/cms/types`); `printPdpSchema` and a `validateCmsPayload('page', 'print-pdp', payload)` path (from `@/lib/cms/schemas`). All later tasks import these exact names.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/cms/schemas.test.ts` (add `printPdpSchema` and `validateCmsPayload` to the existing import from `./schemas`):

```ts
describe('CMS print PDP schema', () => {
  const full = {
    artist: { name: 'Anna Ciok', bio: 'Bio artystki.' },
    accordions: { productDetails: 'Papier EMA.', framing: 'Rama drewniana.', shipping: 'Prodigi 5-10 dni.' },
  };

  it('accepts a fully populated payload', () => {
    expect(() => printPdpSchema.parse(full)).not.toThrow();
  });

  it('accepts empty fields (empty = section disabled, unlike other CMS schemas)', () => {
    const empty = {
      artist: { name: '', bio: '' },
      accordions: { productDetails: '', framing: '', shipping: '' },
    };
    expect(printPdpSchema.parse(empty).artist.bio).toBe('');
  });

  it('trims whitespace-only fields to empty', () => {
    expect(printPdpSchema.parse({ ...full, artist: { name: '  ', bio: ' x ' } }).artist).toEqual({ name: '', bio: 'x' });
  });

  it('rejects markup in any field', () => {
    expect(() => printPdpSchema.parse({ ...full, accordions: { ...full.accordions, framing: '<b>rama</b>' } }))
      .toThrow('To pole obsługuje tylko zwykły tekst');
  });

  it('is reachable through validateCmsPayload under page:print-pdp', () => {
    expect(() => validateCmsPayload('page', 'print-pdp', full)).not.toThrow();
    expect(() => validateCmsPayload('page', 'unknown-page', full)).toThrow();
  });

  it('rejects a payload missing the accordions object', () => {
    expect(() => printPdpSchema.parse({ artist: full.artist })).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/cms/schemas.test.ts`
Expected: FAIL — `printPdpSchema` is not exported.

- [ ] **Step 3: Add the type and slug const**

In `src/lib/cms/types.ts`, after the `CollectionCopyPayload` type:

```ts
export const PRINT_PDP_SLUG = 'print-pdp';

/** Fixed-schema content for the fine-art-print PDP sections. Empty string =
    section intentionally disabled by the admin (deliberate departure from the
    min(1) rule other CMS schemas use). */
export type PrintPdpPayload = {
  artist: { name: string; bio: string };
  accordions: {
    productDetails: string;
    framing: string;
    shipping: string;
  };
};
```

And widen the union:

```ts
export type CmsPayload = ProductNotesPayload | CollectionCopyPayload | PrintPdpPayload | Record<string, unknown>;
```

- [ ] **Step 4: Add the schema and validation case**

In `src/lib/cms/schemas.ts`, import `PRINT_PDP_SLUG` (extend the existing `./types` import). Below `collectionCopySchema` add:

```ts
// Unlike plainText above, empty is legal here: publishing an empty field is
// how the admin disables a PDP section.
const optionalPlainText = z.string().trim().refine((value) => !/[<>]/.test(value), {
  message: 'To pole obsługuje tylko zwykły tekst',
});

export const printPdpSchema = z.object({
  artist: z.object({ name: optionalPlainText, bio: optionalPlainText }),
  accordions: z.object({
    productDetails: optionalPlainText,
    framing: optionalPlainText,
    shipping: optionalPlainText,
  }),
});
```

In `validateCmsPayload`, extend the `page` branch (before the `home` check):

```ts
    case 'page':
      if (slug === PRINT_PDP_SLUG) return printPdpSchema.parse(payload);
      if (slug === 'home') return homePageSchema.parse(payload);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/cms/schemas.test.ts`
Expected: PASS (all existing + 6 new).

- [ ] **Step 6: Commit**

```bash
git add src/lib/cms/types.ts src/lib/cms/schemas.ts src/lib/cms/schemas.test.ts
git commit -m "feat(prints): CMS payload schema for print PDP sections"
```

---

### Task 2: Message fallback keys (4 locales) + read helper

**Files:**
- Modify: `messages/pl.json`, `messages/en.json`, `messages/es.json`, `messages/de.json`
- Create: `src/lib/cms/print-pdp.ts`
- Test: `src/lib/cms/print-pdp.test.ts`

**Interfaces:**
- Consumes: `PRINT_PDP_SLUG`, `PrintPdpPayload` (Task 1); `LOCALE_MESSAGES` from `@/lib/cms/messages`; `getPublishedContent`/`getPreviewContent` from `@/lib/cms/server`.
- Produces: `fallbackPrintPdpPayload(locale: CmsLocale): PrintPdpPayload`, `splitParagraphs(text: string): string[]`, `getPrintPdpContent(locale: CmsLocale, previewToken?: string | null): Promise<PrintPdpPayload>` — all from `@/lib/cms/print-pdp`. Message keys `printPdp.*` (exact names below) used by Tasks 4–5.

- [ ] **Step 1: Add the `printPdp` namespace to all four message files**

Add as a new top-level key (alphabetical placement near `"print"`) in each file. The first six keys are UI chrome (headings/labels); the last five are the CMS fallback copy.

`messages/pl.json`:

```json
"printPdp": {
  "aboutArtistTitle": "O artystce",
  "readMore": "Czytaj więcej",
  "readLess": "Zwiń",
  "accordionProductDetailsTitle": "Szczegóły produktu",
  "accordionFramingTitle": "Oprawa i passe-partout",
  "accordionShippingTitle": "Wysyłka i zwroty",
  "artistName": "Anna Ciok",
  "artistBio": "Anna Ciok tworzy w Warszawie — maluje i projektuje ceramikę, a jej prace łączą odważny kolor z ręcznym gestem. Printy z tej kolekcji powstały na bazie jej oryginalnych obrazów i drukowane są w otwartej edycji na papierze archiwalnym.",
  "accordionProductDetails": "Fine Art print na papierze EMA 200 g/m² — matowym papierze o jakości archiwalnej. Edycja otwarta.\n\nPrzechowuj z dala od wilgoci i bezpośredniego słońca; ramę przecieraj suchą ściereczką.",
  "accordionFraming": "Każdy print jest dostępny bez oprawy albo w drewnianej ramie: czarnej, jasnobrązowej lub ciemnobrązowej. Wersje w ramie można zamówić z passe-partout, które dodaje pracy oddechu i głębi.",
  "accordionShipping": "Druk i wysyłkę realizuje nasz partner Prodigi w ciągu 5–10 dni roboczych. Printy wysyłamy na adres domowy w Unii Europejskiej i Wielkiej Brytanii — dostawa do paczkomatu nie jest dostępna. Szczegóły zwrotów znajdziesz na stronie Dostawa i zwroty."
}
```

`messages/en.json`:

```json
"printPdp": {
  "aboutArtistTitle": "About the artist",
  "readMore": "Read more",
  "readLess": "Show less",
  "accordionProductDetailsTitle": "Product details",
  "accordionFramingTitle": "Frame & passe-partout",
  "accordionShippingTitle": "Shipping & returns",
  "artistName": "Anna Ciok",
  "artistBio": "Anna Ciok is a Warsaw-based artist who paints and makes ceramics; her work pairs bold colour with a handmade gesture. The prints in this collection reproduce her original paintings and are printed in an open edition on archival paper.",
  "accordionProductDetails": "Fine Art print on EMA 200 g/m² paper — a matte, archival-quality stock. Open edition.\n\nKeep away from moisture and direct sunlight; wipe the frame with a dry cloth.",
  "accordionFraming": "Every print is available unframed or in a wooden frame: black, light brown or dark brown. Framed versions can be ordered with a passe-partout mount, which gives the work extra breathing room and depth.",
  "accordionShipping": "Prints are produced and shipped by our partner Prodigi within 5–10 working days. We ship to home addresses in the European Union and the United Kingdom — parcel-locker delivery is not available. See the Delivery & returns page for return details."
}
```

`messages/es.json`:

```json
"printPdp": {
  "aboutArtistTitle": "Sobre la artista",
  "readMore": "Leer más",
  "readLess": "Mostrar menos",
  "accordionProductDetailsTitle": "Detalles del producto",
  "accordionFramingTitle": "Marco y paspartú",
  "accordionShippingTitle": "Envío y devoluciones",
  "artistName": "Anna Ciok",
  "artistBio": "Anna Ciok es una artista afincada en Varsovia que pinta y crea cerámica; su obra combina el color audaz con el gesto hecho a mano. Las láminas de esta colección reproducen sus pinturas originales y se imprimen en edición abierta sobre papel de archivo.",
  "accordionProductDetails": "Lámina Fine Art sobre papel EMA de 200 g/m² — un papel mate de calidad de archivo. Edición abierta.\n\nMantener alejada de la humedad y de la luz solar directa; limpiar el marco con un paño seco.",
  "accordionFraming": "Cada lámina está disponible sin marco o con marco de madera: negro, marrón claro o marrón oscuro. Las versiones enmarcadas pueden pedirse con paspartú, que aporta aire y profundidad a la obra.",
  "accordionShipping": "Nuestro socio Prodigi produce y envía las láminas en un plazo de 5–10 días laborables. Enviamos a domicilios de la Unión Europea y el Reino Unido — la entrega en taquillas no está disponible. Consulta la página de Envíos y devoluciones para más detalles."
}
```

`messages/de.json`:

```json
"printPdp": {
  "aboutArtistTitle": "Über die Künstlerin",
  "readMore": "Mehr lesen",
  "readLess": "Weniger anzeigen",
  "accordionProductDetailsTitle": "Produktdetails",
  "accordionFramingTitle": "Rahmen & Passepartout",
  "accordionShippingTitle": "Versand & Rückgabe",
  "artistName": "Anna Ciok",
  "artistBio": "Anna Ciok ist eine in Warschau lebende Künstlerin, die malt und Keramik gestaltet; ihre Arbeiten verbinden kräftige Farben mit handwerklicher Geste. Die Drucke dieser Kollektion reproduzieren ihre Originalgemälde und werden in offener Edition auf Archivpapier gedruckt.",
  "accordionProductDetails": "Fine-Art-Druck auf EMA-Papier 200 g/m² — ein mattes Papier in Archivqualität. Offene Edition.\n\nVor Feuchtigkeit und direktem Sonnenlicht schützen; den Rahmen mit einem trockenen Tuch abwischen.",
  "accordionFraming": "Jeder Druck ist ungerahmt oder mit Holzrahmen erhältlich: schwarz, hellbraun oder dunkelbraun. Gerahmte Varianten können mit Passepartout bestellt werden, das dem Werk Raum und Tiefe gibt.",
  "accordionShipping": "Unser Partner Prodigi produziert und versendet die Drucke innerhalb von 5–10 Werktagen. Wir liefern an Hausadressen in der Europäischen Union und im Vereinigten Königreich — Paketautomaten-Lieferung ist nicht verfügbar. Details zur Rückgabe auf der Seite Versand & Rückgabe."
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/lib/cms/print-pdp.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CMS_LOCALES } from './types';
import { fallbackPrintPdpPayload, splitParagraphs } from './print-pdp';

describe('fallbackPrintPdpPayload', () => {
  it.each(CMS_LOCALES)('builds a complete non-empty payload for %s', (locale) => {
    const payload = fallbackPrintPdpPayload(locale);
    expect(payload.artist.name).toBe('Anna Ciok');
    expect(payload.artist.bio.length).toBeGreaterThan(20);
    expect(payload.accordions.productDetails.length).toBeGreaterThan(20);
    expect(payload.accordions.framing.length).toBeGreaterThan(20);
    expect(payload.accordions.shipping.length).toBeGreaterThan(20);
  });
});

describe('splitParagraphs', () => {
  it('splits on blank lines and trims', () => {
    expect(splitParagraphs('Pierwszy akapit.\n\n  Drugi akapit. ')).toEqual(['Pierwszy akapit.', 'Drugi akapit.']);
  });

  it('keeps single newlines inside one paragraph', () => {
    expect(splitParagraphs('linia 1\nlinia 2')).toEqual(['linia 1\nlinia 2']);
  });

  it('drops empty segments', () => {
    expect(splitParagraphs('\n\n a \n\n\n\n b \n\n')).toEqual(['a', 'b']);
    expect(splitParagraphs('')).toEqual([]);
    expect(splitParagraphs('   ')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/lib/cms/print-pdp.test.ts`
Expected: FAIL — module `./print-pdp` does not exist.

- [ ] **Step 4: Create `src/lib/cms/print-pdp.ts`**

```ts
import { getPublishedContent, getPreviewContent } from './server';
import { LOCALE_MESSAGES } from './messages';
import { PRINT_PDP_SLUG, type CmsLocale, type PrintPdpPayload } from './types';

/** Fallback copy from messages/*.json — used when no CMS document is published. */
export function fallbackPrintPdpPayload(locale: CmsLocale): PrintPdpPayload {
  const m = LOCALE_MESSAGES[locale].printPdp;
  return {
    artist: { name: m.artistName, bio: m.artistBio },
    accordions: {
      productDetails: m.accordionProductDetails,
      framing: m.accordionFraming,
      shipping: m.accordionShipping,
    },
  };
}

/** Blank-line-separated plain text → paragraph list (single \n stays inline). */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Print-PDP section content: preview draft (valid ?preview= token) > published
 * CMS payload > messages fallback. A published payload wins even when a field
 * is empty — an intentionally emptied field HIDES its section rather than
 * resurrecting fallback copy. Read errors fall back (never break the PDP).
 */
export async function getPrintPdpContent(
  locale: CmsLocale,
  previewToken?: string | null,
): Promise<PrintPdpPayload> {
  const preview = await getPreviewContent<PrintPdpPayload>(previewToken, {
    kind: 'page',
    slug: PRINT_PDP_SLUG,
    locale,
  });
  if (preview) return preview;

  const published = await getPublishedContent<PrintPdpPayload>('page', PRINT_PDP_SLUG, locale);
  return published ?? fallbackPrintPdpPayload(locale);
}
```

(`getPublishedContent`/`getPreviewContent` already swallow read errors and return `null` — no extra try/catch needed. They also run every payload through `validateCmsPayload`, so the returned object is schema-verified.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/cms/print-pdp.test.ts`
Expected: PASS. Also run `npx vitest run src/lib/cms/schemas.test.ts` — still PASS.

- [ ] **Step 6: Typecheck (messages type must include printPdp)**

Run: `npm run typecheck`
Expected: clean. (`LOCALE_MESSAGES` is typed from `messages/en.json`, so a missing/typo'd key in en.json fails here.)

- [ ] **Step 7: Commit**

```bash
git add messages/pl.json messages/en.json messages/es.json messages/de.json src/lib/cms/print-pdp.ts src/lib/cms/print-pdp.test.ts
git commit -m "feat(prints): print PDP fallback copy (4 locales) + CMS read helper"
```

---

### Task 3: Presentational components + CSS

**Files:**
- Create: `src/components/shop/ExpandableText.tsx`
- Create: `src/components/shop/PdpAccordions.tsx`
- Create: `src/components/shop/AboutArtistSection.tsx`
- Modify: `src/lib/editorial-images.ts`
- Modify: `src/styles/site.css`

**Interfaces:**
- Consumes: `splitParagraphs` (Task 2), `srcSet` from `@/lib/images`, `EditorialImage`/`EDITORIAL_IMAGES` from `@/lib/editorial-images`.
- Produces:
  - `ExpandableText({ text, lines?, moreLabel, lessLabel, className? })` — client island.
  - `PdpAccordions({ items: PdpAccordionItem[] })` with `type PdpAccordionItem = { key: string; title: string; body: string; extra?: ReactNode }` — renders nothing when every item is empty.
  - `AboutArtistSection({ title, name, bio, image })` — returns `null` when `bio` is blank.
  - `PRINT_PDP_ARTIST_IMAGE` from `@/lib/editorial-images`.

No unit tests: the repo tests `src/lib/**` logic only (vitest); components are verified by render checks in Task 6. The only logic here (`splitParagraphs`) is already tested in Task 2.

- [ ] **Step 1: Create `src/components/shop/ExpandableText.tsx`**

```tsx
'use client';

/* Line-clamped paragraph with a "read more/less" toggle. The toggle renders
   only when the text actually overflows the clamp (measured on mount), so
   short notes look exactly like the old static <p>. */
import { useLayoutEffect, useRef, useState } from 'react';

export function ExpandableText({
  text,
  lines = 4,
  moreLabel,
  lessLabel,
  className,
}: {
  text: string;
  lines?: number;
  moreLabel: string;
  lessLabel: string;
  className?: string;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [clamped, setClamped] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [text, lines]);

  return (
    <div className="x-text">
      <p
        ref={ref}
        className={className}
        style={
          expanded
            ? undefined
            : { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: lines, overflow: 'hidden' }
        }
      >
        {text}
      </p>
      {(clamped || expanded) && (
        <button type="button" className="x-text-toggle" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? lessLabel : moreLabel}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `src/components/shop/PdpAccordions.tsx`**

```tsx
/* Native <details>/<summary> accordion stack for PDP info sections — no JS,
   keyboard-accessible. Items with an empty body and no extra node are skipped
   entirely (an admin-emptied CMS field = section disabled). */
import type { ReactNode } from 'react';
import { splitParagraphs } from '@/lib/cms/print-pdp';

export type PdpAccordionItem = {
  key: string;
  title: string;
  body: string;
  /** Optional trailing node (e.g. per-design registry facts) rendered after the body. */
  extra?: ReactNode;
};

export function PdpAccordions({ items }: { items: PdpAccordionItem[] }) {
  const visible = items.filter((item) => item.body.trim() !== '' || item.extra);
  if (visible.length === 0) return null;
  return (
    <div className="pdp-accordions">
      {visible.map((item) => (
        <details key={item.key} className="pdp-acc">
          <summary>{item.title}</summary>
          <div className="pdp-acc-body">
            {splitParagraphs(item.body).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
            {item.extra}
          </div>
        </details>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Create `src/components/shop/AboutArtistSection.tsx`**

```tsx
/* Full-width "About the Artist" band (single global artist — Anna Ciok).
   Content comes from the print-pdp CMS document / messages fallback; an empty
   bio hides the whole section (no empty placeholders). */
import { srcSet } from '@/lib/images';
import { splitParagraphs } from '@/lib/cms/print-pdp';
import type { EditorialImage } from '@/lib/editorial-images';

export function AboutArtistSection({
  title,
  name,
  bio,
  image,
}: {
  title: string;
  name: string;
  bio: string;
  image: EditorialImage;
}) {
  if (!bio.trim()) return null;
  return (
    <section className="section about-artist">
      <div className="about-artist-inner">
        <div className="section-eyebrow">{title}</div>
        {name.trim() !== '' && <h2 className="section-title">{name}</h2>}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image.src}
          srcSet={srcSet(image.src)}
          sizes="(min-width:861px) 360px, 70vw"
          alt={name.trim() !== '' ? name : title}
          width={image.width}
          height={image.height}
          loading="lazy"
        />
        <div className="about-artist-bio">
          {splitParagraphs(bio).map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Add the artist image export**

In `src/lib/editorial-images.ts`, after `STUDIO_STORY_IMAGE`:

```ts
// Print PDP "About the Artist" band — portrait of Anna in the studio.
export const PRINT_PDP_ARTIST_IMAGE = EDITORIAL_IMAGES.aniaSunlight;
```

- [ ] **Step 5: Add CSS**

In `src/styles/site.css`, directly after the `.pdp-body .lb-specs { margin-top:auto; }` rule (~line 1220):

```css
/* ── PDP accordions (print info sections) ─────────────────── */
.pdp-accordions { border-top:1px solid var(--c-line); margin-bottom:24px; }
.pdp-body .pdp-accordions { margin-top:auto; }
.pdp-acc { border-bottom:1px solid var(--c-line); }
.pdp-acc summary {
  display:flex; justify-content:space-between; align-items:center; gap:12px;
  padding:14px 0; cursor:pointer; list-style:none;
  font-family:var(--f-cond); font-size:12px; letter-spacing:.16em; text-transform:uppercase;
}
.pdp-acc summary::-webkit-details-marker { display:none; }
.pdp-acc summary::after { content:'+'; font-size:15px; line-height:1; opacity:.55; flex:none; }
.pdp-acc[open] summary::after { content:'−'; }
.pdp-acc-body { padding:2px 0 16px; font-size:14.5px; line-height:1.65; opacity:.85; }
.pdp-acc-body p { margin:0 0 10px; }
.pdp-acc-body p:last-child { margin-bottom:0; }
.pdp-acc-facts { font-family:var(--f-cond); font-size:12.5px; letter-spacing:.06em; opacity:.75; }

/* ── Expandable text (PDP note "read more") ───────────────── */
.x-text { margin:0 0 22px; }
.x-text .pdp-note { margin-bottom:0; }
.x-text-toggle {
  margin-top:6px; padding:0; background:none; border:0; cursor:pointer;
  font:inherit; font-size:13px; text-decoration:underline; color:inherit; opacity:.7;
}
.x-text-toggle:hover { opacity:1; }

/* ── About the artist (print PDP band) ────────────────────── */
.about-artist-inner { max-width:640px; margin:0 auto; text-align:center; }
.about-artist .section-eyebrow { justify-content:center; }
.about-artist .section-title { margin-bottom:8px; }
.about-artist img { width:min(320px,70%); height:auto; display:block; margin:18px auto 24px; border-radius:var(--r-sharp); }
.about-artist-bio { text-align:left; font-size:15px; line-height:1.7; opacity:.85; }
.about-artist-bio p { margin:0 0 12px; }
.about-artist-bio p:last-child { margin-bottom:0; }
```

(`.section-eyebrow` is a flex row — verified at `src/styles/site.css:180` — so the `justify-content:center` override centers it correctly.)

- [ ] **Step 6: Lint + typecheck**

Run: `npm run lint && npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/components/shop/ExpandableText.tsx src/components/shop/PdpAccordions.tsx src/components/shop/AboutArtistSection.tsx src/lib/editorial-images.ts src/styles/site.css
git commit -m "feat(prints): PDP accordion, about-artist and expandable-text components"
```

---

### Task 4: Wire the PDP (page + PrintProductScreen)

**Files:**
- Modify: `src/app/[locale]/(pdp)/[slug]/[id]/page.tsx` (print branch, ~lines 90–122)
- Modify: `src/components/shop/PrintProductScreen.tsx`

**Interfaces:**
- Consumes: `getPrintPdpContent` (Task 2); `PdpAccordions`, `AboutArtistSection`, `ExpandableText`, `PRINT_PDP_ARTIST_IMAGE` (Task 3); `PrintPdpPayload` (Task 1).
- Produces: `PrintProductScreen` gains a required prop `content: PrintPdpPayload`. No other signature changes.

- [ ] **Step 1: Fetch content in the print branch of `page.tsx`**

Add the import:

```ts
import { getPrintPdpContent } from '@/lib/cms/print-pdp';
```

Extend the existing `Promise.all` in the `slug === PRINT_SLUG` branch:

```ts
    const [note, coverage, pricing, pdpContent] = await Promise.all([
      getProductNote(PRINT_SLUG, locale as Locale, design.id, preview),
      getPrintAssetCoverage(design.id).catch(() => null),
      getPrintPricingConfig(),
      getPrintPdpContent(locale as Locale, preview),
    ]);
```

and pass it through:

```tsx
        <PrintProductScreen design={design} noteOverride={note} usableVariantKeys={usableVariantKeys} pricing={pricing} content={pdpContent} />
```

(The same `?preview=` token previews either the notes document or the print-pdp document — `getPreviewContent` matches the token's kind/slug, so the non-matching reader falls through to published content.)

- [ ] **Step 2: Update `PrintProductScreen.tsx`**

Add imports:

```ts
import { PdpAccordions } from './PdpAccordions';
import { AboutArtistSection } from './AboutArtistSection';
import { ExpandableText } from './ExpandableText';
import { PRINT_PDP_ARTIST_IMAGE } from '@/lib/editorial-images';
import type { PrintPdpPayload } from '@/lib/cms/types';
```

Add the prop (JSDoc matches the pricing prop style):

```ts
  /** Print-PDP section content (accordions + artist), loaded once by the PDP page (getPrintPdpContent). */
  content: PrintPdpPayload;
```

Replace the note line in the `header` slot —

```tsx
                {note && <p className="pdp-note">{note}</p>}
```

becomes:

```tsx
                {note && (
                  <ExpandableText
                    className="pdp-note"
                    text={note}
                    lines={4}
                    moreLabel={t('printPdp.readMore')}
                    lessLabel={t('printPdp.readLess')}
                  />
                )}
```

Replace the whole `footer={<div className="lb-specs print-specs">…</div>}` block with:

```tsx
            footer={
              <PdpAccordions
                items={[
                  {
                    key: 'productDetails',
                    title: t('printPdp.accordionProductDetailsTitle'),
                    body: content.accordions.productDetails,
                    extra: <p className="pdp-acc-facts">{sizeLines}</p>,
                  },
                  {
                    key: 'framing',
                    title: t('printPdp.accordionFramingTitle'),
                    body: content.accordions.framing,
                  },
                  {
                    key: 'shipping',
                    title: t('printPdp.accordionShippingTitle'),
                    body: content.accordions.shipping,
                  },
                ]}
              />
            }
```

`sizeLines` (already computed above) keeps the per-design registry facts out of the CMS. The i18n keys `print.sectionDetails`, `print.technique`, `print.sectionEdition`, `print.editionOpen`, `print.sectionDelivery`, `print.deliveryNote`, `print.sectionCare`, `print.careNote` become unused by this screen — leave them in messages (still used as feed/SEO copy elsewhere? do NOT delete without a grep; deletion is out of scope).

After the closing `</section>` of the `pdp-more` block (still inside `<article className="pdp">`), add:

```tsx
      <AboutArtistSection
        title={t('printPdp.aboutArtistTitle')}
        name={content.artist.name}
        bio={content.artist.bio}
        image={PRINT_PDP_ARTIST_IMAGE}
      />
```

- [ ] **Step 3: Lint + typecheck + unit tests**

Run: `npm run lint && npm run typecheck && npx vitest run src/lib/cms/print-pdp.test.ts src/lib/cms/schemas.test.ts`
Expected: clean / PASS. (Typecheck will catch any missed `content` prop call site.)

- [ ] **Step 4: Smoke-render in dev**

Run: `npm run dev` and open `http://localhost:3000/fine-art-prints/fap005` (and `/en/fine-art-prints/fap005`).
Expected: PDP renders with three closed accordions under the configurator (fallback copy), size facts inside "Szczegóły produktu", About-the-artist band after "More prints", note unchanged (short notes show no toggle). Configurator + add-to-cart still work.

- [ ] **Step 5: Commit**

```bash
git add "src/app/[locale]/(pdp)/[slug]/[id]/page.tsx" src/components/shop/PrintProductScreen.tsx
git commit -m "feat(prints): render admin-managed sections on the print PDP"
```

---

### Task 5: Admin — registry, editor variant, preview path

**Files:**
- Modify: `src/lib/admin/content.ts`
- Create: `src/app/admin/content/[kind]/[slug]/editor-shared.ts`
- Create: `src/app/admin/content/[kind]/[slug]/PrintPdpEditor.tsx`
- Modify: `src/app/admin/content/[kind]/[slug]/ContentEditor.tsx`
- Modify: `src/app/admin/content/[kind]/[slug]/page.tsx`
- Modify: `src/app/api/admin/content/preview/route.ts`

**Interfaces:**
- Consumes: `PRINT_PDP_SLUG`, `PrintPdpPayload` (Task 1), `fallbackPrintPdpPayload` (Task 2).
- Produces: `EDITABLE_DOCUMENTS` (supersedes direct use of `PRODUCT_NOTE_DOCUMENTS` in `listContentSummaries`); `postJson`/`FieldErrors` from `./editor-shared`; `PrintPdpEditor({ state })`. The API routes (`draft`/`publish`/`revert`/`history`) need **no changes** — they are gated by `editableDocument()` + `validateCmsPayload()`, which this task extends.

- [ ] **Step 1: Generalise the document registry in `src/lib/admin/content.ts`**

Add imports: `fallbackPrintPdpPayload` from `@/lib/cms/print-pdp`, and `PRINT_PDP_SLUG` (extend the `@/lib/cms/types` import).

After the `PRODUCT_NOTE_DOCUMENTS` array, add:

```ts
export const PRINT_PDP_DOCUMENT: EditableContentDocument = {
  kind: 'page',
  slug: PRINT_PDP_SLUG,
  label: 'Print PDP — sekcje',
  publicPath: '/fine-art-prints',
};

/** Every document the admin CMS list/editor exposes. */
export const EDITABLE_DOCUMENTS: EditableContentDocument[] = [...PRODUCT_NOTE_DOCUMENTS, PRINT_PDP_DOCUMENT];
```

Point `editableDocument` at the new list:

```ts
export function editableDocument(kind: string, slug: string): EditableContentDocument | null {
  return EDITABLE_DOCUMENTS.find((doc) => doc.kind === kind && doc.slug === slug) ?? null;
}
```

Make `contentItems` safe for the fixed-fields document (first line of the function):

```ts
  if (slug === PRINT_PDP_SLUG) return [];
```

Make the default payload kind-aware. Replace the payload literals in `emptyLocaleState` and `localeState` with a helper, and thread `kind` through (both are only called from `getContentEditorState`, which has `kind` in scope):

```ts
function defaultPayload(kind: CmsDocumentKind, slug: string, locale: CmsLocale): CmsPayload {
  if (kind === 'page' && slug === PRINT_PDP_SLUG) return fallbackPrintPdpPayload(locale);
  return { notes: fallbackProductNotes(slug, locale) };
}

function emptyLocaleState(locale: CmsLocale, kind: CmsDocumentKind, slug: string): LocaleEditorState {
  return {
    locale,
    payload: defaultPayload(kind, slug, locale),
    latestDraft: null,
    published: null,
    versions: [],
  };
}

function localeState(locale: CmsLocale, kind: CmsDocumentKind, slug: string, versions: CmsVersionRow[]): LocaleEditorState {
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const latestDraft = sorted.find((v) => v.status === 'draft') ?? null;
  const published = sorted.find((v) => v.status === 'published') ?? null;
  return {
    locale,
    payload: latestDraft?.payload ?? published?.payload ?? defaultPayload(kind, slug, locale),
    latestDraft,
    published,
    versions: sorted,
  };
}
```

Update the two call sites in `getContentEditorState` accordingly (`localeState(locale, kind, slug, …)` / `emptyLocaleState(locale, kind, slug)`).

In `listContentSummaries`, widen the query and the mapped list:

```ts
    .in('kind', ['product_notes', 'page']);
```

(replacing `.eq('kind', 'product_notes')`), and map over `EDITABLE_DOCUMENTS` instead of `PRODUCT_NOTE_DOCUMENTS`.

- [ ] **Step 2: Extract shared editor fetch helper**

Create `src/app/admin/content/[kind]/[slug]/editor-shared.ts` with the exact `postJson`/`FieldErrors` currently inlined in `ContentEditor.tsx`:

```ts
export type FieldErrors = Record<string, string>;

export async function postJson(path: string, body: unknown) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    fields?: FieldErrors;
    version?: { version: number };
    path?: string;
    token?: string;
  };
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`) as Error & { fields?: FieldErrors };
    err.fields = data.fields;
    throw err;
  }
  return data;
}
```

In `ContentEditor.tsx`, delete the local `postJson` and `type FieldErrors` definitions and import both from `./editor-shared`. No behaviour change.

- [ ] **Step 3: Create `PrintPdpEditor.tsx`**

Fixed-fields variant of the editor — same locale tabs, same draft/preview/publish actions against the same generic API routes:

```tsx
'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { CMS_LOCALES, CmsLocale, PrintPdpPayload } from '@/lib/cms/types';
import type { ContentEditorState } from '@/lib/admin/content';
import { postJson, type FieldErrors } from './editor-shared';

const LOCALES = ['pl', 'en', 'es', 'de'] as const satisfies typeof CMS_LOCALES;

const FIELDS = [
  { path: 'artist.name' as const, label: 'Artystka — imię i nazwisko', rows: 1 },
  { path: 'artist.bio' as const, label: 'Artystka — bio (puste = sekcja ukryta)', rows: 5 },
  { path: 'accordions.productDetails' as const, label: 'Akordeon: szczegóły produktu (puste = ukryty)', rows: 5 },
  { path: 'accordions.framing' as const, label: 'Akordeon: oprawa i passe-partout (puste = ukryty)', rows: 5 },
  { path: 'accordions.shipping' as const, label: 'Akordeon: wysyłka i zwroty (puste = ukryty)', rows: 5 },
];

type FieldPath = (typeof FIELDS)[number]['path'];

function getField(payload: PrintPdpPayload, path: FieldPath): string {
  const [a, b] = path.split('.') as [keyof PrintPdpPayload, string];
  return ((payload[a] as Record<string, string>)[b] ?? '');
}

function setField(payload: PrintPdpPayload, path: FieldPath, value: string): PrintPdpPayload {
  const [a, b] = path.split('.') as [keyof PrintPdpPayload, string];
  return { ...payload, [a]: { ...(payload[a] as Record<string, string>), [b]: value } };
}

function asPayload(raw: unknown): PrintPdpPayload {
  const p = (raw ?? {}) as Partial<PrintPdpPayload>;
  return {
    artist: { name: p.artist?.name ?? '', bio: p.artist?.bio ?? '' },
    accordions: {
      productDetails: p.accordions?.productDetails ?? '',
      framing: p.accordions?.framing ?? '',
      shipping: p.accordions?.shipping ?? '',
    },
  };
}

export function PrintPdpEditor({ state }: { state: ContentEditorState }) {
  const router = useRouter();
  const [activeLocale, setActiveLocale] = useState<CmsLocale>('pl');
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [payloads, setPayloads] = useState<Record<CmsLocale, PrintPdpPayload>>(() =>
    Object.fromEntries(LOCALES.map((locale) => [locale, asPayload(state.locales[locale].payload)])) as Record<CmsLocale, PrintPdpPayload>,
  );

  const payload = payloads[activeLocale];
  const current = state.locales[activeLocale];
  const latestVersion = current.latestDraft?.version ?? current.published?.version ?? null;
  const saved = asPayload(current.payload);
  const isDirty = FIELDS.some((f) => getField(payload, f.path).trim() !== getField(saved, f.path).trim());

  function update(path: FieldPath, value: string) {
    setPayloads((prev) => ({ ...prev, [activeLocale]: setField(prev[activeLocale], path, value) }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
  }

  async function saveDraft() {
    setBusy('draft');
    setMessage(null);
    setErrors({});
    try {
      const data = await postJson('/api/admin/content/draft', {
        kind: state.kind,
        slug: state.slug,
        locale: activeLocale,
        payload,
      });
      setMessage({ ok: true, text: `Szkic zapisany jako wersja ${data.version?.version ?? ''}.` });
      startTransition(() => router.refresh());
    } catch (err) {
      setErrors((err as Error & { fields?: FieldErrors }).fields ?? {});
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Blad zapisu.' });
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (!latestVersion) return;
    setBusy('publish');
    setMessage(null);
    try {
      await postJson('/api/admin/content/publish', {
        kind: state.kind,
        slug: state.slug,
        locale: activeLocale,
        version: latestVersion,
      });
      setMessage({ ok: true, text: `Opublikowano wersje ${latestVersion}.` });
      startTransition(() => router.refresh());
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Blad publikacji.' });
    } finally {
      setBusy(null);
    }
  }

  async function preview() {
    if (!latestVersion) return;
    setBusy('preview');
    setMessage(null);
    try {
      const data = await postJson('/api/admin/content/preview', {
        kind: state.kind,
        slug: state.slug,
        locale: activeLocale,
        version: latestVersion,
      });
      if (data.path && data.token) window.open(`${data.path}?preview=${encodeURIComponent(data.token)}`, '_blank', 'noopener');
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Blad podgladu.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="adm-editor">
      <div className="adm-tabs" role="tablist" aria-label="Locale">
        {LOCALES.map((locale) => {
          const localeState = state.locales[locale];
          const cls = localeState.published ? 'published' : localeState.latestDraft ? 'pending' : 'missing';
          return (
            <button
              key={locale}
              className={`adm-tab ${activeLocale === locale ? 'is-active' : ''}`}
              type="button"
              onClick={() => {
                setActiveLocale(locale);
                setMessage(null);
                setErrors({});
              }}
              role="tab"
              aria-selected={activeLocale === locale}
            >
              <span>{locale}</span>
              <span className={`adm-locale ${cls}`}>{localeState.published ? 'pub' : localeState.latestDraft ? 'draft' : 'missing'}</span>
            </button>
          );
        })}
      </div>

      <div className="adm-panel">
        <div className="adm-editor-head">
          <div>
            <h2 className="adm-section-title">Sekcje print PDP</h2>
            <p className="adm-sub adm-sub--tight">
              Ostatni szkic: {current.latestDraft?.version ?? 'brak'} · opublikowana: {current.published?.version ?? 'brak'}
            </p>
          </div>
          <div className="adm-actions adm-actions--top">
            <button className="adm-btn" type="button" disabled={busy !== null || pending} onClick={saveDraft}>
              {busy === 'draft' ? 'Zapisuje...' : 'Zapisz szkic'}
            </button>
            <button className="adm-btn" type="button" disabled={!latestVersion || isDirty || busy !== null || pending} onClick={preview}>
              {busy === 'preview' ? 'Otwieram...' : 'Podglad'}
            </button>
            <button className="adm-btn" type="button" disabled={!latestVersion || isDirty || busy !== null || pending} onClick={publish}>
              {busy === 'publish' ? 'Publikuje...' : 'Publikuj'}
            </button>
          </div>
        </div>

        {isDirty ? <div className="adm-banner">Masz niezapisane zmiany — zapisz szkic przed podgladem lub publikacja.</div> : null}
        <div className="adm-banner">Puste pole wylacza dana sekcje na stronie produktu. Bez opublikowanego dokumentu strona uzywa tekstow domyslnych z tlumaczen.</div>

        <div className="adm-note-list">
          {FIELDS.map((field) => (
            <label className="adm-note-row" key={field.path}>
              <span className="adm-note-body">
                <span className="adm-note-label">
                  <span>{field.label}</span>
                  <span className="adm-mono">{field.path}</span>
                </span>
                <textarea
                  className={errors[field.path] ? 'has-error' : ''}
                  value={getField(payload, field.path)}
                  onChange={(event) => update(field.path, event.target.value)}
                  rows={field.rows}
                />
                {errors[field.path] ? <span className="adm-field-error">{errors[field.path]}</span> : null}
              </span>
            </label>
          ))}
        </div>

        {message ? <p className={`adm-action-msg ${message.ok ? 'ok' : 'err'}`}>{message.text}</p> : null}
      </div>
    </div>
  );
}
```

(Zod error paths for this schema are dot-joined — e.g. `artist.bio`, `accordions.framing` — via `zodIssues`, matching `FIELDS[].path` exactly, so server-side validation errors land under the right textarea.)

- [ ] **Step 4: Pick the editor variant in `page.tsx`**

In `src/app/admin/content/[kind]/[slug]/page.tsx`, import `PrintPdpEditor` and replace the editor line and the subtitle:

```tsx
          <p className="adm-sub">
            <span className="adm-mono">{state.kind}:{state.slug}</span>
            {state.items.length > 0 ? <> · {state.items.length} opisow</> : null}
          </p>
```

```tsx
      {state.kind === 'page' ? <PrintPdpEditor state={state} /> : <ContentEditor state={state} />}
```

- [ ] **Step 5: Preview path for the new document (+ fix the stale fap01 path)**

In `src/app/api/admin/content/preview/route.ts`, import `registryPrintDesigns` from `@/lib/prints` and replace `previewPath` with:

```ts
function firstPublishedPrintPath(locale: CmsLocale): string {
  const design = registryPrintDesigns().find((d) => d.published);
  return localizedPath(locale, design ? `/fine-art-prints/${design.id}` : '/fine-art-prints');
}

function previewPath(kind: string, slug: string, locale: CmsLocale): string {
  if (kind === 'page' && slug === 'print-pdp') return firstPublishedPrintPath(locale);
  if (kind !== 'product_notes') return localizedPath(locale, '/');
  // fap01 was withdrawn (published:false) — preview must land on a live PDP.
  if (slug === 'fine-art-prints') return firstPublishedPrintPath(locale);
  const product = registryProductsByCategory(slug as CategorySlug)[0];
  return localizedPath(locale, product ? `/${slug}/${product.id}` : `/${slug}`);
}
```

- [ ] **Step 6: Lint + typecheck + full unit tests**

Run: `npm run lint && npm run typecheck && npm run test`
Expected: clean; only the 4 known Windows-local failures (diff against `main` if unsure) — every `src/lib/cms/*` test passes.

- [ ] **Step 7: Commit**

```bash
git add src/lib/admin/content.ts "src/app/admin/content/[kind]/[slug]/editor-shared.ts" "src/app/admin/content/[kind]/[slug]/PrintPdpEditor.tsx" "src/app/admin/content/[kind]/[slug]/ContentEditor.tsx" "src/app/admin/content/[kind]/[slug]/page.tsx" src/app/api/admin/content/preview/route.ts
git commit -m "feat(admin): print-pdp sections document in the content CMS"
```

---

### Task 6: End-to-end verification

**Files:** none (verification only; fix-forward commits allowed).

⚠️ Local env points at the **production** Supabase project — do **not** press "Publikuj" in the local admin. Draft + Podgląd only; draft versions are never served to the storefront.

- [ ] **Step 1: Full gate**

Run: `npm run lint && npm run typecheck && npm run test`
Expected: clean (modulo the 4 known Windows-local vitest failures — verify they are identical on `main`).

- [ ] **Step 2: Storefront render matrix (dev server)**

Run `npm run dev`, then verify:

1. **No CMS document (default state):** `http://localhost:3000/fine-art-prints/fap005` — three accordions with PL fallback copy; size facts line inside "Szczegóły produktu"; About-the-artist band with photo, "Anna Ciok" and bio after "More prints"; no empty placeholders anywhere.
2. **Locales:** `/en/fine-art-prints/fap005`, `/de/fine-art-prints/fap005` — headings and fallback copy switch language.
3. **Purchase path intact:** on the PL PDP pick size 50×70 + rama czarna + passe-partout, add to cart, open `/koszyk` — line item and price unchanged from pre-change behaviour.
4. **Accordion behaviour:** open/close each accordion with mouse and with keyboard (Tab + Enter).
5. **Expandable note:** current notes are short — no "Czytaj więcej" toggle visible. Temporarily verify the toggle by narrowing the viewport to 360px (long DE note may clamp); if no note clamps, confirm the toggle logic by temporarily editing one note draft in admin preview (step 3) instead of code.
6. **Mobile/desktop:** 360px and 1280px — accordions full-width in the buy column, artist band centred, no horizontal scroll.

- [ ] **Step 3: Admin flow (draft + preview only)**

Run admin locally (dev server + `STUDIO_ADMIN_LOCAL_BYPASS` per `.dev.vars`), then:

1. `/admin/content` lists "Print PDP — sekcje" with status `missing`.
2. Open it — `PrintPdpEditor` shows 5 fields prefilled with PL fallback copy; locale tabs switch payloads.
3. Edit the framing field, "Zapisz szkic" → draft version 1 saved; dirty banner clears.
4. "Podgląd" → opens `/fine-art-prints/<first published design>?preview=…` showing the edited framing text in the accordion (published storefront copy unaffected).
5. Empty the bio field entirely, save a draft, preview → About-the-artist band absent on the preview.
6. **Do not publish.** History page lists the draft versions.

- [ ] **Step 4: Production-parity build**

Run: `npm run build`
Expected: clean webpack build (no Turbopack). Optionally `npm run preview:cf` and re-check render matrix item 1 on `:8787`.

- [ ] **Step 5: Update docs**

- `docs/STATUS.md`: add a line — print PDP sections (accordions + about-artist) live behind the `page:print-pdp` CMS document; fallback copy in messages; publish pending (admin has not yet published a document).
- `AGENTS.md` (CMS content layer paragraph): extend the sentence describing `cms_documents` kinds to mention the `page:print-pdp` document powering the print-PDP sections.

```bash
git add docs/STATUS.md AGENTS.md
git commit -m "docs: record print-pdp CMS document in STATUS/AGENTS"
```

- [ ] **Step 6: Push and open PR**

```bash
git push -u origin feat/print-pdp-sections
gh pr create --title "feat(prints): admin-managed print PDP sections (accordions, about-artist, expandable note)" --body "$(cat <<'EOF'
## Summary
- New CMS document `page:print-pdp` (fixed zod schema, per-locale draft/preview/publish) drives three PDP info accordions + About-the-Artist band
- Accordions replace the static spec block (content absorbed into fallback copy in messages/*)
- Product note gets a measured read-more clamp; per-design size facts stay registry-driven
- Admin: fixed-fields editor variant at /admin/content/page/print-pdp; preview path fixed for withdrawn fap01
- Spec: docs/archive/2026-08-10-print-pdp-sections-design.md

## Test plan
- [ ] vitest: cms schema + print-pdp helper suites
- [ ] lint/typecheck/build (webpack) clean
- [ ] Render matrix: fallback / draft-preview / emptied-field on fap005 across locales
- [ ] Purchase path unchanged (configurator → cart)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Post-merge follow-ups (not in this plan)

- Publish real CMS copy from the production admin (draft → preview → publish per locale).
- CI E2E (@ci print purchase spec) runs on the PR — watch it; local Windows E2E is optional (`docs` + memory: serve on :3210 with `PLAYWRIGHT_BASE_URL`).
- Consider adopting `PdpAccordions` on the ceramic PDP (new CMS doc slug) — deliberately out of scope.
