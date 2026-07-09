import { test, expect } from '@playwright/test';

// Spec A guard: the reveal primitive must (1) stay visible under reduced motion,
// and (2) start hidden ONLY where animation-timeline is supported — the rule
// that prevents FOUC/CLS in non-supporting engines.
// NOTE: `@ci` MUST be in the describe/test TITLE — `npm run test:e2e` runs
// `playwright test --grep @ci`, which matches titles, not comments.
test.describe('@ci Spec A — motion foundation', () => {
  test('reveal degrades to visible under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    // Synthetic probe: tests the primitive in isolation, independent of the
    // page's own .reveal nodes (the homepage gained some in Spec D). Native
    // toHaveCSS gives Playwright auto-retry.
    await page.evaluate(() => {
      const el = document.createElement('div');
      el.id = 'reveal-probe';
      el.className = 'reveal';
      el.textContent = 'x';
      document.body.appendChild(el);
    });
    await expect(page.locator('#reveal-probe')).toHaveCSS('opacity', '1');
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
