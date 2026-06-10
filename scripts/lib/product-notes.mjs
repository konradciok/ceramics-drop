import fs from 'node:fs';
import path from 'node:path';

export const CATEGORY_DRAFT_VERSION = 1;
export const DEFAULT_REFERENCE_CATEGORIES = ['miski-falowane', 'duze-michy'];

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function ensureCategoryNotes(messages, category) {
  invariant(messages && typeof messages === 'object', 'Messages payload must be an object.');
  invariant(messages.notes && typeof messages.notes === 'object', 'Messages payload is missing the "notes" object.');
  const notes = messages.notes[category];
  invariant(Array.isArray(notes), `Messages payload is missing notes for category "${category}".`);
  return notes;
}

export function collectReferenceExamples(messages, categories = DEFAULT_REFERENCE_CATEGORIES) {
  return categories.flatMap((category) => ensureCategoryNotes(messages, category));
}

export function buildCategoryDraft({
  category,
  currentNotes,
  generatedAt,
  model,
  products,
  proposedNotes,
}) {
  invariant(Array.isArray(products) && products.length > 0, `No products found for category "${category}".`);
  invariant(Array.isArray(currentNotes), `Current notes for category "${category}" must be an array.`);
  invariant(
    currentNotes.length === products.length,
    `Expected ${products.length} current notes for category "${category}", got ${currentNotes.length}.`,
  );
  invariant(
    Array.isArray(proposedNotes) && proposedNotes.length === products.length,
    `Expected ${products.length} proposed notes for category "${category}", got ${proposedNotes?.length ?? 0}.`,
  );

  const items = products.map((product, index) => {
    invariant(product.category === category, `Product "${product.id}" does not belong to category "${category}".`);
    invariant(isNonEmptyString(product.image), `Product "${product.id}" is missing an image path.`);
    invariant(isNonEmptyString(currentNotes[index]), `Current note ${index + 1} for "${category}" is empty.`);
    invariant(isNonEmptyString(proposedNotes[index]), `Proposed note ${index + 1} for "${category}" is empty.`);

    return {
      category,
      productId: product.id,
      displayNum: product.num,
      image: product.image,
      currentNote: currentNotes[index],
      proposedNote: proposedNotes[index],
    };
  });

  return {
    version: CATEGORY_DRAFT_VERSION,
    category,
    generatedAt,
    itemCount: items.length,
    model,
    items,
  };
}

export function validateCategoryDraftAgainstProducts(draft, products) {
  invariant(draft && typeof draft === 'object', 'Draft payload must be an object.');
  invariant(draft.version === CATEGORY_DRAFT_VERSION, `Unsupported draft version: ${draft.version}.`);
  invariant(isNonEmptyString(draft.category), 'Draft payload is missing category.');
  invariant(Array.isArray(draft.items), `Draft "${draft.category}" is missing items.`);
  invariant(
    Array.isArray(products) && products.length === draft.items.length,
    `Draft "${draft.category}" has ${draft.items.length} items, but the catalogue currently has ${products.length}.`,
  );

  products.forEach((product, index) => {
    const item = draft.items[index];
    invariant(isNonEmptyString(product.image), `Product "${product.id}" is missing an image path.`);
    invariant(item && typeof item === 'object', `Draft item ${index + 1} for "${draft.category}" is missing.`);
    invariant(item.category === draft.category, `Draft item ${index + 1} has mismatched category.`);
    invariant(item.productId === product.id, `Draft item ${index + 1} expected product "${product.id}", got "${item.productId}".`);
    invariant(item.displayNum === product.num, `Draft item ${index + 1} expected display number "${product.num}", got "${item.displayNum}".`);
    invariant(item.image === product.image, `Draft item ${index + 1} expected image "${product.image}", got "${item.image}".`);
    invariant(isNonEmptyString(item.currentNote), `Draft item ${index + 1} is missing currentNote.`);
    invariant(isNonEmptyString(item.proposedNote), `Draft item ${index + 1} is missing proposedNote.`);
  });

  return true;
}

export function saveCategoryDraft(draft, { dateStamp, outputDir }) {
  invariant(isNonEmptyString(dateStamp), 'dateStamp is required to save a draft.');
  invariant(isNonEmptyString(outputDir), 'outputDir is required to save a draft.');

  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${dateStamp}-${draft.category}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  return outputPath;
}

function applyCategoryDraftToMessages(messages, draft) {
  invariant(messages && typeof messages === 'object', 'Messages payload must be an object.');
  const currentNotes = ensureCategoryNotes(messages, draft.category);
  invariant(
    currentNotes.length === draft.items.length,
    `Messages for "${draft.category}" currently have ${currentNotes.length} notes, but the draft has ${draft.items.length}.`,
  );

  return {
    ...messages,
    notes: {
      ...messages.notes,
      [draft.category]: draft.items.map((item) => item.proposedNote),
    },
  };
}

export function applyCategoryDraftToMessagesFile({ draft, messagesPath, products }) {
  invariant(isNonEmptyString(messagesPath), 'messagesPath is required.');
  validateCategoryDraftAgainstProducts(draft, products);

  const raw = fs.readFileSync(messagesPath, 'utf8');
  const messages = JSON.parse(raw);
  const nextMessages = applyCategoryDraftToMessages(messages, draft);

  fs.writeFileSync(messagesPath, `${JSON.stringify(nextMessages, null, 2)}\n`, 'utf8');
  return nextMessages;
}

export function buildPrompt({ category, product, referenceExamples }) {
  const examples = referenceExamples.map((note) => `- ${note}`).join('\n');

  return [
    'Jesteś redaktorem opisów katalogowych dla sklepu z ceramiką Anny Ciok.',
    'Napisz po polsku dokładnie dwa krótkie zdania o jednym produkcie na podstawie zdjęcia.',
    `Kategoria: ${category}.`,
    `Numer produktu: ${product.num}.`,
    'Konwencja:',
    '- zdanie 1: konkretny motyw, kolor, układ albo detal formy widoczny na zdjęciu',
    '- zdanie 2: krótki nastrój, rytm albo sposób, w jaki motyw układa się na obiekcie',
    'Zakazy:',
    '- nie pisz ogólników typu "piękny", "unikatowy", "ręcznie robiony", jeśli nie wynikają ze zdjęcia',
    '- nie zgaduj funkcji, materiału ani rzeczy niewidocznych na zdjęciu',
    '- nie wspominaj o cenie, artyście ani sklepie',
    '- nie używaj cudzysłowów, wypunktowań ani tytułu',
    'Wzorce tonu:',
    examples,
  ].join('\n');
}
