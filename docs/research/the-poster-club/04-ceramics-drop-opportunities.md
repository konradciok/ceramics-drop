# 04 — Opportunities for ceramics-drop

This is the implementation-facing cut.

## Priority legend
- **P1** — highest ROI, should move print conversion/discovery materially
- **P2** — important trust/storytelling upgrades
- **P3** — good leverage after the core is stronger

---

## P1 — Build a real print discovery layer

### Why
Current print collection (`src/components/shop/PrintCollectionScreen.tsx`) is too thin compared to the competitive standard.
It shows inventory, but not enough ways to enter or narrow it.

### What to add
1. **Curated subcollection links above the grid**
   - examples: `New Arrivals`, `Bestsellers`, `XL`, `Botanical`, `Kitchen`, `Bedroom`
2. **Artist name on each print tile**
3. **Variant breadth signal**
   - e.g. `3 sizes`, `5 sizes`, `framed available`
4. **At least one lightweight filter layer**
   - size
   - orientation
   - room
   - style/theme
5. optional later: **product vs lifestyle image mode**

### Likely files
- `src/components/shop/PrintCollectionScreen.tsx`
- `src/lib/prints.ts`
- maybe new helpers/components:
  - `src/components/shop/PrintFilters.tsx`
  - `src/lib/print-facets.ts`

### Notes
Do **not** start with a giant faceting system.
Start with curated subsets + one or two meaningful filter dimensions.

---

## P1 — Rebuild print PDP hierarchy around confidence

### Why
`PrintConfigurator.tsx` is solid, but the page around it is under-merchandised.

### What to add
1. **Trust strip under CTA**
   - e.g. archival print quality
   - fulfilled on demand / production window
   - tracked shipping / returns policy
2. **Accordion utility block**
   - shipping
   - paper & print process
   - framing details
   - care
3. **Artist / collection story module below the fold**
4. **Better cross-sell**
   - more from this artist
   - more from this mood / series
5. **Image-sequence discipline**
   - hero / lifestyle / close-up / isolated product

### Likely files
- `src/components/shop/PrintProductScreen.tsx`
- `src/components/shop/PrintConfigurator.tsx`
- possibly new supporting components:
  - `src/components/shop/TrustRow.tsx`
  - `src/components/shop/PdpAccordion.tsx`
  - `src/components/shop/ArtistStory.tsx`

### Important constraint
Keep the page server-first. Add only small client islands where state is real.

---

## P2 — Add studio / artist editorial modules

### Why
The Poster Club continuously re-anchors the product to an artist or curated worldview.
That raises perceived value and keeps browsing coherent.

### For prints
- artist bio block
- artist photos / context
- related works from same artist

### For ceramics
Don’t fake a marketplace artist layer — use Anna/studio truth instead:
- studio process
- material and firing notes
- care / durability
- one-of-one value explanation

### Likely files
- `src/components/shop/PrintProductScreen.tsx`
- `src/components/shop/ProductPageScreen.tsx`
- content source additions in translations or a structured content module

---

## P2 — Upgrade trust content near purchase actions

### Why
Current PDPs are honest, but they ask the user to assume too much.
The competitor makes reassurance explicit.

### For prints
- production lead time
- shipping territory / delivery expectations
- archival print quality
- frame/passepartout notes

### For ceramics
- one-of-one reservation logic
- dispatch window
- packaging / breakage care
- returns boundaries for unique works

### Likely files
- `src/components/shop/PrintProductScreen.tsx`
- `src/components/shop/ProductPageScreen.tsx`
- potentially shared content components

---

## P3 — Create curated print subsets as first-class routes

### Why
This is probably the cleanest way to import The Poster Club’s discovery model without bloating the whole app.

### Good first subsets
- `new arrivals`
- `bestsellers`
- `xl`
- `botanical`
- `kitchen`
- `bedroom`
- `graphic / abstract`

### Benefits
- SEO landing pages
- internal merchandising targets
- easier ad campaign routing
- easier homepage modules

### Likely files
- route layer under `src/app/[locale]/(collections)/...`
- print data annotations in `src/lib/prints.ts`
- collection SEO helpers

---

## P3 — Introduce a more editorial homepage path into prints

### Why
The competitor doesn’t rely on one giant category page. They create many narrative entry points.

### Possible modules
- shop by room
- large-format prints
- Anna’s current favorites
- color-led seasonal edit
- pairings with ceramics

This may fit the brand especially well because `ceramics-drop` can do something they can’t:
**cross-merchandise prints and ceramics as a single authored world**.

---

## What I would not do yet

### 1. Do not clone their full marketplace taxonomy
You do not have their assortment scale.

### 2. Do not add heavy faceted search for ceramics
It will add UI weight without enough inventory payoff.

### 3. Do not genericize the voice
Anna’s brand should feel more authored and less “premium-template”.

---

## Recommended implementation order

### Phase 1
- upgrade `PrintCollectionScreen.tsx`
- add curated subsets + richer tile metadata

### Phase 2
- upgrade `PrintProductScreen.tsx`
- add trust / accordion / artist storytelling

### Phase 3
- create 2–4 first-class print subset routes
- wire homepage / nav modules to them

### Phase 4
- selectively port the best reassurance patterns to ceramics PDP

---

## Concrete repo baseline

Current relevant files and what they imply:

### `src/components/shop/PrintCollectionScreen.tsx`
Good:
- simple
- server-rendered
- cheap to evolve

Weak vs competitor:
- grid-only
- no discovery depth

### `src/components/shop/PrintProductScreen.tsx`
Good:
- already split from ceramic PDP
- clean structure

Weak vs competitor:
- limited persuasion layers
- limited contextual modules

### `src/components/shop/PrintConfigurator.tsx`
Good:
- functional core already exists
- pricing logic is real, not fake UI

Weak vs competitor:
- lacks supporting content surfaces around it

### `src/components/shop/ProductPageScreen.tsx`
Good:
- focused one-of-one ceramic story

Weak vs competitor:
- underpowered reassurance / editorial modules

---

## One-sentence recommendation

If you want the shortest path to competitive uplift, **treat fine-art prints as the place to import The Poster Club’s marketplace playbook, and treat ceramics as the place to keep a tighter authored/studio-led version of it.**
