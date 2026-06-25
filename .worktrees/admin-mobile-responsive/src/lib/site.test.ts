import { describe, expect, it } from 'vitest';
import { NOINDEX_PATHS, SITE_PATHS } from './site';
import { VISIBLE_CATEGORY_ORDER, HIDDEN_CATEGORIES } from './products';

describe('site route registry', () => {
  it('publishes the editorial gallery route', () => {
    expect(SITE_PATHS).toContain('/gallery');
    expect(NOINDEX_PATHS).not.toContain('/gallery');
  });

  // SITE_PATHS is kept static (so site.ts stays a dependency-free leaf), so this
  // guards it against drifting from the product registry: every visible family
  // must have a collection route, and no withdrawn family may leak one.
  it('lists exactly the visible collection routes (no drift from HIDDEN_CATEGORIES)', () => {
    for (const slug of VISIBLE_CATEGORY_ORDER) {
      expect(SITE_PATHS, `visible family ${slug} must have a route`).toContain(`/${slug}`);
    }
    for (const slug of HIDDEN_CATEGORIES) {
      expect(SITE_PATHS, `withdrawn family ${slug} must not have a route`).not.toContain(`/${slug}`);
    }
  });
});
