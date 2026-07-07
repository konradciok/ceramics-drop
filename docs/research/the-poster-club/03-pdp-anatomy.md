# 03 — PDP anatomy

This section looks at three sample PDPs:
- print: `Perfect Together`
- canvas: `The Line - Red`
- wall object: `Thalia Vase`

Source: `raw/poster-club-sample-pdps.json` + live browser observations.

## Shared PDP structure

Across product families, the same skeleton appears:
1. breadcrumb with category and artist
2. large media gallery
3. purchase panel
4. trust row / utility details
5. related works / artist module below fold

That consistency is valuable. It teaches the customer how to buy across mediums.

## A. Print PDP — `Perfect Together`

### Core metadata
- type: `Print`
- vendor: `The Poster Club`
- variants: `5`
- price ladder: `€43 → €269`
- images: `4`
- breadcrumb: `Home > Art Print > Suzanne Lustig > Perfect Together`

### Gallery strategy
Observed assets:
- framed hero
- lifestyle shot
- close-up
- product-only shot

This gives the user four answers fast:
- what it is,
- how it looks in a room,
- what the surface/detail feels like,
- what the raw motif is.

### Purchase panel hierarchy
Observed order:
1. title
2. artist link
3. price
4. short premium summary
5. `Read more`
6. size selector
7. size guide
8. add-on upsells (`passepartout`, `frame`)
9. running total
10. add to bag CTA
11. trust row
12. utility accordions

That order is strong because it moves from:
- desire →
- understanding →
- configuration →
- reassurance.

### Trust and reassurance
Observed trust row:
- `30-Day Returns`
- `Trusted by +100.000 Customers`
- `Worldwide Shipping`

Observed accordions:
- `View in your room`
- `Frame & passepartout details`
- `Shipping information`
- `Product details`

These are classic conversion-friction reducers.

### Below the fold
Observed modules:
- `Discover More From this Artist`
- artist editorial block
- artist imagery
- `Explore other categories`

This turns the PDP from a dead end into a browsing hub.

## B. Canvas PDP — `The Line - Red`

### Core metadata
- type: `Canvas`
- variants: `3`
- price ladder: `€129 → €349`
- images: `5`
- breadcrumb: `Home > Canvas > Rebecca Hein > The Line - Red`

### Positioning difference
Canvas copy leans harder into:
- material quality (`320 g cotton canvas`)
- framed ready-to-hang format
- tactile surface and depth
- premium object feel

This is important: medium is doing narrative work.
It is not just another variant of the same product page.

### Learning
For products where material changes meaningfully, the PDP should explain:
- why this medium exists,
- what visual experience it creates,
- how it differs from the base product family.

## C. Wall object PDP — `Thalia Vase`

### Core metadata
- type: `Wall Object`
- variants: `1`
- price: `€159`
- images: `7`
- breadcrumb: `Home > Wall Object > Laoru Laoru > Thalia Vase`

### Content difference
Wall-object copy goes deeper on:
- provenance and making
- symbolism
- materials
- dimensions
- mounting
- care

Because there is less configurability, they replace option depth with object depth.

### Visual difference
Observed page still uses the same global skeleton, but:
- no frame/passepartout upsells
- single size selector
- more detail and close-up imagery
- artist/story section still carries weight

This is a good pattern: keep the mental model stable, change the content emphasis.

## What ceramics-drop already does well

### Prints
Current `PrintConfigurator.tsx` is actually strong in core buying logic:
- explicit size axis
- framed / unframed state
- frame colour axis
- mount axis
- live price
- mixed-cart protection

That’s better than many stores technically.
The gap is not the config logic. The gap is presentation and context.

### Ceramics
Current `ProductPageScreen.tsx` already has:
- clean gallery
- price clarity
- dimensions / technique / one-of-one copy
- sibling recommendations

So the foundation is not weak.
It just has less confidence-building structure around it.

## Where ceramics-drop PDPs are currently lighter than The Poster Club

### Print PDP gaps
Current `PrintProductScreen.tsx`:
- no artist block below the fold
- no explicit trust row under CTA
- no dedicated shipping accordion
- no framing / material accordion
- no room-view or placement guidance
- sibling section not explicitly artist-first

### Ceramics PDP gaps
Current `ProductPageScreen.tsx`:
- no delivery/returns reassurance close to CTA
- no care/process/material story below fold
- no studio narrative block
- no stronger separation between short emotional copy and technical details

## Recommendations by PDP type

### For print PDPs
Adopt almost directly:
1. trust row under CTA
2. shipping / production / framing accordions
3. artist story module below fold
4. better image sequence discipline
5. related works grouped by artist or collection

### For ceramics PDPs
Adapt, don’t clone:
1. short emotional note first
2. technical specs collapsed or structured beneath
3. trust row tuned to ceramics:
   - one-of-one piece
   - secure packaging
   - dispatch window
4. studio/process/care module instead of artist marketplace module
5. maybe `works well with` or `more from this category`, but keep it restrained

## The real lesson

The Poster Club’s PDP strength is not “fancy design”.
It is the discipline of answering, in one page:
- what is this?
- why is it worth this price?
- how do I choose the right version?
- can I trust the purchase?
- what should I look at next?

That checklist is what should drive upgrades in `ceramics-drop`.

## Evidence files
- `raw/poster-club-sample-pdps.json`
- `raw/browser-observations.json`
