# 02 — Collections and PLP anatomy

## `/collections/all-art` above-the-fold structure

Observed structure:
1. breadcrumbs
2. H1 + count badge (`All Artworks (1621)`)
3. short editorial intro paragraph
4. subcollection shortcut row
5. controls row
6. product grid

This is efficient. It answers, in order:
- where am I?
- how big is this catalog?
- what kind of products are here?
- can I narrow quickly?
- can I change browsing mode?
- show me inventory.

## Subcollection shortcuts

Visible shortcuts above the controls:
- Art Prints
- Wall Objects
- Canvas Art
- New Arrivals
- Bestsellers
- XL Art Prints

Why it works:
- reduces filter dependence
- gives instant “shop by intent” options
- acts like a curated secondary nav within the page

For `ceramics-drop`, this is high ROI for prints.

## Controls row

Observed controls:
- gallery columns: `3`, `4`, `6`
- view mode: `Product`, `Lifestyle`
- `Filters`

### Why the column switch matters
This is not a gimmick.
- dense mode = faster scanning
- wider mode = better appreciation of composition
- user chooses whether they’re browsing as shopper or decorator

### Why lifestyle mode matters
Art has placement anxiety.
Lifestyle imagery helps answer:
- how big will this feel?
- does it fit a room like mine?
- what mood does it create?

## Filters observed

From browser inspection:
- Sort by
- Size
- Orientation
- Artist
- Price Range
- Color
- Category
- By Room
- Artwork Type

Example options observed:
- By Room: `Bathroom`, `Bedroom`, `Living room`
- Artwork Type: `Art Prints`, `Wall Objects`, `Canvas Art`

### Important pattern
These filters are not built only around product metadata.
They are built around **shopping intent**.

Good filter buckets for art:
- visual fit
- scale
- artist
- room use
- medium
- spend

Bad filter buckets for art:
- internal ops schema
- manufacturing-only distinctions the customer does not care about

## Product card anatomy

Observed card fields:
- image
- wishlist action
- title
- price (`From €43,00` or fixed)
- artist name
- `Available in X Sizes`

### What this does well
- title is not overloaded
- artist is always visible
- size availability signals range and flexibility
- “from price” keeps expensive larger variants from scaring top-of-funnel users

### Merchandising effect
The card is doing more than listing a SKU.
It communicates:
- aesthetic identity,
- author,
- pricing entry point,
- configurability.

## Catalog distribution

From `raw/poster-club-collections.json`:

### All Artworks
- total: `1621`
- price range: `€43–€425`
- variant histogram:
  - `3 variants`: `520`
  - `4 variants`: `428`
  - `5 variants`: `277`
  - `2 variants`: `205`
  - `1 variant`: `177`

### Art Prints
- total: `1425`
- price range: `€43–€269`
- variant histogram dominated by `4`, `3`, `5`

### Canvas
- total: `126`
- price range: `€129–€349`
- mostly `3` variants

### Wall Objects
- total: `42`
- price range: `€129–€389`
- always `1` variant

### New Arrivals
- total: `37`
- mostly `5` or `4` variants

### Bestsellers
- total: `69`
- strong concentration in `5`-variant products

### XL Art Prints
- total: `267`
- mostly `5` variants

## What this means strategically

They do not ask the catalog to be infinitely flexible.
They ask it to be:
- broad enough for discovery,
- standardized enough for merchandising,
- predictable enough for easy browsing.

That is exactly why their PLPs feel clean despite scale.

## Where ceramics-drop differs today

Current `src/components/shop/PrintCollectionScreen.tsx`:
- flat grid only
- no artist visible on tile
- no discovery shortcuts
- no filters
- no lifestyle mode
- no collection count / merchandising logic besides the page heading

Current `src/components/shop/ProductTile.tsx` for ceramics:
- optimized for one-of-one cart interactions
- add/remove directly from grid
- alternate image hover and sold state work well
- but the tile is not designed for broad browsing metadata

## High-ROI adaptations for ceramics-drop

### Prints
1. add subcollection quick links above print grid
2. add artist name to print tiles
3. add size-range / size-count signal
4. add at least one lightweight filter set:
   - size
   - orientation
   - vibe/style
   - room
5. consider product/lifestyle toggle if print gallery imagery supports it

### Ceramics
1. keep direct-add behavior
2. do not overload with filters
3. maybe add only soft filtering:
   - category
   - available / sold
   - mug / bowl / vase family
4. rely more on editorial curation than faceted search

## Implementation notes for this repo

Most likely first-touch files:
- `src/components/shop/PrintCollectionScreen.tsx`
- `src/lib/prints.ts`
- i18n copy for collection labels and descriptions
- possibly a new print filter client island if you add faceting

If you do this, start with **curated subsets first**, filters second.
Subsets are easier to merchandise and cheaper to maintain.

## Evidence files
- `raw/poster-club-collections.json`
- `raw/browser-observations.json`
