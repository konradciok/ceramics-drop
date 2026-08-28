import { afterEach, describe, expect, it, vi } from 'vitest';
import { CMS_LOCALES, HOME_PAGE_SLUG, type HomePagePayload } from './types';
import { getPreviewContent, getPublishedContent } from './server';
import { fallbackHomePayload, getHomeContent } from './home';

vi.mock('./server', () => ({
  getPreviewContent: vi.fn(),
  getPublishedContent: vi.fn(),
}));

describe('fallbackHomePayload', () => {
  it.each(CMS_LOCALES)('builds a complete payload with no media for %s', (locale) => {
    const payload = fallbackHomePayload(locale);
    expect(payload.heroLine1.length).toBeGreaterThan(0);
    expect(payload.heroLine2.length).toBeGreaterThan(0);
    expect(payload.heroTagline.length).toBeGreaterThan(0);
    expect(payload.ctaLabel.length).toBeGreaterThan(0);
    expect(payload.heroAlt.length).toBeGreaterThan(0);
    expect(payload.media).toEqual({ desktop: null, mobile: null });
  });
});

describe('getHomeContent', () => {
  const makePayload = (label: string): HomePagePayload => ({
    heroLine1: `${label} line1`,
    heroLine2: `${label} line2`,
    heroTagline: `${label} tagline`,
    ctaLabel: `${label} cta`,
    heroAlt: `${label} alt`,
    media: { desktop: null, mobile: null },
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('prefers preview content over published when the token resolves', async () => {
    const preview = makePayload('preview');
    vi.mocked(getPreviewContent).mockResolvedValue(preview);
    vi.mocked(getPublishedContent).mockResolvedValue(makePayload('published'));

    await expect(getHomeContent('en', 'tok')).resolves.toEqual(preview);
    expect(getPreviewContent).toHaveBeenCalledWith('tok', {
      kind: 'page',
      slug: HOME_PAGE_SLUG,
      locale: 'en',
    });
    expect(getPublishedContent).not.toHaveBeenCalled();
  });

  it('returns published content when there is no preview', async () => {
    const published = makePayload('published');
    vi.mocked(getPreviewContent).mockResolvedValue(null);
    vi.mocked(getPublishedContent).mockResolvedValue(published);

    await expect(getHomeContent('pl')).resolves.toEqual(published);
    expect(getPublishedContent).toHaveBeenCalledWith('page', HOME_PAGE_SLUG, 'pl');
  });

  it('falls back to the messages payload when both readers return null (invalid/missing stored payload)', async () => {
    vi.mocked(getPreviewContent).mockResolvedValue(null);
    vi.mocked(getPublishedContent).mockResolvedValue(null);

    await expect(getHomeContent('de')).resolves.toEqual(fallbackHomePayload('de'));
  });

  it('falls back to the messages payload when a reader throws (belt-and-braces — a CMS outage must never break the homepage)', async () => {
    vi.mocked(getPreviewContent).mockRejectedValue(new Error('boom'));
    vi.mocked(getPublishedContent).mockResolvedValue(makePayload('published'));

    await expect(getHomeContent('es', 'tok')).resolves.toEqual(fallbackHomePayload('es'));
  });
});
