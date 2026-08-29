# Generative prompts for print mockups

## Purpose

These prompts translate the visual strategy shared by the five mockup references in this folder into three reusable scene families for our print designs. They reproduce the underlying staging, composition, lighting, and product emphasis without copying a particular competitor room.

Use an image-capable generation or editing model and attach the product artwork as the primary reference image. The artwork is product data, not inspiration: it must be placed unchanged inside the scene.

## Reference-derived visual system

Across the four room mockups, the recurring choices are:

- one framed print is the clear subject and occupies a large share of the composition;
- warm cream, putty, or muted grey-blue walls create a quiet neutral field;
- thin natural-wood or dark-wood frames add warmth without competing with the image;
- natural daylight is soft and warm, with one example using a strong architectural window shadow;
- furnishings are shown only partially and are limited to a few design-conscious forms: a textured sofa, sculptural lamp, chrome or stone table, books, flowers, or one graphic cushion;
- one restrained prop may echo a dominant artwork colour, but the room does not reproduce the motif;
- camera framing feels editorial and slightly asymmetric rather than like a front-on catalogue cutout;
- the spaces are calm and inhabited but never busy; no people appear.

The detail reference changes the scale rather than the mood: it crops tightly into an unframed print, uses its gently curved paper edge to show physical presence, and retains a neutral textile as the only surrounding context.

The heart icons and browser strip visible in two source captures are interface artifacts, not scene elements. Never generate them.

## Shared input variables

- `[ARTWORK_REFERENCE]` — attached high-resolution product artwork.
- `[ARTWORK_ORIENTATION]` — portrait, landscape, or square; preserve it automatically when detectable.
- `[FRAME_TONE]` — natural oak by default; dark wood when it better supports the palette.
- `[MOUNT]` — none unless a verified product configuration specifies an off-white mount.
- `[ACCENT_COLOUR]` — one secondary colour sampled from the artwork, used sparingly in a prop; omit when unnecessary.
- `[OUTPUT_ASPECT_RATIO]` — `4:5` by default for storefront/editorial use.
- `[VERIFIED_PRINT_SURFACE]` — optional verified paper finish or texture for the close-up prompt.

## Non-negotiable artwork-preservation rule

In every scene, preserve `[ARTWORK_REFERENCE]` pixel-faithfully: do not redraw, restyle, recolour, simplify, extend, replace, mirror, rotate, stretch, crop, or add marks or text. Preserve its original aspect ratio and complete composition. Perspective may affect the framed object naturally, but not the internal design. If the model cannot keep the artwork exact, generate the scene with a clean correctly proportioned blank print area and composite the original artwork into that area afterward.

Prompt 3 intentionally permits a close crop of the artwork, but the visible portion must still come directly from the source without regeneration.

## Prompt 1 — sunlit architectural wall

Best for a sparse, art-first lifestyle image with strong natural-light character. It combines the quiet wall treatment and close art dominance of the references with the most distinctive architectural-shadow treatment.

```text
Using the attached [ARTWORK_REFERENCE] as immutable product content, create a photorealistic premium editorial interior photograph featuring exactly one framed art print. Preserve the artwork pixel-faithfully and preserve its original [ARTWORK_ORIENTATION] and aspect ratio; do not redraw, crop, recolour, extend, replace, or reinterpret any part of it.

Hang the print on a warm putty-beige plaster wall in a quiet contemporary European interior. Use a slim [FRAME_TONE] wood frame with realistic mitred corners and [MOUNT]; retain any border already present in the source artwork and do not invent an additional mount. Keep glass reflections extremely subtle so the complete artwork remains clear and colour-accurate.

Late-afternoon daylight enters from an unseen tall window and casts one large, soft-edged rectangular architectural patch of sunlight across the wall, with a controlled portion passing over the frame. The light and shadow should add depth without hiding the artwork. Include only a partial sculptural white chair or ceramic object at the lower-right edge and a narrow glimpse of pale window trim; leave the rest of the room spacious and uncluttered.

Compose at eye level with a natural 50 mm editorial-photography perspective, slightly off-centre rather than perfectly symmetrical. The framed print should occupy roughly 40–50% of the image and remain the unmistakable subject. Warm neutral colour grading, realistic plaster, wood and daylight, gentle filmic softness, high-end interiors-magazine photography, [OUTPUT_ASPECT_RATIO].

Exclude people, additional artwork, gallery walls, plants, rugs, busy furniture, ornate mouldings, harsh glare, heavy reflections, crooked geometry, floating frames, altered artwork, generated lettering, logos, watermarks, browser chrome, interface icons, and ecommerce graphics.
```

