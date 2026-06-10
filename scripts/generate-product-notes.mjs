import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyCategoryDraftToMessagesFile,
  buildCategoryDraft,
  buildPrompt,
  collectReferenceExamples,
  ensureCategoryNotes,
  saveCategoryDraft,
} from './lib/product-notes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MESSAGES_PATH = path.join(ROOT, 'messages', 'pl.json');
const DRAFT_OUTPUT_DIR = path.join(ROOT, 'docs', 'product-notes-drafts');
const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  console.log(`Usage:
  node scripts/generate-product-notes.mjs --category kubki [--category talerze-srednie]
  node scripts/generate-product-notes.mjs --category kubki --write --draft docs/product-notes-drafts/2026-06-10-kubki.json
`);
}

function parseArgs(argv) {
  const options = {
    categories: [],
    draftPath: null,
    write: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--category') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) fail('Missing value after --category');
      options.categories.push(value);
      i += 1;
      continue;
    }
    if (arg === '--draft') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) fail('Missing value after --draft');
      options.draftPath = path.resolve(process.cwd(), value);
      i += 1;
      continue;
    }
    if (arg === '--write') {
      options.write = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    fail(`Unknown argument: ${arg}`);
  }

  if (options.categories.length === 0) {
    fail('At least one --category is required.');
  }
  if (options.write && !options.draftPath) {
    fail('Write mode requires --draft <path>.');
  }
  if (options.write && options.categories.length !== 1) {
    fail('Write mode currently supports exactly one category at a time.');
  }

  return options;
}

async function withConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((item, j) => fn(item, i + j)));
    batchResults.forEach((r, j) => { results[i + j] = r; });
  }
  return results;
}

function loadCategoryProducts(categories) {
  const tsxBin = path.join(ROOT, 'node_modules', '.bin', 'tsx');
  const readerScript = path.join(ROOT, 'scripts', 'lib', 'read-category-products.ts');
  const stdout = execFileSync(tsxBin, [readerScript, ...categories], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return JSON.parse(stdout);
}

function loadPolishMessages() {
  return JSON.parse(fs.readFileSync(MESSAGES_PATH, 'utf8'));
}

function toDataUrl(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing image file: ${filePath}`);
  }

  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mimeType = ext === 'jpg' ? 'jpeg' : ext;
  const data = fs.readFileSync(filePath).toString('base64');
  return `data:image/${mimeType};base64,${data}`;
}

function extractStructuredOutput(response, productId) {
  const tryParse = (text, source) => {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        `OpenAI response for ${productId} contained non-JSON in ${source}: ${text.slice(0, 200)}`,
      );
    }
  };

  if (typeof response.output_text === 'string' && response.output_text.trim().length > 0) {
    return tryParse(response.output_text, 'output_text');
  }

  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string' && content.text.trim().length > 0) {
        return tryParse(content.text, 'output[].content[].text');
      }
    }
  }

  throw new Error(`OpenAI response for ${productId} did not include structured output text.`);
}

async function generateNoteForProduct({ apiKey, category, model, product, referenceExamples }) {
  const imagePath = path.join(ROOT, 'public', product.image.replace(/^\//, ''));
  const imageDataUrl = toDataUrl(imagePath);
  const prompt = buildPrompt({ category, product, referenceExamples });

  const payload = {
    model,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: imageDataUrl, detail: 'high' },
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'product_note',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['proposedNote'],
          properties: {
            proposedNote: {
              type: 'string',
              minLength: 10,
            },
          },
        },
      },
    },
  };

  const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed for ${product.id}: ${response.status} ${body}`);
  }

  const data = await response.json();
  const parsed = extractStructuredOutput(data, product.id);

  if (!parsed || typeof parsed.proposedNote !== 'string' || parsed.proposedNote.trim().length === 0) {
    throw new Error(`OpenAI response for ${product.id} did not include proposedNote.`);
  }

  return parsed.proposedNote.trim();
}

async function runDraftMode({ categories }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    fail('OPENAI_API_KEY is required in draft mode.');
  }

  const productsByCategory = loadCategoryProducts(categories);
  const messages = loadPolishMessages();
  const referenceExamples = collectReferenceExamples(messages);
  const dateStamp = new Date().toISOString().slice(0, 10);
  const savedDrafts = [];

  for (const category of categories) {
    const products = productsByCategory[category];
    const currentNotes = ensureCategoryNotes(messages, category);

    console.log(`Generating ${products.length} note(s) for "${category}" with model ${DEFAULT_MODEL} (concurrency 5)...`);

    const proposedNotes = await withConcurrency(products, 5, async (product) => {
      const proposedNote = await generateNoteForProduct({
        apiKey,
        category,
        model: DEFAULT_MODEL,
        product,
        referenceExamples,
      });
      console.log(`  ${product.id} -> draft ready`);
      return proposedNote;
    });

    const draft = buildCategoryDraft({
      category,
      currentNotes,
      generatedAt: new Date().toISOString(),
      model: DEFAULT_MODEL,
      products,
      proposedNotes,
    });

    const savedPath = saveCategoryDraft(draft, {
      dateStamp,
      outputDir: DRAFT_OUTPUT_DIR,
    });
    savedDrafts.push({ category, path: savedPath, count: draft.items.length });
  }

  console.log('\nDrafts saved:');
  for (const draft of savedDrafts) {
    console.log(`- ${draft.category}: ${draft.count} note(s) -> ${draft.path}`);
  }
}

async function runWriteMode({ category, draftPath }) {
  const productsByCategory = loadCategoryProducts([category]);
  const products = productsByCategory[category];

  if (!fs.existsSync(draftPath)) {
    fail(`Draft file not found: ${draftPath}`);
  }

  const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
  if (draft.category !== category) {
    fail(`Draft category "${draft.category}" does not match requested category "${category}".`);
  }

  applyCategoryDraftToMessagesFile({
    draft,
    messagesPath: MESSAGES_PATH,
    products,
  });

  console.log(`Updated messages/pl.json for category "${category}" using draft ${draftPath}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.write) {
    await runWriteMode({
      category: options.categories[0],
      draftPath: options.draftPath,
    });
    return;
  }

  await runDraftMode(options);
}

await main();
