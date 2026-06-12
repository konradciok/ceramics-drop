import { describe, expect, it } from 'vitest';
import { NOINDEX_PATHS, SITE_PATHS } from './site';

describe('site route registry', () => {
  it('publishes the editorial gallery route', () => {
    expect(SITE_PATHS).toContain('/gallery');
    expect(NOINDEX_PATHS).not.toContain('/gallery');
  });
});
