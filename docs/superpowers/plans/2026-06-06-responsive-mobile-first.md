# Responsive Enhancements — ceramics-drop (responsive-craft audit)

> **Execution note (remote agent):** This plan was authored on another machine. References to the `responsive-craft` skill tools (`C:/Users/Komp/.claude/skills/responsive-craft/scripts/*.js`) are machine-local — if the skill isn't installed where you run, install with `npx skills add kylezantos/responsive-craft -g -y` or simply use the Playwright screenshot fallback described in Phase 1/Verification (it's the primary method anyway; the `snapshot.js` tool needs a `dev-browser` CLI that isn't available). `design/uploads/` (image pipeline source) is gitignored — Phase 3 step 4 (`npm run optimize-images`) can only run on a machine that has it; if absent, implement the script/helper/call-site changes and leave artifact generation as a follow-up commit from the machine holding the sources. **Git safety: do not push to main; work on branch `feat/responsive-mobile-first` and open a PR.**

## Context

A full responsive audit of the front end was run using the `responsive-craft` skill (Transform Existing workflow). The site's foundation is strong — `viewport-fit=cover` + safe-area insets, `dvh` units (no `100vh`), 16px inputs, fluid `clamp()` typography/spacing, `aspect-ratio` containers (no CLS), scroll-locking + focus traps, disciplined z-index — but three structural gaps remain per the skill's rules, plus detail fixes. User approved all design forks:

1. **Convert desktop-first → mobile-first** media queries (full conversion, same pixel boundaries)
2. **Keep explicit gallery columns** (4/3/2 — no auto-fit; deliberate art direction)
3. **Responsive images**: extend `optimize-images` pipeline with 400w/800w/1600w variants + `srcset`/`sizes`; **commit all variants** (matches committed-artifact model)
4. **Drive-bys approved**: fix broken OG image path (`kubek-01.webp` → 404; real file is `kubek-1.webp`) and delete dead CSS (`.btn-sm` at site.css:96, `.feature-inner` ref at :475 — neither referenced by any component)

Container queries deliberately skipped: every component renders in a single context — no reuse benefit.

## Files to modify

- `src/styles/site.css` — mobile-first inversion (the bulk), geowidget cap, dead-rule removal
- `src/styles/tokens.css` — add `--header-h: 96px` token
- `scripts/optimize-images.mjs` — emit `-400w/-800w/-1600w` siblings (keep un-suffixed base for JSON-LD/OG)
- `src/lib/images.ts` — NEW: `srcSet(base)` + `smallest(base)` helpers; `IMG_WIDTHS = [400, 800, 1600]` single source of truth
- `src/components/shop/ProductTile.tsx:38`, `src/app/[locale]/page.tsx:68,103,126`, `src/app/[locale]/o-studiu/page.tsx:45`, `src/components/shop/Lightbox.tsx:148`, `src/components/shop/CartView.tsx:279` — srcset/sizes call-sites
- `src/app/[locale]/layout.tsx:44` — OG path fix
- `public/uploads/` — regenerated artifacts (~264 new files, committed)

## Phase 1 — Foundation + baseline

1. Add `--header-h: 96px;` to `tokens.css` `:root` (additive, no behavior change yet).
2. **Baseline screenshots BEFORE any CSS edits.** `npm run dev` → the responsive-craft `snapshot.js` tool requires `dev-browser` CLI which is NOT installed; use Playwright fallback: throwaway (uncommitted) spec screenshotting at 375/768/1024/1440 widths. Config gotcha: `playwright.config.ts` points `baseURL` at production with no `webServer` — must run with `$env:PLAYWRIGHT_BASE_URL="http://localhost:3000"`.
   Pages: `/`, `/kubki`, `/koszyk` (seed cart via `localStorage` key `acc_cart_v1` from `e2e/helpers/checkout.ts`, select Paczkomat to render delivery fields + geowidget), `/kontakt`, `/regulamin`, `/nope` (404).

## Phase 2 — Mobile-first conversion (site.css)

Replace all 11 `max-width` blocks with **4 ascending `min-width` blocks**: `@sm` 561px, `@md` 861px, `@lg` 981px, `@xl` 1101px (same visual boundaries, +1px inversion). Keep `@media (hover:none)` (:311) and `prefers-reduced-motion` (:715) verbatim. Document breakpoint names in a comment header. No PostCSS — plain CSS only. **Emit blocks strictly ascending so wider tiers win.**

Conversion map (mobile values → BASE; desktop values → min-width block):

