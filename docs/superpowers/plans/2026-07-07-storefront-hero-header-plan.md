# Homepage Hero + Shrinking Header (Spec D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shrinking-on-scroll header and a modest 2–3 beat scroll narrative on the homepage hero, keeping the `/sklep` CTA above the fold and all motion reduced-motion-safe.

**Architecture:** Both effects are native CSS scroll timelines (`scroll()` for the header, `view()` for hero parallax/beats) in `motion.css`, `@supports`-gated, and auto-disabled under reduced motion by Spec A's universal `animation-timeline:none` reset. The header keeps its existing `HeaderHeightProbe` (live height tracking stays correct). The hero gains a revealing macro band reusing an existing image.

**Tech Stack:** CSS scroll-driven animations, Next.js server components, next-intl, Playwright (`@ci`), Spec A `.reveal`.

**Spec:** `docs/superpowers/specs/2026-07-07-storefront-hero-header-design.md`
**Depends on:** Spec A (`.reveal`, the reduced-motion `animation-timeline:none` reset).

## Global Constraints

- **Do not modify `src/styles/tokens.css`.** Build stays **`next build --webpack`**. Styling stays **plain CSS**.
- Hero art stays native `<img>` with `srcSet()`. Uses existing images only (no new photography).
- Mobile-first; **`prefers-reduced-motion` respected** — relies on Spec A's universal reset, no per-effect duplication.
- **CTA-visibility guardrail (conversion-critical):** the `/sklep` CTA must be in the first viewport at every breakpoint, before any scroll.

---

## File Structure

- **Modify** `src/styles/motion.css` — header shrink + hero parallax scroll animations.
- **Modify** `src/styles/site.css` — `.header-inner`/`.brand img` shrink hooks; `.hero-beat` layout.
- **Modify** `src/app/[locale]/page.tsx` — hero beat-2 band + `.reveal` cascade on lower sections.
- **Modify** `messages/{pl,en,es,de}.json` — two `home` keys for the beat caption/alt.
- **Create** `e2e/hero-header.spec.ts` — `@ci` header-shrink + CTA-guardrail + reduced-motion tests.

Two independent reviewer gates: Task 1 (header) and Task 2 (hero). They may ship as one PR or two.

---

### Task 1: Shrinking header

**Files:**
- Modify: `src/styles/motion.css`
- Test: `e2e/hero-header.spec.ts` (create)

**Interfaces:**
- Consumes: existing sticky `#site-header`, `.header-inner` (padding `16px var(--gut)`), `.brand img` (48px). Spec A's reduced-motion reset.
- Produces: `@keyframes hdr-shrink`, `@keyframes hdr-logo`.

- [ ] **Step 1: Write the failing tests**

Create `e2e/hero-header.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

// @ci
test('header shrinks on scroll', async ({ page }) => {
  await page.goto('/');
  const header = page.locator('#site-header');
  const tall = (await header.boundingBox())!.height;
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(150);
  const short = (await header.boundingBox())!.height;
  expect(short).toBeLessThan(tall);
});

test('header does not shrink under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const header = page.locator('#site-header');
  const tall = (await header.boundingBox())!.height;
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(150);
  expect((await header.boundingBox())!.height).toBe(tall);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npx playwright test e2e/hero-header.spec.ts -g "header"` (against local `npm run dev`).
Expected: "header shrinks on scroll" FAILS — height is constant.

- [ ] **Step 3: Add the shrink animations to `src/styles/motion.css`**

