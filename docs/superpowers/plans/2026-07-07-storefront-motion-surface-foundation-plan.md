# Motion & Surface Foundation (Spec A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the cross-cutting CSS primitives (scroll-entry reveal, soft-edge fade, generated grain) and a hardened reduced-motion baseline that Specs B/C/D consume.

**Architecture:** One new plain-CSS file `src/styles/motion.css`, imported after `site.css`; scroll-driven rules are `@supports`-gated and degrade to the static final state; the reveal's hidden "from" state lives only inside the feature query so unsupported engines never hide content. Reduced-motion hardening extends the existing block in `site.css`. **No JavaScript in this layer.**

**Tech Stack:** Plain CSS (custom properties, `@supports`, `animation-timeline: view()`, `mask-image`, inline SVG `feTurbulence`), Next.js App Router CSS import, Playwright for the one guard test.

**Spec:** `docs/superpowers/specs/2026-07-07-storefront-motion-surface-foundation-design.md`

## Global Constraints

- **Do not modify `src/styles/tokens.css`** — no new palette/typeface tokens; compose existing `--c-*`, `--f-*`, `--ease`, `--section-y`, `--gut`.
- Build stays **`next build --webpack`** — never Turbopack.
- Styling stays **plain CSS** with the existing token system — no CSS-in-JS.
- Mobile-first; **`prefers-reduced-motion` respected** for all motion.
- **No `scroll-timeline-polyfill`, no JS in this layer.** Feature-gate on `@supports`; degrade to the static final state.

---

## File Structure

- **Create** `src/styles/motion.css` — the reveal / edge-fade / grain primitives. One responsibility: cross-cutting motion + surface utilities.
- **Modify** `src/app/[locale]/layout.tsx:1-3` — add the `motion.css` import after `site.css`.
- **Modify** `src/styles/site.css:1059-1068` — harden the existing reduced-motion block for scroll-driven animations and the new `.reveal` class.
- **Create** `e2e/motion-foundation.spec.ts` — one guard test for the from-state-inside-`@supports` correctness rule + reduced-motion degradation.

This is a single reviewable deliverable (the foundation), so it is one task with bite-sized steps.

---

### Task 1: Motion & surface foundation

**Files:**
- Create: `src/styles/motion.css`
- Modify: `src/app/[locale]/layout.tsx:1-3`
- Modify: `src/styles/site.css:1059-1068`
- Test: `e2e/motion-foundation.spec.ts`

**Interfaces:**
- Consumes: nothing (foundation layer).
- Produces (later specs rely on these exact names):
  - CSS class `.reveal` (+ modifier `.reveal--scale`, custom prop `--reveal-delay`) — scroll-entry reveal.
  - CSS class `.edge-fade-x` (custom prop `--edge`) — horizontal soft-edge mask.
  - CSS class `.surface-grain` (custom prop `--grain-opacity`) — generated grain surface.
  - `@keyframes reveal`.

- [ ] **Step 1: Write the failing guard test**

Create `e2e/motion-foundation.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

// @ci
// Spec A guard: the reveal primitive must (1) stay visible under reduced motion,
// and (2) start hidden ONLY where animation-timeline is supported — the rule
// that prevents FOUC/CLS in non-supporting engines.
test.describe('Spec A — motion foundation', () => {
  test('reveal degrades to visible under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const opacity = await page.evaluate(() => {
      const el = document.createElement('div');
      el.className = 'reveal';
      el.textContent = 'x';
      document.body.appendChild(el);
      return getComputedStyle(el).opacity;
    });
    expect(opacity).toBe('1');
  });

  test('reveal is hidden pre-scroll only where animation-timeline is supported', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    const { supported, opacity } = await page.evaluate(() => {
      const supported = CSS.supports('animation-timeline: view()');
      const el = document.createElement('div');
      el.className = 'reveal';
      el.textContent = 'x';
      el.style.marginTop = '300vh'; // far below the fold: not yet entered the view timeline
      document.body.appendChild(el);
      return { supported, opacity: getComputedStyle(el).opacity };
    });
    if (supported) expect(Number(opacity)).toBeLessThan(1);
    else expect(opacity).toBe('1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (against a local dev server — start `npm run dev` in another shell; mirror the base-URL wiring the repo's existing `@ci` specs use in `playwright.config.ts`):

```bash
npx playwright test e2e/motion-foundation.spec.ts
```

Expected: the second test **FAILS** in Chromium — `animation-timeline: view()` is supported, but `.reveal` has no styles yet, so computed opacity is `1` (not `< 1`).

- [ ] **Step 3: Create `src/styles/motion.css`**

```css
/* ============================================================
   Motion & surface foundation (Spec A). Composes existing tokens;
   no new palette/type. Scroll-driven effects are @supports-gated and
   degrade to the static final state. Reduced-motion is handled in
   site.css's reduced-motion block.
   ============================================================ */

