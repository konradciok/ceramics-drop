#!/usr/bin/env node
/**
 * Push messages/pl.json (+ en.json reference) → Notion database rows.
 *
 * Usage:
 *   node scripts/notion-i18n/push.mjs
 *   node scripts/notion-i18n/push.mjs --dry-run
 *
 * Requires: NOTION_TOKEN, NOTION_DATABASE_ID
 */

import {
  PL_PATH,
  EN_PATH,
  loadDotEnv,
  requireEnv,
  flattenMessages,
  readJson,
  loadState,
  saveState,
  pageProperties,
  readPageFields,
  classifyKey,
  NotionClient,
  sleep,
  assertRoundTrip,
  PULL_STATUSES,
} from './lib.mjs';

loadDotEnv();

const dryRun = process.argv.includes('--dry-run');
const token = process.env.NOTION_TOKEN?.trim();
const databaseId = process.env.NOTION_DATABASE_ID?.trim();
if (!dryRun && (!token || !databaseId)) {
  if (!token) requireEnv('NOTION_TOKEN');
  requireEnv('NOTION_DATABASE_ID');
}

const pl = readJson(PL_PATH);
const en = readJson(EN_PATH);
assertRoundTrip(pl);

const plRows = flattenMessages(pl);
const enMap = Object.fromEntries(flattenMessages(en).map((r) => [r.key, r.value]));
const state = loadState();
const notion = token ? new NotionClient(token) : null;

console.log(`Flattened ${plRows.length} keys from messages/pl.json`);

// Fetch existing rows even in dry-run (read-only) so the report shows a real
// create/update diff instead of marking everything as "create".
const existingPages = !notion || !databaseId ? [] : await notion.queryAll(databaseId);
const byKey = new Map();
for (const page of existingPages) {
  const fields = readPageFields(page);
  if (!fields.key) continue;
  const prev = byKey.get(fields.key);
  if (prev) {
    throw new Error(
      `Duplicate Notion rows for key "${fields.key}": ${prev.pageId} and ${fields.pageId}. ` +
        'Resolve the duplicate in Notion before syncing.',
    );
  }
  byKey.set(fields.key, fields);
}

let created = 0;
let updated = 0;
let skipped = 0;

for (const { key, value: polish } of plRows) {
  const english = enMap[key] ?? '';
  const existing = byKey.get(key);

  if (!existing) {
    if (dryRun || !notion) {
      console.log(`[create] ${key}`);
      created++;
      continue;
    }
    const page = await notion.createPage(
      databaseId,
      pageProperties({ key, polish, english, status: 'Draft' }),
    );
    const fields = readPageFields(page);
    state.pages[key] = { pageId: fields.pageId, lastPushedPolish: polish, lastPushedEnglish: english };
    created++;
    await sleep(350);
    continue;
  }

  const polishChanged = existing.polish !== polish;
  const englishChanged = existing.english !== english;
  const want = classifyKey(key);
  const groupingChanged =
    existing.area !== want.area ||
    existing.page !== want.page ||
    existing.section !== want.section;

  // Don't stomp a translator's in-progress Polish: if the Notion row's Polish
  // diverged from what we last pushed AND the row isn't approved (Ready/Done),
  // push English/grouping only and leave Polish untouched.
  const lastPushedPolish = state.pages[key]?.lastPushedPolish;
  const notionPolishEdited =
    lastPushedPolish !== undefined && existing.polish !== lastPushedPolish;
  const approved = existing.status && PULL_STATUSES.has(existing.status);
  const protectPolish = polishChanged && notionPolishEdited && !approved;

  if (!polishChanged && !englishChanged && !groupingChanged) {
    skipped++;
    state.pages[key] = {
      pageId: existing.pageId,
      lastPushedPolish: polish,
      lastPushedEnglish: english,
    };
    continue;
  }

  if (protectPolish && !englishChanged && !groupingChanged) {
    skipped++;
    console.warn(
      `[push] keeping in-progress Notion Polish for ${key} (status ${existing.status ?? 'none'}); nothing else changed`,
    );
    continue; // leave state.lastPushedPolish unchanged so divergence stays detected
  }

  if (dryRun || !notion) {
    console.log(`[update] ${key}${protectPolish ? ' (English/grouping only)' : ''}`);
    updated++;
    continue;
  }

  const props = pageProperties({ key, polish, english });
  if (protectPolish) {
    delete props.Polish;
    console.warn(
      `[push] keeping in-progress Notion Polish for ${key} (status ${existing.status ?? 'none'}); pushing English/grouping only`,
    );
  }
  await notion.updatePage(existing.pageId, props);
  state.pages[key] = {
    pageId: existing.pageId,
    lastPushedPolish: protectPolish ? lastPushedPolish : polish,
    lastPushedEnglish: english,
  };
  updated++;
  await sleep(350);
}

state.keyOrder = plRows.map((r) => r.key);
state.lastPushAt = new Date().toISOString();

if (!dryRun) saveState(state);

console.log(`Push complete: ${created} created, ${updated} updated, ${skipped} unchanged${dryRun ? ' (dry run)' : ''}`);
