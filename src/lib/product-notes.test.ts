import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import pl from '../../messages/pl.json';
import { getProductsByCategory } from './products';
import {
  applyCategoryDraftToMessagesFile,
  buildCategoryDraft,
  saveCategoryDraft,
  validateCategoryDraftAgainstProducts,
} from '../../scripts/lib/product-notes.mjs';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('product notes drafts', () => {
  it('builds kubki draft entries in the same order as the frontend noteIndex lookup', () => {
    const products = getProductsByCategory('kubki');
    const currentNotes = [...pl.notes.kubki];
    const proposedNotes = products.map((product) => `Nowy opis ${product.id}`);

    const draft = buildCategoryDraft({
      category: 'kubki',
      currentNotes,
      generatedAt: '2026-06-10T12:00:00.000Z',
      model: 'test-model',
      products,
      proposedNotes,
    });

    expect(draft.items).toHaveLength(products.length);
    expect(draft.items[0]).toMatchObject({
      category: 'kubki',
      productId: 'k01',
      displayNum: '01',
      image: '/uploads/kubek-1.webp',
      currentNote: pl.notes.kubki[0],
      proposedNote: 'Nowy opis k01',
    });
    expect(draft.items.at(-1)).toMatchObject({
      productId: 'c04',
      displayNum: '28',
      currentNote: pl.notes.kubki.at(-1),
      proposedNote: 'Nowy opis c04',
    });
  });

  it('writes a review draft file without mutating the source messages object', () => {
    const products = getProductsByCategory('talerze-srednie');
    const currentNotes = [...pl.notes['talerze-srednie']];
    const proposedNotes = products.map((product) => `Roboczy opis ${product.id}`);
    const before = JSON.stringify(pl.notes['talerze-srednie']);
    const outDir = makeTempDir('product-notes-draft-');

    const draft = buildCategoryDraft({
      category: 'talerze-srednie',
      currentNotes,
      generatedAt: '2026-06-10T12:00:00.000Z',
      model: 'test-model',
      products,
      proposedNotes,
    });

    const savedPath = saveCategoryDraft(draft, { dateStamp: '2026-06-10', outputDir: outDir });
    const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8'));

    expect(savedPath).toBe(path.join(outDir, '2026-06-10-talerze-srednie.json'));
    expect(saved.category).toBe('talerze-srednie');
    expect(saved.items).toHaveLength(products.length);
    expect(JSON.stringify(pl.notes['talerze-srednie'])).toBe(before);
  });

  it('updates only the targeted category when applying a reviewed draft to messages/pl.json', () => {
    const products = getProductsByCategory('kubki');
    const currentNotes = [...pl.notes.kubki];
    const proposedNotes = products.map((product) => `Zatwierdzony opis ${product.id}`);
    const messagesPath = path.join(makeTempDir('product-notes-write-'), 'pl.json');
    fs.writeFileSync(messagesPath, `${JSON.stringify(pl, null, 2)}\n`, 'utf8');

    const draft = buildCategoryDraft({
      category: 'kubki',
      currentNotes,
      generatedAt: '2026-06-10T12:00:00.000Z',
      model: 'test-model',
      products,
      proposedNotes,
    });

    applyCategoryDraftToMessagesFile({
      draft,
      messagesPath,
      products,
    });

    const updated = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
    expect(updated.notes.kubki[0]).toBe('Zatwierdzony opis k01');
    expect(updated.notes.kubki.at(-1)).toBe('Zatwierdzony opis c04');
    expect(updated.notes['talerze-srednie']).toEqual(pl.notes['talerze-srednie']);
    expect(updated.home.heroTitle).toBe(pl.home.heroTitle);
  });

  it('rejects drafts whose item count no longer matches the category product count', () => {
    const products = getProductsByCategory('kubki');
    const currentNotes = [...pl.notes.kubki];
    const proposedNotes = products.slice(0, -1).map((product) => `Za krótki opis ${product.id}`);

    expect(() =>
      buildCategoryDraft({
        category: 'kubki',
        currentNotes,
        generatedAt: '2026-06-10T12:00:00.000Z',
        model: 'test-model',
        products,
        proposedNotes,
      }),
    ).toThrow('Expected 28 proposed notes for category "kubki"');
  });

  it('fails validation when a product image is missing', () => {
    const products = getProductsByCategory('kubki');
    const currentNotes = [...pl.notes.kubki];
    const proposedNotes = products.map((product) => `Opis ${product.id}`);
    const draft = buildCategoryDraft({
      category: 'kubki',
      currentNotes,
      generatedAt: '2026-06-10T12:00:00.000Z',
      model: 'test-model',
      products,
      proposedNotes,
    });

    const brokenProducts = products.map((product, index) =>
      index === 0 ? { ...product, image: '' } : product,
    );

    expect(() => validateCategoryDraftAgainstProducts(draft, brokenProducts)).toThrow(
      'Product "k01" is missing an image path.',
    );
  });
});
