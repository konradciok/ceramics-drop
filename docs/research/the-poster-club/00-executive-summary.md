# 00 — Executive summary

## What The Poster Club is actually doing well

### 1. They built a discovery machine, not just a store
Evidence:
- `101` collection URLs in sitemap (`raw/poster-club-sitemap.json`)
- flagship `/collections/all-art` page aggregates `1621` artworks
- visible subcollection shortcuts: `Art Prints`, `Wall Objects`, `Canvas Art`, `New Arrivals`, `Bestsellers`, `XL Art Prints`
- filters observed in browser: `Size`, `Orientation`, `Artist`, `Price Range`, `Color`, `Category`, `By Room`, `Artwork Type`

Implication: user can enter through many intents — medium, room, artist, scale, trend, bestseller, novelty.

### 2. Their catalog is broad, but the merchandising model is simple
Evidence from `raw/poster-club-collections.json`:

| Collection | Products | Price range (€) | Variant pattern |
|---|---:|---:|---|
| All Artworks | 1621 | 43–425 | mostly 3/4/5 size variants |
| Art Prints | 1425 | 43–269 | mostly 4/3/5 size variants |
| Canvas Art | 126 | 129–349 | mostly 3 size variants |
| Wall Objects | 42 | 129–389 | always 1 size |
| New Arrivals | 37 | 43–269 | mostly 5/4 size variants |
| Bestsellers | 69 | 43–269 | mostly 5 size variants |
| XL Art Prints | 267 | 43–269 | mostly 5 size variants |

To nie jest custom configurator-heavy commerce. To jest kilka product families z przewidywalnymi regułami.

### 3. Their PDPs are built around confidence and upsell
Observed on `Perfect Together` PDP:
- framed hero + lifestyle + detail + product-only gallery
- artist breadcrumb layer: `Home > Art Print > Suzanne Lustig > Perfect Together`
- compact premium copy first, longer copy on expand
- size selector first
- add-on upsells second (`passepartout`, `frame`)
- running total before CTA
- trust row under CTA
- utility accordions: room view, shipping, product details, framing details
- below the fold: more from artist + artist editorial block + category links

This is not minimalism for its own sake. It is structured reassurance.

### 4. They sell taste, not only objects
Recurring cues:
- `Curated in Copenhagen`
- artist pages and artist links everywhere
- room-oriented filters
- lifestyle view toggle on collection page
- art-wall tooling in global nav (`ART WALL DESIGNER`)
- editorial subcollections and named collections in sitemap (`main-collection`, `the-garden-collection`, `the-paris-metro-collection`, etc.)

## Where ceramics-drop is currently weaker

### Fine-art print collection page
Current `src/components/shop/PrintCollectionScreen.tsx`:
- tiles show only image + `Print Nº X` + from-price
- no filter layer
- no artist layer
- no lifestyle/product view switch
- no merchandising shortcuts
- no discovery scaffolding besides the grid itself

### Fine-art print PDP
Current `src/components/shop/PrintProductScreen.tsx` + `PrintConfigurator.tsx`:
- configurator exists and is useful
- but PDP is still product-centric, not merchandising-centric
- no artist module
- no trust row
- no shipping/framing accordions
- no room-intent guidance
- sibling section is only `4` items and not artist-led

### Ceramics PDP
Current `src/components/shop/ProductPageScreen.tsx`:
- strong and honest for one-of-one ceramics
- but weaker on reassurance and context than The Poster Club
- missing explicit shipping / returns / care / process trust blocks
- missing artist/studio narrative modules below the fold

## Best practices worth adapting

### Copy / content
- short premium summary first, technical depth later
- artist attribution as a first-class entity, not a footnote
- medium-specific explanation (paper vs canvas vs ceramic relief)
- room/style suggestion copy for search intent and imagination

### PLP UX
- subcollection shortcuts above the grid
- filter groups aligned to how people shop art: room, size, orientation, artist, medium
- display density switcher
- product/lifestyle view mode

### PDP UX
- trust strip directly under CTA
- shipping and material details collapsed but easy to find
- artist story block below fold
- related works by same artist / same family
- additive upsells where relevant

## Best practices NOT to copy blindly

### 1. Massive assortment logic
`ceramics-drop` is not a 1621-SKU marketplace. For ceramics, scarcity and edit matter more than breadth.

### 2. Over-filtering ceramics
For one-off ceramics, too many filters can make the store feel like inventory software.

### 3. Generic premium language
The Poster Club sometimes uses polished but templated luxury copy. For Anna’s work, too much of that would flatten the studio voice.

## Highest-ROI moves for ceramics-drop

### P1 — Add a real discovery layer to fine-art prints
Best leverage because your print catalog is the closest competitive overlap.

### P1 — Upgrade print PDP into a confidence + context surface
You already have configurability. What’s missing is merchandising structure.

### P2 — Add artist/studio editorial modules to PDPs
For prints and ceramics, but adapted to Anna’s brand voice.

### P2 — Add trust/utilities under CTA
Shipping, returns, materials, fulfillment timing.

### P3 — Introduce curated print subsets
`new arrivals`, `bestsellers`, `XL`, `botanical`, `kitchen`, `bedroom`, etc.

## Bottom line

The Poster Club’s edge is not some secret Shopify trick.

It is a layered system:
1. broad entry points,
2. premium-but-fast collection browsing,
3. reassuring PDP structure,
4. constant artist/context merchandising,
5. many chances to continue browsing without losing taste coherence.

For `ceramics-drop`, the biggest opportunity is **not** to imitate the full marketplace.
It is to selectively import the parts that increase conversion and perceived curation for prints, while keeping ceramics more intimate and scarcity-led.