Append (both effects share the same `scroll()` timeline over the first 80px; reduced-motion is handled by Spec A's universal `animation-timeline:none !important`):

```css
/* Shrinking header (Spec D). Padding + logo scale down over the first 80px of
   scroll. HeaderHeightProbe keeps --header-h in sync (correct: the header is
   shrunk exactly when scrolled). Reduced-motion off via Spec A's reset. */
@supports (animation-timeline: scroll()) {
  .header-inner {
    animation: hdr-shrink linear both;
    animation-timeline: scroll();
    animation-range: 0 80px;
  }
  @keyframes hdr-shrink { to { padding-top: 8px; padding-bottom: 8px; } }

  .brand img {
    animation: hdr-logo linear both;
    animation-timeline: scroll();
    animation-range: 0 80px;
    transform-origin: left center;
  }
  @keyframes hdr-logo { to { transform: scale(.78); } }
}
```

- [ ] **Step 4: Verify tests pass + no scroll jank**

Run: `npx playwright test e2e/hero-header.spec.ts -g "header"`
Expected: both PASS.

Manually confirm (the one documented risk — RO churn from the probe): scroll the homepage up/down; the header shrink is smooth and sticky anchors/TOCs don't jitter. **If jank appears,** switch `hdr-shrink` to animate `transform: scaleY()` instead of padding (compositor-only, no ResizeObserver fire) and accept `--header-h` staying at max — documented fallback in the spec.

- [ ] **Step 5: Build + commit**

```bash
npm run lint && npm run build
git add src/styles/motion.css e2e/hero-header.spec.ts
git commit -m "feat(header): shrink-on-scroll via scroll timeline (Spec D)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2: Hero modest scroll narrative

**Files:**
- Modify: `src/app/[locale]/page.tsx`
- Modify: `src/styles/site.css`, `src/styles/motion.css`
- Modify: `messages/{pl,en,es,de}.json`
- Test: `e2e/hero-header.spec.ts` (extend)

**Interfaces:**
- Consumes: `HOME_STORY_IMAGE` (already imported as `storyImage`), Spec A `.reveal`/`.reveal--scale`.
- Produces: `.hero-beat` band; `home.heroBeatCap` / `home.heroBeatAlt` messages.

- [ ] **Step 1: Write the failing tests (extend the spec file)**

Append to `e2e/hero-header.spec.ts`:

```ts
test('hero CTA is in the first viewport before scroll (mobile + desktop)', async ({ page }) => {
  for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(vp);
    await page.goto('/');
    await expect(page.locator('.hero-actions .btn-primary')).toBeInViewport();
  }
});

test('hero beat caption renders and is visible under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.hero-beat-cap')).toBeVisible();
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npx playwright test e2e/hero-header.spec.ts -g "beat caption"`
Expected: FAIL — no `.hero-beat-cap`.

- [ ] **Step 3: Add the two message keys to all four files**

In `messages/{pl,en,es,de}.json`, add to the existing `"home"` object:

`pl.json`: `"heroBeatCap": "Każda praca powstaje w całości ręcznie — od toczenia po ostatni pociągnięcie pędzla.", "heroBeatAlt": "Detal szkliwa z bliska"`
`en.json`: `"heroBeatCap": "Every piece is made entirely by hand — from the wheel to the final brushstroke.", "heroBeatAlt": "Close detail of the glaze"`
`es.json`: `"heroBeatCap": "Cada pieza se hace enteramente a mano — desde el torno hasta la última pincelada.", "heroBeatAlt": "Detalle del esmalte de cerca"`
`de.json`: `"heroBeatCap": "Jedes Stück entsteht vollständig von Hand — von der Drehscheibe bis zum letzten Pinselstrich.", "heroBeatAlt": "Nahaufnahme der Glasur"`

- [ ] **Step 4: Add the beat band to `page.tsx`**

In `src/app/[locale]/page.tsx`, immediately after the hero `</section>` (line 85) and before `<Marquee …/>`, insert:

```tsx
      {/* ── HERO BEAT 2 — macro reveal (Spec D) ──────────────────── */}
      <section className="hero-beat">
        <div className="hero-beat-inner">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="reveal reveal--scale" src={storyImage.src} srcSet={srcSet(storyImage.src)} sizes="(min-width:861px) 60vw, 100vw" alt={t('home.heroBeatAlt')} width={storyImage.width} height={storyImage.height} />
          <p className="hero-beat-cap reveal">{t('home.heroBeatCap')}</p>
        </div>
      </section>
