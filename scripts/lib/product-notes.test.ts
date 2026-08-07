import { describe, expect, it } from 'vitest';
import {
  applyCategoryDraftToMessages,
  buildCategoryDraft,
  buildPrompt,
  validateCategoryDraftAgainstProducts,
} from './product-notes.mjs';

const ceramicProducts = [
  { id: 'k01', category: 'kubki', num: '01', image: '/uploads/kubek-1.webp', noteIndex: 0 },
  { id: 'k02', category: 'kubki', num: '02', image: '/uploads/kubek-2.webp', noteIndex: 1 },
];

// Prints: published designs use sparse noteIndexes (3+); slots 0-2 belong to
// withdrawn legacy posters and must survive a draft apply untouched.
const printProducts = [
  { id: 'fap005', category: 'fine-art-prints', num: '1', image: '/uploads/fap-005.webp', noteIndex: 3 },
  { id: 'fap006', category: 'fine-art-prints', num: '2', image: '/uploads/fap-006.webp', noteIndex: 4 },
];

const printNotes = ['legacy 1', 'legacy 2', 'legacy 3', 'Lorem ipsum Nº 1.', 'Lorem ipsum Nº 2.'];

interface TestProduct {
  id: string;
  category: string;
  num: string;
  image: string;
  noteIndex: number | undefined;
}

interface DraftItem {
  category: string;
  productId: string;
  displayNum: string;
  noteIndex?: number;
  image: string;
  currentNote: string;
  proposedNote: string;
}

function draftFor(
  products: TestProduct[],
  currentNotes: string[],
  proposedNotes: string[],
): { category: string; items: DraftItem[] } {
  return buildCategoryDraft({
    category: products[0].category,
    currentNotes,
    generatedAt: '2026-08-07T00:00:00.000Z',
    model: 'test-model',
    products,
    proposedNotes,
  });
}

describe('buildCategoryDraft', () => {
  it('keeps the dense ceramic flow working (noteIndex == position)', () => {
    const draft = draftFor(ceramicProducts, ['a', 'b'], ['A', 'B']);
    expect(draft.items.map((i) => i.noteIndex)).toEqual([0, 1]);
    expect(draft.items.map((i) => i.currentNote)).toEqual(['a', 'b']);
  });

  it('maps sparse print noteIndexes into the 46-slot notes array', () => {
    const draft = draftFor(printProducts, printNotes, ['New 1', 'New 2']);
    expect(draft.items.map((i) => i.noteIndex)).toEqual([3, 4]);
    expect(draft.items.map((i) => i.currentNote)).toEqual(['Lorem ipsum Nº 1.', 'Lorem ipsum Nº 2.']);
    expect(draft.items.map((i) => i.proposedNote)).toEqual(['New 1', 'New 2']);
  });

  it('rejects a noteIndex outside the notes array', () => {
    const bad = [{ ...printProducts[0], noteIndex: 99 }];
    expect(() => draftFor(bad, printNotes, ['x'])).toThrow(/noteIndex 99/);
  });

  it('rejects duplicate noteIndexes', () => {
    const bad = [printProducts[0], { ...printProducts[1], noteIndex: 3 }];
    expect(() => draftFor(bad, printNotes, ['x', 'y'])).toThrow(/duplicate noteIndex/i);
  });

  it('rejects a product without a numeric noteIndex', () => {
    const bad = [{ ...printProducts[0], noteIndex: undefined }];
    expect(() => draftFor(bad, printNotes, ['x'])).toThrow(/noteIndex/);
  });
});

describe('applyCategoryDraftToMessages', () => {
  it('writes only the drafted slots and preserves the rest', () => {
    const draft = draftFor(printProducts, printNotes, ['New 1', 'New 2']);
    const messages = { notes: { 'fine-art-prints': [...printNotes] } };
    const next = applyCategoryDraftToMessages(messages, draft);
    expect(next.notes['fine-art-prints']).toEqual(['legacy 1', 'legacy 2', 'legacy 3', 'New 1', 'New 2']);
    // input untouched
    expect(messages.notes['fine-art-prints'][3]).toBe('Lorem ipsum Nº 1.');
  });

  it('replaces every slot in the dense ceramic case (old behaviour)', () => {
    const draft = draftFor(ceramicProducts, ['a', 'b'], ['A', 'B']);
    const next = applyCategoryDraftToMessages({ notes: { kubki: ['a', 'b'] } }, draft);
    expect(next.notes.kubki).toEqual(['A', 'B']);
  });

  it('rejects a draft whose noteIndex no longer fits the notes array', () => {
    const draft = draftFor(printProducts, printNotes, ['New 1', 'New 2']);
    const messages = { notes: { 'fine-art-prints': ['only', 'three', 'slots'] } };
    expect(() => applyCategoryDraftToMessages(messages, draft)).toThrow(/noteIndex/);
  });
});

describe('validateCategoryDraftAgainstProducts', () => {
  it('accepts a matching draft', () => {
    const draft = draftFor(printProducts, printNotes, ['New 1', 'New 2']);
    expect(validateCategoryDraftAgainstProducts(draft, printProducts)).toBe(true);
  });

  it('rejects when the registry noteIndex moved since the draft', () => {
    const draft = draftFor(printProducts, printNotes, ['New 1', 'New 2']);
    const moved = [printProducts[0], { ...printProducts[1], noteIndex: 5 }];
    expect(() => validateCategoryDraftAgainstProducts(draft, moved)).toThrow(/noteIndex/);
  });

  it('still accepts legacy version-1 items without noteIndex', () => {
    const draft = draftFor(ceramicProducts, ['a', 'b'], ['A', 'B']);
    for (const item of draft.items) delete item.noteIndex;
    expect(validateCategoryDraftAgainstProducts(draft, ceramicProducts)).toBe(true);
  });
});

describe('buildPrompt', () => {
  it('frames prints as painting reproductions, not ceramics', () => {
    const prompt = buildPrompt({
      category: 'fine-art-prints',
      product: printProducts[0],
      referenceExamples: ['ton przykład'],
    });
    expect(prompt).toMatch(/reprodukc/i);
    expect(prompt).not.toMatch(/kategoria: fine-art-prints/i);
  });

  it('keeps the ceramic prompt for ceramic categories', () => {
    const prompt = buildPrompt({
      category: 'kubki',
      product: ceramicProducts[0],
      referenceExamples: ['ton przykład'],
    });
    expect(prompt).toContain('Kategoria: kubki.');
  });
});
