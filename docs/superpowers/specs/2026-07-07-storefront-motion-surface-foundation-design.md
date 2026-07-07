# Spec A — Motion & Surface Foundation

**Status:** validated design (brainstormed 2026-07-07), not yet implemented.
**Part of:** the **2026 Storefront Upgrade** — a four-spec set in this directory (A motion foundation · C PDP transparency + morph · B collection bento · D hero + header). No separate index doc is tracked on this branch yet. Build order: **A → C → B → D**. This is the enabling layer; B/C/D consume its primitives.
**Success criterion for the whole upgrade:** conversion (add-to-cart rate, PDP→checkout completion, collection-page bounce). Visual polish is in service of that, not the point of it.

## Purpose

Ship the cross-cutting CSS primitives the per-surface redesigns (B collection, C PDP, D hero/header) all depend on: a hardened reduced-motion / feature-detection baseline, a reusable scroll-entry reveal, a soft-edge scroll fade, and a texture surface. Landing these once, correctly, keeps the surface specs free of duplicated motion plumbing and guarantees a single canonical reduced-motion policy.

A is **independently shippable but visually inert** until B/C/D apply its classes. That is expected — it is a foundation, and its own PR changes no visible surface.

## Hard constraints (inherited, non-negotiable)

- **No changes to `src/styles/tokens.css`** — no new palette/typeface tokens. Everything composes existing `--c-*`, `--f-*`, `--ease`, `--section-y`, `--gut`.
- Build stays `next build --webpack`.
- Mobile-first; `prefers-reduced-motion` respected for all motion.
- **No `scroll-timeline-polyfill`, no JS in this layer.** Feature-gate on `@supports`; degrade to the static final state.

## Existing state (grounding)

- A `@media (prefers-reduced-motion: reduce)` block already exists at `src/styles/site.css:1058` — it globally forces `animation-duration:.01ms` / `transition-duration:.01ms` and already resets a `.fade-in` class. A **extends this block**; it does not fork a second one.
- No `animation-timeline` / `view-transition` / `mask-image` usage exists anywhere yet — this layer is greenfield.
- Global CSS import order in `src/app/[locale]/layout.tsx` is `fonts.css → tokens.css → site.css`. A new `motion.css` is imported **after** `site.css`.

## Deliverable

One new file `src/styles/motion.css` (~60–100 lines), imported after `site.css` in `src/app/[locale]/layout.tsx`, plus the additions to the existing reduced-motion block in `site.css`. No component/TSX changes in Spec A.

---

## §1 · Reduced-motion + `@supports` hardening

**Problem:** the existing reduced-motion kill uses `animation-duration:.01ms !important`, which does **not** neutralize a *scroll-linked* animation (its progress is bound to scroll position, not time). Without an explicit reset, reduced-motion users would still get scroll-driven movement.

**Design:** extend the existing block at `site.css:1058` to also reset scroll-driven animations to their final state:

```css
@media (prefers-reduced-motion: reduce) {
  /* …existing rules stay… */
  *, *::before, *::after { animation-timeline: none !important; }
  .reveal, .reveal--scale { opacity: 1 !important; transform: none !important; }
}
```

All scroll-driven rules in `motion.css` are wrapped in `@supports (animation-timeline: view())`.

## §2 · Reveal primitive — `.reveal`

The shared scroll-entry animation that B/C/D apply to grid items, PDP blocks, and hero elements. Unifies the ad-hoc `.fade-in` the reduced-motion block already references.

**Critical correctness rule — the hidden "from" state lives *only inside* the `@supports` block.** Browsers without `animation-timeline` support (Firefox, older Safari) and any no-JS/SSR paint must render the **final, visible** state. Defining `opacity:0` outside the feature query would hide content forever in those engines. This guarantees **no FOUC and no CLS**.

