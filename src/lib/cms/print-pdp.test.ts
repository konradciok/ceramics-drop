import { afterEach, describe, expect, it, vi } from 'vitest';
import { CMS_LOCALES, PRINT_PDP_SLUG, type PrintPdpPayload } from './types';
import { getPreviewContent, getPublishedContent } from './server';
import { fallbackPrintPdpPayload, getPrintPdpContent, splitParagraphs } from './print-pdp';

vi.mock('./server', () => ({
  getPreviewContent: vi.fn(),
  getPublishedContent: vi.fn(),
}));

describe('fallbackPrintPdpPayload', () => {
  it.each(CMS_LOCALES)('builds a complete non-empty payload for %s', (locale) => {
    const payload = fallbackPrintPdpPayload(locale);
    expect(payload.artist.name).toBe('Anna Ciok');
    expect(payload.artist.bio.length).toBeGreaterThan(20);
    expect(payload.accordions.productDetails.length).toBeGreaterThan(20);
    expect(payload.accordions.framing.length).toBeGreaterThan(20);
    expect(payload.accordions.shipping.length).toBeGreaterThan(20);
  });
});

describe('splitParagraphs', () => {
  it('splits on blank lines and trims', () => {
    expect(splitParagraphs('Pierwszy akapit.\n\n  Drugi akapit. ')).toEqual(['Pierwszy akapit.', 'Drugi akapit.']);
  });

  it('keeps single newlines inside one paragraph', () => {
    expect(splitParagraphs('linia 1\nlinia 2')).toEqual(['linia 1\nlinia 2']);
  });

  it('drops empty segments', () => {
    expect(splitParagraphs('\n\n a \n\n\n\n b \n\n')).toEqual(['a', 'b']);
    expect(splitParagraphs('')).toEqual([]);
    expect(splitParagraphs('   ')).toEqual([]);
  });
});

describe('getPrintPdpContent', () => {
  const makePayload = (label: string): PrintPdpPayload => ({
    artist: { name: `${label} name`, bio: `${label} bio` },
    accordions: {
      productDetails: `${label} details`,
      framing: `${label} framing`,
      shipping: `${label} shipping`,
    },
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('prefers preview content over published when the token resolves', async () => {
    const preview = makePayload('preview');
    vi.mocked(getPreviewContent).mockResolvedValue(preview);
    vi.mocked(getPublishedContent).mockResolvedValue(makePayload('published'));

    await expect(getPrintPdpContent('en', 'tok')).resolves.toEqual(preview);
    expect(getPreviewContent).toHaveBeenCalledWith('tok', {
      kind: 'page',
      slug: PRINT_PDP_SLUG,
      locale: 'en',
    });
    expect(getPublishedContent).not.toHaveBeenCalled();
  });

  it('returns published content when there is no preview', async () => {
    const published = makePayload('published');
    vi.mocked(getPreviewContent).mockResolvedValue(null);
    vi.mocked(getPublishedContent).mockResolvedValue(published);

    await expect(getPrintPdpContent('pl')).resolves.toEqual(published);
    expect(getPublishedContent).toHaveBeenCalledWith('page', PRINT_PDP_SLUG, 'pl');
  });

  it('falls back to the messages payload when both readers return null', async () => {
    vi.mocked(getPreviewContent).mockResolvedValue(null);
    vi.mocked(getPublishedContent).mockResolvedValue(null);

    await expect(getPrintPdpContent('de')).resolves.toEqual(fallbackPrintPdpPayload('de'));
  });
});
