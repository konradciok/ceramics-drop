import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockPublished, mockPreview } = vi.hoisted(() => ({ mockPublished: vi.fn(), mockPreview: vi.fn() }));
vi.mock('./server', () => ({ getPublishedContent: mockPublished, getPreviewContent: mockPreview }));

import { fallbackProductNotes, getProductNotes } from './messages';
import { registryPrintDesigns } from '@/lib/prints';

describe('fallbackProductNotes', () => {
  it('keeps curated print IDs bound to their stable source note indexes', () => {
    const notes = fallbackProductNotes('fine-art-prints', 'pl');

    expect(notes.fap010).toContain('010');
    expect(notes.fap005).toContain('005');
    expect(notes.fap010).not.toContain('005');
    expect(notes.fap005).not.toContain('010');
    expect(notes).not.toHaveProperty('fap029');
    expect(notes).not.toHaveProperty('fap037');
  });
});

describe('getProductNotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreview.mockResolvedValue(null);
  });

  it('fills a design missing from the published document from the fallback instead of blanking it', async () => {
    const ids = registryPrintDesigns().map((d) => d.id);
    const [missing, ...present] = ids;
    mockPublished.mockResolvedValue({ notes: Object.fromEntries(present.map((id) => [id, `CMS ${id}`])) });
    const notes = await getProductNotes('fine-art-prints', 'pl');
    expect(notes[present[0]]).toBe(`CMS ${present[0]}`);
    expect(notes[missing]).toBe(fallbackProductNotes('fine-art-prints', 'pl')[missing]);
  });

  it('uses the fallback wholesale when nothing is published', async () => {
    mockPublished.mockResolvedValue(null);
    await expect(getProductNotes('fine-art-prints', 'pl')).resolves.toEqual(fallbackProductNotes('fine-art-prints', 'pl'));
  });
});