/* Scroll-entry reveal. The hidden "from" state lives ONLY inside @supports so
   non-supporting engines (Firefox, older Safari) and any no-JS paint render the
   final visible state — no FOUC, no CLS. */
@supports (animation-timeline: view()) {
  .reveal {
    opacity: 0;
    transform: translateY(16px);
    animation: reveal linear both;
    animation-timeline: view();
    animation-range: entry 0% cover 30%;
    animation-delay: var(--reveal-delay, 0s);
  }
  .reveal--scale { transform: translateY(16px) scale(.97); }
  @keyframes reveal { to { opacity: 1; transform: none; } }
}

/* Soft edge fade for horizontal scrollers. Mask, not overlay — pointer events
   untouched. Broadly supported; where absent, no fade (harmless). */
.edge-fade-x {
  --edge: 24px;
  -webkit-mask-image: linear-gradient(to right, transparent, #000 var(--edge), #000 calc(100% - var(--edge)), transparent);
          mask-image: linear-gradient(to right, transparent, #000 var(--edge), #000 calc(100% - var(--edge)), transparent);
}

/* Generated grain for tactile warmth. Desaturated noise behind content,
   non-interactive, static, faint. Dial via --grain-opacity; set 0 to disable. */
.surface-grain { position: relative; isolation: isolate; }
.surface-grain::before {
  content: "";
  position: absolute; inset: 0;
  pointer-events: none; z-index: -1;
  opacity: var(--grain-opacity, .05);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-size: 180px 180px;
}
```

- [ ] **Step 4: Import `motion.css` after `site.css`**

Modify `src/app/[locale]/layout.tsx` — the first three lines are the CSS imports. Add the fourth:

```ts
import '@/styles/fonts.css';
import '@/styles/tokens.css';
import '@/styles/site.css';
import '@/styles/motion.css';
```

- [ ] **Step 5: Harden the reduced-motion block in `site.css`**

Replace the existing block at `src/styles/site.css:1059-1068` with (adds `animation-timeline:none` to the universal reset and resets the new `.reveal` classes alongside the existing `.fade-in`):

```css
@media (prefers-reduced-motion: reduce) {
  *,*::before,*::after {
    animation-duration:.01ms !important;
    animation-iteration-count:1 !important;
    animation-timeline:none !important;
    transition-duration:.01ms !important;
    scroll-behavior:auto !important;
  }
  .marquee-track { animation:none; }
  .fade-in, .reveal, .reveal--scale { opacity:1; transform:none; transition:none; }
}
```

- [ ] **Step 6: Run the guard test + lint + build**

```bash
npx playwright test e2e/motion-foundation.spec.ts
npm run lint
npm run build
```

Expected: both tests **PASS**; lint clean; `next build --webpack` completes (the new import resolves, no CSS syntax errors).

- [ ] **Step 7: Commit**

```bash
git add src/styles/motion.css src/styles/site.css src/app/[locale]/layout.tsx e2e/motion-foundation.spec.ts
git commit -m "feat(storefront): motion & surface foundation (Spec A)

Reveal / edge-fade / grain primitives + hardened reduced-motion.
No JS; scroll effects @supports-gated, degrade to static.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- §1 reduced-motion + `@supports` hardening → Step 5 (block) + `@supports` wrapper in Step 3. ✓
- §2 reveal primitive (`.reveal`/`.reveal--scale`/`--reveal-delay`, from-state inside `@supports`) → Step 3. ✓
- §3 soft-edge fade (`.edge-fade-x`/`--edge`) → Step 3. ✓
- §4 texture (`.surface-grain`/`--grain-opacity`, generated SVG, no asset) → Step 3. ✓
- Deliverable = one new file + import + block edit → File Structure + Task 1. ✓
- Verification (reduced-motion visible; degradation visible) → Steps 1/2/6 guard test. ✓
- Shrinking header / view transitions **out of scope** (Specs D/C) → not included. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/vague steps — all CSS and commands are literal. The only external reference is the repo's `playwright.config.ts` base-URL convention (Step 2), which is an existing project fact, not a placeholder.

**3. Type consistency:** Class/prop names produced (`.reveal`, `.reveal--scale`, `--reveal-delay`, `.edge-fade-x`, `--edge`, `.surface-grain`, `--grain-opacity`, `@keyframes reveal`) are identical in `motion.css` (Step 3) and the reduced-motion reset (Step 5), and match the Interfaces block. ✓

**Note on scope:** the spec states A's fuller behavioral test lands with its first consumer (B or C). This plan ships the one high-value guard (the from-state correctness rule); the consumer specs' plans add reveal-in-context assertions.
