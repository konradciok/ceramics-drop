import { describe, expect, it } from 'vitest';
import { fallbackProductNotes } from './messages';

describe('fallbackProductNotes', () => {
  it('keeps curated print IDs bound to their stable source note indexes', () => {
    const notes = fallbackProductNotes('fine-art-prints', 'pl');

    expect(notes).toMatchObject({
      fap010: 'PLACEHOLDER — opis do uzupełnienia. Obraz olejny, reprodukcja Fine Art. Malarstwo nr 10.',
      fap005: 'PLACEHOLDER — opis do uzupełnienia. Obraz olejny, reprodukcja Fine Art. Malarstwo nr 5.',
    });
    expect(notes).not.toHaveProperty('fap029');
    expect(notes).not.toHaveProperty('fap037');
  });
});
