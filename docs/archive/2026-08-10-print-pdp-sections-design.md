> **Archived 2026-08-11 — shipped.** Implemented and merged as PR #237 (`97a17f5`). Current feature state lives in `docs/STATUS.md` (Print PDP sections row); architecture in `AGENTS.md` (CMS content layer). Kept for rationale only.

# Print PDP — reusable admin-managed sections (design)

**Date:** 2026-08-10
**Status:** approved for planning
**Reference:** `design/references/pdp-structure.png` (The Poster Club PDP — structural reference only, not a visual template)

## Goal

Extend the fine-art-print PDP (`PrintProductScreen`) with reusable, admin-managed
content sections inspired by the reference: info accordions, an "About the
Artist" band, and an expandable product note. No hardcoded per-product content
in frontend components; content is edited in the existing lightweight CMS
(`/admin/content`), with `messages/*.json` as the fallback layer.

Existing purchase behaviour (gallery, variant configurator, pricing, More
Prints) is unchanged.

## Scope decisions (from brainstorming)

- **In scope:** three info accordions, About the Artist section, expandable
  product note. Accordions **replace** the current static spec block
  (Details / Edition / Delivery / Care), absorbing its content.
- **Out of scope:** "Discover More From this Artist" (covered by the existing
  More Prints — single artist, identical recommendations), category
  cross-links module, artist entity/table, CMS image upload, JSON-LD changes,
  ceramics-PDP adoption (future follow-up; components are generic).
- **Artist model:** one global shared section (single artist — Anna Ciok).
  No `artists` table, no product→artist relation (YAGNI).

## Data model

### New CMS document: `page:print-pdp`

Reuses the existing lightweight CMS (`cms_documents` + versioned per-locale
payloads, draft → preview → publish → history/audit). No new tables, no
migration. Payload per locale:

```ts
type PrintPdpPayload = {
  artist: { name: string; bio: string };      // bio: plain text, blank lines = paragraphs
  accordions: {
    productDetails: string;  // technique, edition, care (absorbs spec block)
    framing: string;         // frame & passe-partout details
    shipping: string;        // shipping & returns (absorbs deliveryNote)
  };
};
```

- **All fields may be empty** (`z.string().trim()`, no `min(1)`) — deliberate
  departure from the other CMS schemas. Publishing an empty field is the
  admin-facing mechanism for disabling a section.
- Plain-text validation (no `<`/`>`), same refinement as existing schemas.
- New case in `validateCmsPayload` under the existing `page` kind branch.

### Fallback layer

New keys in `messages/{pl,en,es,de}.json` (edited directly in all four files —
Notion sync is PL-only):

- `printPdp.artistName`, `printPdp.artistBio` — artist fallback copy.
- `printPdp.accordionProductDetails` / `printPdp.accordionFraming` /
  `printPdp.accordionShipping` — seeded from the current spec-block strings
  (`print.technique`, `print.editionOpen`, `print.careNote` → productDetails;
  `print.deliveryNote` → shipping) plus new framing copy.
- Accordion/section **headings** are static UI strings
  (`printPdp.accordionProductDetailsTitle` / `printPdp.accordionFramingTitle` /
  `printPdp.accordionShippingTitle`, `printPdp.aboutArtistTitle`, plus
  `printPdp.readMore` / `printPdp.readLess` for the bio toggle) — chrome, not
  CMS content.

With no CMS document at all, the PDP renders complete content from messages
(acceptance criterion: unconfigured products render correctly).

### Artist photo

Static asset in `public/uploads/` + entry in `src/lib/editorial-images.ts`
(same pattern as `STUDIO_STORY_IMAGE`). No CMS-managed images.

## Read path

New helper in `src/lib/cms/` — `getPrintPdpContent(locale, previewToken?)`:

1. Valid `?preview=` token (existing HMAC mechanism, `CMS_PREVIEW_SECRET`) →
   draft version payload.
2. Otherwise published payload via `getPublishedContent('page', 'print-pdp', locale)`.
3. Document missing / read error → **full fallback** from messages.
4. Merge is per-field only in the "no document" sense: when a published
   document exists, its (possibly empty) fields win — an intentionally
   emptied field hides its section rather than resurrecting fallback copy.

Returns a typed, ready-to-render object. `page.tsx` adds the call to the
existing `Promise.all` in the print branch and passes the result to
`PrintProductScreen`.

## Components

All in `src/components/shop/`, styled via tokens in `site.css`, server
components unless noted:

- **`PdpAccordions`** — stack of native `<details>/<summary>` (no JS, no
  hydration, keyboard-accessible). Renders only non-empty sections. The
  product-details body auto-appends per-design registry facts (available
  sizes with dimensions — the current `sizeLines`) after the CMS text, so
  product data is never copied into CMS.
- **`AboutArtistSection`** — full-width band: photo + name + bio paragraphs.
  Rendered only when `bio` is non-empty.
- **`ExpandableText`** — small client island: CSS `line-clamp` + "read
  more/less" toggle shown only when the text actually overflows
  (`useLayoutEffect` measurement). Applied to the product note; reusable for
  a long artist bio.

### PDP layout after the change

```text
breadcrumb
buy box (gallery + configurator + note w/ ExpandableText)   ← unchanged behaviour
PdpAccordions (product details / framing / shipping)         ← replaces spec block, in buy-box column
More Prints                                                  ← unchanged
AboutArtistSection                                           ← new, last
```

## Admin

- `PRODUCT_NOTE_DOCUMENTS` generalises into an editable-documents registry;
  `page:print-pdp` is added with label "Print PDP — sekcje" and publicPath
  `/fine-art-prints`. It appears in the same `/admin/content` table.
- The editor page gets a second form variant for fixed fields (artist name,
  bio, three accordion textareas) with the same per-locale tabs and the same
  draft / publish / preview / history actions — the API routes
  (`/api/admin/content/*`) are already generic (gated by `editableDocument()`
  + `validateCmsPayload()`), so no route changes.

## Error handling

- CMS read failure → messages fallback; the PDP never breaks (same contract
  as product notes).
- Invalid/expired preview token → published content.
- Empty published field → section not rendered (no empty placeholders).

## Testing & verification

- Unit: new `schemas.test.ts` cases (payload validation, empty fields
  accepted, `<`/`>` rejected); `getPrintPdpContent` merge tests (published >
  fallback; missing document → full fallback; emptied field hides section).
- `npm run lint && npm run typecheck && npm run test`.
- Dev render checks: PDP with a full CMS document, with partially empty
  fields, and with no document (pure fallback); representative mobile +
  desktop widths.
- Existing @ci E2E (print purchase) must keep passing — configurator
  untouched.