| Selector | BASE (mobile) | Desktop tier |
|---|---|---|
| `.header-inner` | `auto 1fr auto; gap:14px` | `@md`: `1fr auto 1fr; gap:40px` |
| `.nav-left` | `display:none` (dedupe — currently in BOTH 560+860 blocks) | `@md`: `display:flex` |
| `.brand` | `justify-content:flex-start` | `@md`: `center` |
| `.mob-trigger` | visible (promote from :652) | `@md`: `display:none` |
| `.nav-right .nav-link` | `display:none` | `@md`: restore |
| `.nav-right .lang-switch` | `display:none` | `@sm`: restore |
| `.lang-switch button` | `padding:6px 7px` | `@sm`: `6px 9px` (folds standalone block :78-80 into `@sm`) |
| `.gallery` | `repeat(2,1fr); gap:12px` | `@sm`: `repeat(3,1fr); gap:clamp(14px,1.6vw,24px)`; `@xl`: `repeat(4,1fr)` |
| `.cart-wrap` | `1fr` | `@xl`: `1.5fr 1fr` |
| `.summary` | `position:static` | `@xl`: `position:sticky; top:var(--header-h); align-self:start` |
| `.cart-row` | `72px 1fr; gap:12px` | `@sm`: `96px 1fr auto; gap:20px` |
| `.cart-row .right` | `grid-column:1/-1; row, space-between` | `@sm`: `column; flex-end` |
| `.hero-inner` | `1fr` | `@md`: `1fr 1.05fr` |
| `.hero-art` | `max-width:460px` | `@md`: `max-width:none` |
| `.story` / `.contact-inner` / `.contact-page` | `1fr` | `@md`: `1fr 1fr` |
| `.collection-grid` | `1fr` | `@md`: `1fr 1fr` |
| `.craft-grid` | `1fr` | `@md`: `repeat(3,1fr)` |
| `.footer-top` | `1fr` | `@sm`: `1fr 1fr`; `@md`: `1.5fr repeat(3,1fr)` |
| `.footer-top.cols-5` | `1fr` | `@sm`: `1fr 1fr`; `@md`: `1.4fr repeat(4,1fr)` |
| `.facts-grid` | `1fr` | `@sm`: `1fr 1fr`; `@md`: `repeat(4,1fr)` ⚠ original steps 4→2→1, NO 3-col tier — don't leave desktop at 2-col |
| `.prose-wrap` | `1fr; gap:36px` | `@lg`: `minmax(0,230px) minmax(0,1fr); gap:clamp(36px,5vw,84px)` |
| `.prose-toc` | `static; flex; wrap; gap:14px 22px` | `@lg`: `sticky; top:var(--header-h); align-self:start` (+ `.prose-toc ul` column; `.updated` revert) |
| `.lb` (lightbox) | bottom-sheet styles (:676-682 → BASE) | `@md`: card styles (:358-368 values) |
| `.lb-card` | `1fr; max-height:96dvh; overflow-y:auto; radius 20px 20px 0 0` | `@md`: `1fr 0.92fr; max-width:920px; 88dvh; radius 3px` |
| `.lb-img` | `min-height:260px; 4/3; touch-action:pan-y` | `@md`: `min-height:360px; 1/1` |
| `.selbar-inner` / `.selbar-info .sum` | 560-block tweaks → BASE | `@sm`: revert to :335/:341 values |
| `.shop-switch` | `width:100%` | `@sm`: revert |
| `.delivery-fields .field-row` | `column; gap:16px` | `@sm`: `row; gap:14px` |
| `.geowidget` | `min-height:280px; height:min(50dvh,360px)` | `@sm`: `height:min(460px, 70dvh)` ← detail fix C3 folded in |
| `.mob-drawer` | bottom-sheet → BASE; **drop the desktop right-drawer variant — dead code** (unreachable ≥md since `.mob-trigger` hidden) | — |

Also during this phase: delete dead `.btn-sm` rule (:96) and `.feature-inner` from the :475 selector list; update `.prose h2 { scroll-margin-top: var(--header-h) }` (:525).

