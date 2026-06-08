#!/usr/bin/env node
/**
 * Pull Polish strings from Notion → messages/pl.json.
 *
 * Imports rows with Status "Ready" or "Done", or rows edited since last pull
 * when --since-last-sync is passed.
 *
 * Usage:
 *   node scripts/notion-i18n/pull.mjs
 *   node scripts/notion-i18n/pull.mjs --dry-run
 *   node scripts/notion-i18n/pull.mjs --since-last-sync
 *
 * Requires: NOTION_TOKEN, NOTION_DATABASE_ID
 */

import fs from 'node:fs';
import {
  PL_PATH,
  loadDotEnv,
  requireEnv,
  flattenMessages,
  readJson,
  writeJson,
  loadState,
  saveState,
  applyFlatToTemplate,
  readPageFields,
  NotionClient,
  PULL_STATUSES,
  assertRoundTrip,
} from './lib.mjs';

loadDotEnv();

const dryRun = process.argv.includes('--dry-run');
const sinceLastSync = process.argv.includes('--since-last-sync');
const token = requireEnv('NOTION_TOKEN');
const databaseId = requireEnv('NOTION_DATABASE_ID');

const pl = readJson(PL_PATH);
assertRoundTrip(pl);

const state = loadState();
const notion = new NotionClient(token);
const pages = await notion.queryAll(databaseId);

const lastPullAt = state.lastPullAt ? Date.parse(state.lastPullAt) : 0;
const updates = {};
let pulled = 0;
let skipped = 0;

for (const page of pages) {
  const row = readPageFields(page);
  if (!row.key) continue;

  const statusOk = row.status && PULL_STATUSES.has(row.status);
  const editedSince =
    sinceLastSync && lastPullAt > 0 && Date.parse(row.lastEdited) > lastPullAt;

  if (!statusOk && !editedSince) {
    skipped++;
    continue;
  }

  const currentFlat = Object.fromEntries(flattenMessages(pl).map((r) => [r.key, r.value]));
  if (currentFlat[row.key] === row.polish) {
    skipped++;
    continue;
  }

  updates[row.key] = row.polish;
  pulled++;
  if (dryRun) {
    console.log(`[pull] ${row.key} (${row.status ?? 'edited'})`);
  }
}

if (pulled === 0) {
  console.log(`Nothing to pull (${skipped} rows skipped). Mark edited rows Ready/Done in Notion.`);
  process.exit(0);
}

const flatCurrent = Object.fromEntries(flattenMessages(pl).map((r) => [r.key, r.value]));
const merged = { ...flatCurrent, ...updates };
const next = applyFlatToTemplate(pl, merged);
assertRoundTrip(next);

if (dryRun) {
  console.log(`Dry run: would update ${pulled} key(s) in messages/pl.json`);
  process.exit(0);
}

writeJson(PL_PATH, next);
state.lastPullAt = new Date().toISOString();
for (const [key, value] of Object.entries(updates)) {
  if (state.pages[key]) state.pages[key].lastPulledPolish = value;
}
saveState(state);

console.log(`Pulled ${pulled} key(s) into messages/pl.json (${skipped} rows skipped).`);
