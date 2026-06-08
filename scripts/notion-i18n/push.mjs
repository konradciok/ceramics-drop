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

const existingPages = dryRun || !notion || !databaseId ? [] : await notion.queryAll(databaseId);
const byKey = new Map();
for (const page of existingPages) {
  const fields = readPageFields(page);
  if (fields.key) byKey.set(fields.key, fields);
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
  if (!polishChanged && !englishChanged && !groupingChanged) {
    skipped++;
    state.pages[key] = {
      pageId: existing.pageId,
      lastPushedPolish: polish,
      lastPushedEnglish: english,
    };
    continue;
  }

  if (dryRun || !notion) {
    console.log(`[update] ${key}`);
    updated++;
    continue;
  }

  await notion.updatePage(
    existing.pageId,
    pageProperties({ key, polish, english }),
  );
  state.pages[key] = {
    pageId: existing.pageId,
    lastPushedPolish: polish,
    lastPushedEnglish: english,
  };
  updated++;
  await sleep(350);
}

state.keyOrder = plRows.map((r) => r.key);
state.lastPushAt = new Date().toISOString();

if (!dryRun) saveState(state);

console.log(`Push complete: ${created} created, ${updated} updated, ${skipped} unchanged${dryRun ? ' (dry run)' : ''}`);