**Critical risks:**
- `.cart-wrap`/`.prose-wrap` grids carry `align-items:start` (:391, :512) — this is what makes sticky children work (skill failure #12). Preserve it in the desktop tier or add `align-self:start` to sticky children (plan does both for `.summary`/`.prose-toc`).
- Selectors changing at multiple tiers (`.footer-top`, `.facts-grid`, `.gallery`) must repeat the property at each tier.
- No component reads breakpoints in JS (verified — zero `matchMedia`/`innerWidth`), so this is CSS-only.

## Phase 3 — Responsive images

1. **`scripts/optimize-images.mjs`**: per source, emit `sharp().resize({width: w, withoutEnlargement: true}).webp({quality: 80})` for w ∈ 400/800/1600 as `<stem>-<w>w.webp`, **plus keep the existing un-suffixed base output** (canonical URL for `product.image`, JSON-LD `structured-data.ts:77`, OG). Naming uses `w` suffix (`kubek-2-400w.webp`) to avoid colliding with the `-<index>` filename convention.
2. **`src/lib/images.ts`** (new): `srcSet('/uploads/kubek-2.webp')` → `"/uploads/kubek-2-400w.webp 400w, …-800w.webp 800w, …-1600w.webp 1600w"`; `smallest(base)` → the `-400w` path.
3. Call-sites (plain `<img>` — next/image deliberately not used on OpenNext/Cloudflare):
   - `ProductTile.tsx:38`: + `srcSet` + `sizes="(min-width:1101px) 25vw, (min-width:561px) 33vw, 50vw"` (keep `loading="lazy"`)
   - `page.tsx:68` hero: + srcset, `sizes="(min-width:861px) 50vw, 100vw"` (keep `width/height/fetchPriority="high"`, no lazy)
   - `page.tsx:103` collection covers, `page.tsx:126` + `o-studiu/page.tsx:45` story art: `sizes="(min-width:861px) 50vw, 100vw"`
   - `Lightbox.tsx:148`: `sizes="(min-width:861px) min(50vw, 460px), 100vw"`
   - `CartView.tsx:279` cart thumb (72/96px box): `src={smallest(p.image)}` directly, no srcset
4. Run `npm run optimize-images` (requires gitignored `design/uploads/` present locally) and commit all generated variants.
5. `product.image` strings stay unchanged → `products.test.ts` / `structured-data.test.ts` / e2e fixtures unaffected (e2e selects by `data-testid`, verified no path assertions).

## Phase 4 — Remaining details

- OG fix: `layout.tsx:44` `/uploads/kubek-01.webp` → `/uploads/kubek-1.webp`
- (`--header-h` token + geowidget cap + dedupe already folded into Phases 1–2)

## Verification

1. **After-screenshots**: same Playwright fallback spec, same pages/widths; compare against baseline pixel-by-pixel by eye — layout must be identical at 375/768/1024/1440 (the conversion is behavior-preserving except geowidget height on short viewports).
2. **Drag test** (skill principle #5): DevTools responsive mode, 280px→2560px continuous on `/` and `/kubki`; watch 561/861/981/1101 transitions and in-between widths (843px, 900px, 1099px) for flicker/overflow; confirm gallery 2→3→4 and sticky summary engages only ≥1101px.
3. **Pre-flight scan** (skill checklist) on the diff: zero `max-width` queries remain; sticky has `align-self:start`; no new `100vh`/z-index/sub-16px inputs.
4. **Gates**: `npm run lint`, `npm run test` (vitest), `npm run build`. Check `.github/workflows/` directly for the exact CI gate set (Plan agent couldn't read it — sandbox path collision). E2e locally: `$env:PLAYWRIGHT_BASE_URL="http://localhost:3000"; npm run test:e2e` (@ci grep; default baseURL is PRODUCTION — never run destructive e2e against it from here).
5. **Images**: verify in DevTools Network panel that a 375px viewport downloads `-400w`/`-800w` variants on `/kubki`, and that JSON-LD still emits the base URL (view-source).
6. Offer the user the responsive-craft live preview (`node C:/Users/Komp/.claude/skills/responsive-craft/scripts/preview.js http://localhost:3000`) — this tool works without dev-browser.

## Execution order

1. Phase 1 (token + baseline snapshots) → 2. Phase 2 (CSS conversion incl. folded detail fixes, section-by-section) → 3. after-snapshots + drag test → 4. Phase 3 (images pipeline, independent) → 5. Phase 4 (OG fix) → 6. full gate run.

Suggested branching: single branch `feat/responsive-mobile-first` (CSS conversion + details) — images could be a second PR if the artifact diff (~264 files) should be reviewed separately, but a single PR is acceptable since image files are mechanical artifacts.

## Notes / non-goals

- No container queries (single-context components), no auto-fit gallery (explicit counts chosen), no @layer/architecture refactor, no next/image.
- Small uppercase text (announce 12px, footer 11px) left as-is — deliberate condensed-label design.
- Memory gotcha: subagents must NOT take git actions; controller commits by explicit path.