## Prompt 2 — curated living-room vignette

Best for showing scale and styling compatibility. It combines the fuller sofa setting with the close, design-led props and subtle palette coordination visible across the room references.

```text
Create a photorealistic premium editorial living-room mockup around the attached [ARTWORK_REFERENCE]. Display exactly one large framed print above a low oatmeal-beige textured sofa. Treat the source artwork as immutable: reproduce it pixel-faithfully with its complete composition, exact colours, original [ARTWORK_ORIENTATION], and original aspect ratio. Do not redraw, restyle, recolour, extend, mirror, crop, or replace it.

Use a muted warm grey-blue wall, a slim [FRAME_TONE] wood frame with realistic depth and [MOUNT], and minimal low-reflection glazing. Furnish the lower portion with the sofa, one restrained patterned cushion, and a small polished-metal or pale travertine side table. On the table place two or three closed art books with blank, unreadable spines and a small clear-glass vase holding a few delicate stems in [ACCENT_COLOUR]. Let that single colour echo the artwork subtly; do not copy its shapes or motif into the decor. Add a softly blurred pale doorway or curtain edge along one side to create foreground depth.

Use soft indirect daytime window light, natural shadow falloff, and calm warm-neutral colour grading. Frame the scene vertically at seated eye level with a slightly asymmetric interiors-editorial composition: enough room context to communicate scale, while the print remains the primary visual focus and occupies roughly one-third of the image. Realistic woven upholstery, wood grain, glass and metal; refined but lived-in, not a showroom render; [OUTPUT_ASPECT_RATIO].

Exclude people, pets, multiple frames, other wall art, excessive props, visible brand names, legible book titles, decorative text, colour-matched overload, motif duplication, distorted furniture, glossy CGI surfaces, strong reflections across the print, altered artwork, logos, watermarks, browser bars, hearts, buttons, and interface elements.
```

## Prompt 3 — tactile unframed print detail

Best for a gallery detail image that communicates the print as a physical object while keeping the artwork itself dominant.

```text
Using the attached [ARTWORK_REFERENCE] as immutable source content, create a photorealistic close-up editorial product photograph of the unframed art print resting in a gentle natural curve over the rounded arm or back of an oatmeal-beige woven sofa. The print should fill about 80–90% of the image in a bold diagonal composition. Show one clean paper edge and a shallow curve created by gravity so the object has believable scale and physical presence.

Use a close crop taken directly from the source artwork: preserve every visible line, colour, boundary and mark pixel-faithfully. Do not regenerate, redraw, smooth, recolour, mirror, extend, add details, or invent missing areas. Render the paper surface only according to [VERIFIED_PRINT_SURFACE]; if no verified surface metadata is supplied, keep it visually neutral with no pronounced grain, fibres, gloss, embossing, or deckled edge.

Light the scene with soft warm natural daylight. Keep the focal plane on the printed marks and nearest paper edge, with only gentle optical falloff toward the far curve. The sofa textile provides the sole quiet background context; allow a very small warm wood or neutral wall area at the edge if needed for depth. Premium macro product photography, realistic scale and paper behaviour, restrained warm colour grade, [OUTPUT_ASPECT_RATIO].

Exclude frames, mounts, hands, people, clips, tape, packaging, labels, props, plants, dramatic curls, creases, torn or deckled edges, invented paper texture, wet ink, canvas texture, altered artwork, generated text, logos, watermarks, browser chrome, interface icons, and ecommerce overlays.
```

## Production check

Before accepting a generated mockup, verify:

1. The artwork matches the source exactly, including orientation, colours, proportions, and internal marks; only Prompt 3 may use an intentional source-faithful close crop.
2. There is exactly one print and it remains the primary subject.
3. Frame and mount choices match an offered product configuration.
4. The room uses restrained neutral materials and no more than one subtle artwork-derived accent.
5. Lighting appears natural and does not obscure or materially recolour the print.
6. Furniture establishes scale without becoming the subject.
7. No interface artifacts, fake text, logos, or invented product characteristics appear.
8. The result feels like a photographed interior or product detail, not a pristine CGI render.
