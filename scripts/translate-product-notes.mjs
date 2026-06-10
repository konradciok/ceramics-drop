/**
 * translate-product-notes.mjs
 *
 * Translates the `notes` object in messages/pl.json into English and Spanish,
 * writing results directly into messages/en.json and messages/es.json.
 *
 * Uses the OpenAI Responses API (https://api.openai.com/v1/responses) with
 * structured output (json_schema) to return { translations: string[] }.
 *
 * Usage:
 *   OPENAI_API_KEY=... node scripts/translate-product-notes.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
const MODEL = process.env.OPENAI_MODEL ?? 'gpt-4.1';

const CATEGORIES = [
  'kubki',
  'wazony',
  'wazony-srednie',
  'wazony-duze',
  'talerzyki',
  'talerze-srednie',
  'talerze-duze',
  'duze-michy',
  'miski-falowane',
];

const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
];

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * Call the OpenAI Responses API to translate an array of notes.
 * Returns { translations: string[] } matching the input array length.
 * Retries up to 3 times on 503/network errors.
 */
async function translateNotes({ apiKey, notes, targetLanguage, category }) {
  const maxAttempts = 3;
  let lastError;

  const prompt = `You are a professional translator for an artisan ceramics shop. \
Translate the following product description notes from Polish to ${targetLanguage}.

Rules:
- Preserve the exact 2-sentence structure of each note.
- Preserve the concrete visual and atmospheric style — specific colors, motifs, directions of lines, rhythmic descriptions.
- Do NOT add generic marketing phrases, adjectives or sentences that are not in the original Polish.
- Do NOT omit any sentence.
- The output array must have exactly ${notes.length} entries, one per input note.
- Maintain a natural, understated tone appropriate for hand-made ceramics.

Category: ${category}
Notes to translate (${notes.length} items):
${JSON.stringify(notes, null, 2)}`;

  const payload = {
    model: MODEL,
    input: [
      {
        role: 'user',
        content: prompt,
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'translations',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['translations'],
          properties: {
            translations: {
              type: 'array',
              items: { type: 'string', minLength: 5 },
            },
          },
        },
      },
    },
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (response.status === 503 || response.status === 429) {
        const body = await response.text();
        lastError = new Error(`OpenAI ${response.status} for ${category} -> ${targetLanguage} (attempt ${attempt}): ${body.slice(0, 200)}`);
        console.warn(`  Retryable error (attempt ${attempt}/${maxAttempts}): ${response.status}`);
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenAI request failed for ${category} -> ${targetLanguage}: ${response.status} ${body.slice(0, 400)}`);
      }

      const data = await response.json();

      // Extract structured output text
      let rawText = '';
      if (typeof data.output_text === 'string' && data.output_text.trim().length > 0) {
        rawText = data.output_text;
      } else {
        for (const item of data.output ?? []) {
          for (const content of item.content ?? []) {
            if (typeof content.text === 'string' && content.text.trim().length > 0) {
              rawText = content.text;
              break;
            }
          }
          if (rawText) break;
        }
      }

      if (!rawText) {
        throw new Error(`OpenAI response for ${category} -> ${targetLanguage} contained no output text.`);
      }

      const parsed = JSON.parse(rawText);

      if (!Array.isArray(parsed.translations)) {
        throw new Error(`OpenAI response for ${category} -> ${targetLanguage} missing translations array.`);
      }

      if (parsed.translations.length !== notes.length) {
        throw new Error(
          `OpenAI returned ${parsed.translations.length} translations for ${category} -> ${targetLanguage}, expected ${notes.length}.`,
        );
      }

      return parsed.translations;
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      lastError = err;
      // Only retry on network-level errors (fetch threw), not logical errors
      const isNetworkError = !(err instanceof SyntaxError) && !err.message.includes('OpenAI request failed');
      if (!isNetworkError) throw err;
      console.warn(`  Network error (attempt ${attempt}/${maxAttempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }

  throw lastError;
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('Error: OPENAI_API_KEY environment variable is not set.');
    process.exit(1);
  }

  const plPath = path.join(ROOT, 'messages', 'pl.json');
  const plMessages = loadJson(plPath);
  const plNotes = plMessages.notes;

  if (!plNotes || typeof plNotes !== 'object') {
    console.error('Error: messages/pl.json does not contain a `notes` object.');
    process.exit(1);
  }

  // Verify all expected categories are present
  for (const cat of CATEGORIES) {
    if (!Array.isArray(plNotes[cat])) {
      console.error(`Error: messages/pl.json notes is missing category "${cat}".`);
      process.exit(1);
    }
  }

  // Process each language
  for (const { code: langCode, name: langName } of LANGUAGES) {
    const msgPath = path.join(ROOT, 'messages', `${langCode}.json`);
    const messages = loadJson(msgPath);

    if (!messages.notes || typeof messages.notes !== 'object') {
      messages.notes = {};
    }

    for (const category of CATEGORIES) {
      const sourceNotes = plNotes[category];
      console.log(`Translating ${category} (${sourceNotes.length} notes) -> ${langName}...`);

      const translated = await translateNotes({
        apiKey,
        notes: sourceNotes,
        targetLanguage: langName,
        category,
      });

      messages.notes[category] = translated;
      console.log(`  Done: ${category} -> ${langName}`);
    }

    writeJson(msgPath, messages);
    console.log(`\nWrote messages/${langCode}.json\n`);
  }

  console.log('All translations complete.');
}

await main();
