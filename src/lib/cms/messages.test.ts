import { describe, expect, it } from 'vitest';
import { fallbackProductNotes } from './messages';

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
