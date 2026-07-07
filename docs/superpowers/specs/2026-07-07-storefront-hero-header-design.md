# Spec D — Homepage hero (modest scroll narrative) + shrinking header

**Status:** validated design (brainstormed 2026-07-07), not yet implemented.
**Part of:** 2026 Storefront Upgrade (see `docs/plans/2026-storefront-upgrade.md` index). Build order **A → C → B → D** (last); D consumes Spec A's `.reveal` + scroll-timeline patterns.
**Primary success criterion:** conversion — the homepage's job is to route visitors to `/sklep`; premium feel must not cost CTA reach. Lowest direct-conversion-leverage surface in the upgrade, so it ships last.

## Hard constraints (inherited)

- No `tokens.css` changes. Build stays `next build --webpack`. Mobile-first. `prefers-reduced-motion` respected (via Spec A).
- Hero art stays native `<img>` with `srcSet()`.
- **CTA-visibility guardrail (conversion-critical):** the primary "browse all" CTA (→ `/sklep`) must render **within the first viewport at every breakpoint**. The hero's added height is *scroll-revealed*; it must not push the CTA off the initial paint.

## Grounding (current state)

- `src/app/[locale]/page.tsx` hero: `.hero > .hero-inner > .hero-copy` (eyebrow, `<h1>`, sub, single `.btn-primary` → `/sklep`) + `.hero-art` (one `kubek-2.webp` `<img>` + `.hero-art-meta`). Then `<Marquee>`, collections grid, editorial, story, craft, contact.
- `Header.tsx` (server): a `.announce` bar that **scrolls away** + a sticky `#site-header .header` (`.header-inner`: nav-left, MobileMenu, brand, nav-right).
- `HeaderHeightProbe.tsx` (client): measures `#site-header` height via `ResizeObserver`, publishes `--header-h`; consumed by sticky TOCs (`.summary`, `.prose-toc`) and anchor `scroll-margin-top`. The `.announce` bar is deliberately excluded.
- Editorial/story images exist (`HOME_EDITORIAL_IMAGE`, `HOME_STORY_IMAGE`); there is no dedicated macro/brushstroke asset yet.

---

## §1 · Hero — modest scroll narrative (2–3 beats)

The hero grows to **~1.3–1.5 viewports** and reveals in beats as the user scrolls, all via native CSS scroll timelines (Spec A patterns), degrading to static and disabled under reduced-motion.

- **Beat 1 — initial paint (≈ first viewport):** current hero — eyebrow, title, sub, **CTA**, and the art. Satisfies the CTA guardrail: everything needed to click through is here before any scroll.
- **Beat 2 — macro detail (≈ 40–80% of hero scroll):** a close/brushstroke image `.reveal--scale`s + parallaxes in via `animation-timeline: view()`, giving the "tactile" reveal.
- **Beat 3 — caption → handoff (≈ 80–100%):** a short caption/eyebrow reveals and the section resolves into the marquee + collections grid.

**Content dependency (flagged, not invented):** Beat 2 needs a macro/brushstroke shot. Default to **reusing an existing asset** (`HOME_EDITORIAL_IMAGE`/`HOME_STORY_IMAGE` or a gallery macro) unless the studio supplies a dedicated one. The spec names the need; it does not require a new asset to ship.

**Markup:** restructure the `.hero` section in `page.tsx` to a taller narrative container with scroll-driven child elements; CSS in `site.css`/`motion.css`. Copy stays in i18n (new keys for the caption if added).

## §2 · Shrinking header

Shrink `#site-header` on scroll via `animation-timeline: scroll()` — reduce vertical padding + logo/brand scale so the bar gets shorter, completing within the **first ~80px** of scroll (small, fast range). The header stays `position: sticky` (required for the scroll-driven range).

### Interaction with HeaderHeightProbe (the real complexity)

The probe keeps live-tracking `#site-header` height via `ResizeObserver`. This is **functionally correct**: the header is shrunk exactly when the user is scrolled down, so a live `--header-h` stays right for both consumers — anchor `scroll-margin-top` lands targets just below the (then-shrunk) header, and sticky TOCs stick at the correct offset. **No feedback loop exists** — the header does not consume its own `--header-h`.

**The only risk is scroll-time RO churn** (RO firing per frame while the padding animates, updating a var a few sticky elements read). Mitigations:
- Keep the shrink range small and fast (~80px) so churn is brief.
- The sticky consumers are few and cheap; verify no visible jank.
- **Fallback if jank appears:** shrink via `transform` (compositor-only, no RO fire) and pin `--header-h` to the max height, accepting a small over-offset gap when scrolled. Documented, not default.

Under `prefers-reduced-motion`, the header stays full-size (no shrink). Gated by `@supports (animation-timeline: scroll())`; where unsupported, header stays full-size (harmless).

## §3 · Motion / fallback / reduced-motion

- All scroll effects use Spec A's `@supports`-gated patterns; unsupported engines render the **static final state** (hero at natural height, header full). No polyfill, no JS.
- Reveal cascade down the homepage sections (collections, editorial, story, craft) reuses Spec A `.reveal` with stagger.
- `prefers-reduced-motion: reduce` → hero static (no parallax/beats), header no shrink, reveals off — all via Spec A's hardened block.

## Success metric (lightweight)

- Target: **hero CTA click-through to `/sklep`** (must not drop vs. current) and homepage scroll-depth/engagement.
- Guardrail metric: hero-CTA CTR is the gate — if the narrative reduces it, revert to Spec A's "enhance in place" (subtle reveal only). 
- Instrumentation: hero-CTA click via the existing GTM/GA4 layer (or a `site_engagement` `engagement_type`). **Event wiring deferred to the impl plan.**

## Verification

1. **CTA guardrail:** Playwright at mobile + desktop viewports — the `/sklep` CTA is visible in the initial viewport **before any scroll**.
2. **Reduced-motion:** with `prefers-reduced-motion` emulated, the hero is at static height, the header does not shrink, and no scroll-driven animation runs.
3. **Header offsets:** anchor navigation + sticky TOC land at the correct offset in both header states (top and scrolled). 
4. **Production:** `npm run preview:cf` renders the hero + header correctly under the Workers runtime.

## Risks

- **Narrative buries the CTA / hurts click-through.** Mitigation: the CTA guardrail (§ constraints + verification) + the CTR gate to revert.
- **RO churn jank on the shrinking header.** Mitigation + documented transform fallback (§2).
- **Missing macro asset.** Mitigation: reuse an existing image (§1).
- **Taller hero adds CLS / scroll cost on mobile.** Mitigation: reserve hero height; Spec A from-state gate prevents reveal CLS.

## Out of scope for Spec D

- Full pinned scrollytelling over 2–3 viewports (rejected — buries the CTA).
- Collection/PDP surfaces (Specs B/C).
- New photography commissioning (uses existing assets unless the studio supplies more).
