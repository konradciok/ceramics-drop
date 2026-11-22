import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockPublished, mockPreview } = vi.hoisted(() => ({ mockPublished: vi.fn(), mockPreview: vi.fn() }));
vi.mock('./server', () => ({ getPublishedContent: mockPublished, getPreviewContent: mockPreview }));

import { fallbackProductNotes, getProductNotes } from './messages';
import { registryProductsByCategory } from '@/lib/products';
import pl from '../../../messages/pl.json';

describe('fallbackProductNotes', () => {
  it('keeps product IDs bound to their stable source note indexes', () => {
    const notes = fallbackProductNotes('kubki', 'pl');
    const rawNotes = pl.notes.kubki;
    const [first, second] = registryProductsByCategory('kubki');

    // Verifies the id -> noteIndex -> array-slot wiring directly (not via a
    // magic substring in the copy) — a shuffled noteIndex would surface here.
    expect(notes[first.id]).toBe(rawNotes[first.noteIndex]);
    expect(notes[second.id]).toBe(rawNotes[second.noteIndex]);
    expect(notes[first.id]).not.toBe(notes[second.id]);
  });

  it('has no fallback notes for the retired fine-art-prints document', () => {
    expect(fallbackProductNotes('fine-art-prints', 'pl')).toEqual({});
  });
});

describe('getProductNotes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreview.mockResolvedValue(null);
  });

  it('fills a piece missing from the published document from the fallback instead of blanking it', async () => {
    const ids = registryProductsByCategory('kubki').map((p) => p.id);
    const [missing, ...present] = ids;
    mockPublished.mockResolvedValue({ notes: Object.fromEntries(present.map((id) => [id, `CMS ${id}`])) });
    const notes = await getProductNotes('kubki', 'pl');
    expect(notes[present[0]]).toBe(`CMS ${present[0]}`);
    expect(notes[missing]).toBe(fallbackProductNotes('kubki', 'pl')[missing]);
  });

  it('fills a piece missing from a preview draft from the fallback too (lenient preview can omit ids)', async () => {
    const ids = registryProductsByCategory('kubki').map((p) => p.id);
    const [missing, ...present] = ids;
    mockPreview.mockResolvedValue({ notes: Object.fromEntries(present.map((id) => [id, `DRAFT ${id}`])) });
    mockPublished.mockResolvedValue({ notes: Object.fromEntries(ids.map((id) => [id, `CMS ${id}`])) });
    const notes = await getProductNotes('kubki', 'pl', 'token');
    expect(notes[present[0]]).toBe(`DRAFT ${present[0]}`);
    expect(notes[missing]).toBe(fallbackProductNotes('kubki', 'pl')[missing]);
    expect(mockPublished).not.toHaveBeenCalled();
  });

  it('uses the fallback wholesale when nothing is published', async () => {
    mockPublished.mockResolvedValue(null);
    await expect(getProductNotes('kubki', 'pl')).resolves.toEqual(fallbackProductNotes('kubki', 'pl'));
  });
});