```css
@supports (animation-timeline: view()) {
  .reveal {
    opacity: 0;
    transform: translateY(16px);
    animation: reveal linear both;
    animation-timeline: view();
    animation-range: entry 0% cover 30%;
    animation-delay: var(--reveal-delay, 0s); /* stagger hook for grids */
  }
  .reveal--scale { transform: translateY(16px) scale(.97); }
  @keyframes reveal { to { opacity: 1; transform: none; } }
}
```

Notes:
- Scroll-linked animations are **linear** (progress tracks scroll position); `--ease` is not used here — pacing comes from `animation-range`, not a timing function.
- `.fade-in` is reconciled: either re-pointed to `.reveal` at its call sites, or kept as a thin alias. Chosen at implementation; the reduced-motion reset covers both.

## §3 · Soft-edge fade — `.edge-fade-x`

A mask-based fade at the edges of horizontal scrollers to signal overflow organically, without an overlay that would eat pointer events. Targets: the collection family switcher (`.shop-switch`), the PDP "more from this collection" strip.

```css
.edge-fade-x {
  --edge: 24px;
  -webkit-mask-image: linear-gradient(to right, transparent, #000 var(--edge), #000 calc(100% - var(--edge)), transparent);
          mask-image: linear-gradient(to right, transparent, #000 var(--edge), #000 calc(100% - var(--edge)), transparent);
}
```

No JS, no `@supports` gate required (mask-image is broadly supported; where absent, the fade is simply skipped with no harm). Pointer events unaffected.

## §4 · Texture surface — `.surface-grain`

A very subtle generated grain for tactile warmth, opt-in per surface (B/C/D choose where — e.g. editorial/story bands). **CSS/SVG-generated — no raster asset, no extra request, no `optimize-images` step.**

```css
.surface-grain { position: relative; isolation: isolate; }
.surface-grain::before {
  content: ""; position: absolute; inset: 0; pointer-events: none; z-index: -1;
  opacity: var(--grain-opacity, .05);
  background-image: url("data:image/svg+xml,…feTurbulence baseFrequency=0.9 numOctaves=2…");
  background-size: 180px 180px;
}
```

Grain sits **behind** content (`z-index:-1` under `isolation:isolate`), composes the existing surface color underneath, and is static (no reduced-motion concern). Tunable/deniable via `--grain-opacity`. Kept deliberately faint to protect legibility; dial to 0 to disable.

## Out of scope for Spec A

- **Shrinking header** (`animation-timeline: scroll()`) — owned entirely by **Spec D**, because it is coupled to `Header.tsx` and the existing `HeaderHeightProbe`. A does not ship a dangling header primitive.
- **View Transitions** (`view-transition-name`, focus routing) — owned by **Spec C** (PDP morph).
- Any per-surface application of these classes — owned by B/C/D.
- IntersectionObserver reveal parity for non-supporting browsers — explicitly not built; documented as a future add-on only if analytics ever justify it.

## Success metric (lightweight)

A has no conversion surface of its own; its target is **zero regression**:
- **CLS ≤ current** on collection and PDP after B/C/D consume `.reveal` (the from-state-inside-`@supports` rule is what protects this).
- Reduced-motion renders **fully static** (no scroll-driven movement).
- **No JS** added by this layer (bundle delta = 0).

No new GA4 event for Spec A. Conversion instrumentation lives in the surface specs (B/C/D).

## Verification

CSS-only, so the runnable check lands with A's **first consumer** (B or C), as a Playwright assertion:
1. With `prefers-reduced-motion: reduce` emulated, `.reveal` elements are visible (`opacity: 1`) with **no** running animation.
2. With the `@supports (animation-timeline: view())` path unavailable, content is present and visible (no hidden from-state) — i.e. no element is stuck at `opacity: 0`.

## Risks

- **Grain overdone → legibility hit.** Mitigation: default `--grain-opacity` ≤ .06, opt-in only, single knob to kill.
- **`.fade-in` reconciliation misses a call site.** Mitigation: grep `fade-in` at implementation; the reduced-motion reset already covers both class names.
