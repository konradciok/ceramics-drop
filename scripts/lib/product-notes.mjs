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
    Array.isArray(proposedNotes) && proposedNotes.length === products.length,
    `Expected ${products.length} proposed notes for category "${category}", got ${proposedNotes?.length ?? 0}.`,
  );

  // Notes are keyed by each product's registry noteIndex, not by position:
  // prints use a sparse range (slots 0-2 belong to withdrawn legacy posters
  // and must stay untouched), ceramics happen to be dense (noteIndex == position).
  const seenNoteIndexes = new Set();
  for (const product of products) {
    invariant(
      Number.isInteger(product.noteIndex),
      `Product "${product.id}" is missing a numeric noteIndex.`,
    );
    invariant(
      product.noteIndex >= 0 && product.noteIndex < currentNotes.length,
      `Product "${product.id}" has noteIndex ${product.noteIndex} outside the ${currentNotes.length}-slot notes array for "${category}".`,
    );
    invariant(
      !seenNoteIndexes.has(product.noteIndex),
      `Duplicate noteIndex ${product.noteIndex} in category "${category}" (product "${product.id}").`,
    );
    seenNoteIndexes.add(product.noteIndex);
  }

  const items = products.map((product, index) => {
    invariant(product.category === category, `Product "${product.id}" does not belong to category "${category}".`);
    invariant(isNonEmptyString(product.image), `Product "${product.id}" is missing an image path.`);
    invariant(isNonEmptyString(currentNotes[product.noteIndex]), `Current note for "${product.id}" (noteIndex ${product.noteIndex}) is empty.`);
    invariant(isNonEmptyString(proposedNotes[index]), `Proposed note ${index + 1} for "${category}" is empty.`);

    return {
      category,
      productId: product.id,
      displayNum: product.num,
      noteIndex: product.noteIndex,
      image: product.image,
      currentNote: currentNotes[product.noteIndex],
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
    if (item.noteIndex === undefined) {
      // Legacy version-1 drafts predate noteIndex and were dense/positional —
      // only safe when the registry is positional at this slot too, otherwise
      // the positional fallback in apply would overwrite foreign slots.
      invariant(
        product.noteIndex === index,
        `Draft item ${index + 1} has no noteIndex, but "${product.id}" sits at noteIndex ${product.noteIndex} — regenerate the draft.`,
      );
    } else {
      invariant(
        item.noteIndex === product.noteIndex,
        `Draft item ${index + 1} expected noteIndex ${product.noteIndex}, got ${item.noteIndex} — the registry moved since the draft was generated.`,
      );
    }
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

export function applyCategoryDraftToMessages(messages, draft) {
  invariant(messages && typeof messages === 'object', 'Messages payload must be an object.');
  const currentNotes = ensureCategoryNotes(messages, draft.category);

  // Write each drafted note at its noteIndex and leave every other slot as-is
  // (for prints, slots 0-2 belong to withdrawn legacy posters). Version-1
  // drafts without noteIndex fall back to their dense/positional meaning.
  const nextNotes = [...currentNotes];
  draft.items.forEach((item, index) => {
    const noteIndex = item.noteIndex ?? index;
    invariant(
      Number.isInteger(noteIndex) && noteIndex >= 0 && noteIndex < nextNotes.length,
      `Draft item ${index + 1} has noteIndex ${noteIndex} outside the ${nextNotes.length}-slot notes array for "${draft.category}".`,
    );
    nextNotes[noteIndex] = item.proposedNote;
  });

  return {
    ...messages,
    notes: {
      ...messages.notes,
      [draft.category]: nextNotes,
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

  if (category === 'fine-art-prints') {
    return [
      'Jesteś redaktorem opisów katalogowych dla sklepu Anny Ciok.',
      'Napisz po polsku dokładnie dwa krótkie zdania o reprodukcji obrazu (fine art print) na podstawie zdjęcia.',
      `Numer produktu: ${product.num}.`,
      'Konwencja:',
      '- zdanie 1: konkretny motyw, paleta barw albo kompozycja widoczna na obrazie',
      '- zdanie 2: krótki nastrój, rytm albo charakter malarskiego gestu',
      'Zakazy:',
      '- nie pisz ogólników typu "piękny", "unikatowy", jeśli nie wynikają ze zdjęcia',
      '- nie zgaduj techniki, materiału ani rzeczy niewidocznych na zdjęciu',
      '- nie wspominaj o cenie, artystce ani sklepie',
      '- nie używaj cudzysłowów, wypunktowań ani tytułu',
      'Wzorce tonu (z opisów ceramiki — przejmij rytm i zwięzłość, nie treść):',
      examples,
    ].join('\n');
  }

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
