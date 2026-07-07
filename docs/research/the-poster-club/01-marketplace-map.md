# 01 — Marketplace map

## Brand posture

Above the fold they keep repeating one message:
- `Real Art. Curated In Copenhagen.`

This matters. It positions them as:
- tastemakers,
- not just printers,
- not a cheap poster shop,
- not a gallery in the fine-art-only sense.

They sit in the middle: accessible premium curation.

## Top-level navigation

Observed in browser:
- `SHOP`
- `INSPIRATION`
- `ART WALL DESIGNER`
- `Wishlist`
- `Search`
- `Bag`

Interpretation:
- `SHOP` = transactional taxonomy
- `INSPIRATION` = editorial / discovery / taste education
- `ART WALL DESIGNER` = utility that reduces visual uncertainty
- `Wishlist` = intent capture for long-consideration purchases

This is a strong marketplace pattern: commerce + inspiration + planning tool.

## Catalog scale

From `raw/poster-club-sitemap.json` and `raw/poster-club-collections.json`:
- `101` collection URLs in collection sitemap
- `1621` products on `/collections/all-art`
- major visible product families:
  - `Print` — `1425`
  - `Canvas` — `126`
  - `Wall Object` — `42`
  - `Limited Edition` — `28`

So even though the hero copy says curated, they still support a very wide catalog surface.

## Entry point architecture

### A. Umbrella collection
`/collections/all-art`

Role:
- full catalog search surface
- strongest filterable PLP
- broad intent capture

### B. Medium-led collections
Observed shortcuts:
- `/collections/art-prints`
- `/collections/wall-objects`
- `/collections/canvas`
- `/collections/xl-art-prints-1`

Role:
- user enters by medium / format
- supports medium-specific PDP logic later

### C. Merchandising collections
Observed shortcuts / sitemap signals:
- `/collections/new-arrivals`
- `/collections/bestsellers`
- `main-collection`
- `the-garden-collection`
- `the-peripheral-collection`
- `the-paris-metro-collection`
- many more named collections

Role:
- discovery by taste, trend, or editorial curation
- better for repeat visits than generic category trees

### D. Theme / room / style discovery
Observed in filters and collection URLs:
- by room: `Bathroom`, `Bedroom`, `Living room`
- style-like filters
- collection handles such as `botanical-art-prints`, `minimalistic-art-prints`, `line-art-prints`, `photo-art-prints`

Role:
- maps better to how non-expert customers buy art
- user often knows room or vibe before artist or medium

## Information architecture pattern

The Poster Club uses at least four taxonomies at once:

1. **Medium** — print / canvas / wall object / limited edition
2. **Commercial state** — bestseller / new arrival / XL
3. **Aesthetic cluster** — botanical / abstract / line art / minimalistic
4. **Editorial collection** — named campaigns and artist capsules

That’s why their marketplace feels rich without relying only on search.

## Product-family logic

### Prints
- biggest assortment (`1425`)
- usually multiple sizes
- price ladder starts at `€43`
- works as the default SKU family

### Canvas
- smaller, more premium subset (`126`)
- mostly `3` variants per product
- starts at `€129`
- framed / ready-to-hang positioning

### Wall objects
- smallest but highest differentiation (`42`)
- always `1` variant in observed data
- starts at `€129`
- more sculptural, material-forward, collectible feel

This is a smart ladder:
- good / better / distinct-object
- same audience, different spend level

## Marketplace loops

### Loop 1: collection → PDP → same artist
Observed on sample PDPs:
- artist link in breadcrumb and title area
- `Discover More From this Artist`
- `About the artist` module below fold

### Loop 2: PDP → adjacent categories
Observed:
- `Explore other categories` links near footer on print PDP

### Loop 3: inspiration → shopping
Implied by nav and editorial surfaces:
- art wall inspiration and room context feed product discovery

### Loop 4: save now, buy later
Observed:
- wishlist trigger on cards and PDPs

## What matters for ceramics-drop

### What maps well
- medium-led print subsets
- curated named print drops / edits
- artist/studio narratives
- room-led discovery for prints

### What maps poorly
- giant marketplace sprawl for ceramics
- taxonomy explosion on one-of-one pieces
- generic category proliferation without enough inventory to justify it

## Practical translation

For `ceramics-drop`, treat The Poster Club map as two separate lessons:

### Lesson for prints
Use more of it.
- richer taxonomy
- curated subsets
- artist/context discovery
- stronger merchandising loops

### Lesson for ceramics
Use only the editorial parts.
- scarcity-first
- fewer filters
- more storytelling
- stronger reassurance around shipping / care / process

## Evidence files
- `raw/poster-club-sitemap.json`
- `raw/poster-club-collections.json`
- `raw/browser-observations.json`