```

- [ ] **Step 5: Add `.reveal` cascade to lower sections**

In `page.tsx`, add ` reveal` to the `className` of the sections **below the fold** (leave the hero untouched so the CTA never starts hidden): the collections `<section className="section collections">` (line 91), editorial (line 127), studio story (line 137), and craft (line 164). Example for collections:

```tsx
      <section className="section collections reveal">
```

- [ ] **Step 6: Style the beat band + parallax**

Append to `src/styles/site.css`:

```css
/* ─── Hero beat band (Spec D) ─────────────────────────────────── */
.hero-beat { background: var(--c-cream); padding: 0 var(--gut) clamp(48px,7vw,96px); }
.hero-beat-inner { max-width: var(--max); margin: 0 auto; display: grid; gap: 18px; justify-items: center; }
.hero-beat-inner img { width: min(100%, 720px); height: auto; border-radius: var(--r-sharp); }
.hero-beat-cap { max-width: 40ch; text-align: center; font-family: var(--f-display); font-style: italic; font-size: clamp(18px,2.4vw,26px); line-height: 1.4; color: var(--c-espresso-muted); margin: 0; }
```

Append to `src/styles/motion.css`:

```css
/* Subtle hero-art parallax (Spec D). Baked scale keeps edges covered while it
   translates. Reduced-motion off via Spec A's reset. */
@supports (animation-timeline: view()) {
  .hero-art img {
    animation: hero-par linear both;
    animation-timeline: view();
    animation-range: cover;
  }
  @keyframes hero-par {
    from { transform: scale(1.06) translateY(-3%); }
    to   { transform: scale(1.06) translateY(3%); }
  }
}
```

Confirm `srcSet` is imported in `page.tsx` (it already is, used by the hero art).

- [ ] **Step 7: Run tests + lint + build + preview, then commit**

```bash
npx playwright test e2e/hero-header.spec.ts
npm run lint && npm run build && npm run preview:cf
```
Expected: all tests PASS (CTA in viewport both sizes; caption visible under reduced motion); production preview renders the hero + shrinking header correctly.

```bash
git add src/app/[locale]/page.tsx src/styles/site.css src/styles/motion.css messages e2e/hero-header.spec.ts
git commit -m "feat(home): modest hero scroll narrative + parallax (Spec D)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Modest 2–3 beat narrative, hero ~1.3–1.5 viewport → hero (beat 1) + `.hero-beat` macro reveal (beat 2) + caption (beat 3), Task 2. ✓
- CTA-visibility guardrail → hero untouched + `toBeInViewport` test, Task 2 Steps 1/5. ✓
- Macro asset = reuse existing image → `storyImage`, Task 2 Step 4. ✓
- Shrinking header via `animation-timeline: scroll()`, ~80px, padding + logo → Task 1. ✓
- HeaderHeightProbe interaction (live-track correct, no loop) + transform fallback → Task 1 Step 4. ✓
- Reveal cascade on lower sections → Task 2 Step 5. ✓
- `@supports` gate + reduced-motion via Spec A reset → Tasks 1/2 (no duplicated reduced-motion rules). ✓
- Full pinned scrollytelling excluded → not built. ✓

**2. Placeholder scan:** No TBD/TODO. The jank fallback (Task 1 Step 4) is a documented conditional with concrete instructions, not a placeholder. All copy is supplied for four locales.

**3. Type consistency:** `#site-header`, `.header-inner`, `.brand img`, `.hero-actions .btn-primary`, `.hero-beat-cap` names match between the CSS, `page.tsx` edits, and the tests. `home.heroBeatCap`/`home.heroBeatAlt` keys match between the message files (Step 3) and `page.tsx` usage (Step 4). ✓

---

## Note on the whole set

This is the last of the four plans (build order A → C → B → D). All four are in `docs/superpowers/plans/`. Each spec's success metric (add-to-cart, PDP→checkout, collection bounce, hero CTR) has its instrumentation deferred to a follow-up per the round's decision; wire the GA4 `site_engagement`/`engagement_type` events when measuring each surface's before/after.
