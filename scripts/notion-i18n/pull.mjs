#!/usr/bin/env node
/**
 * Pull Polish strings from Notion → messages/pl.json.
 *
 * Imports rows with Status "Ready" or "Done". --since-last-sync narrows that
 * set to rows also edited since the last pull (it never bypasses the status).
 * Keys absent from messages/pl.json are skipped, never injected.
 *
 * Usage:
 *   node scripts/notion-i18n/pull.mjs
 *   node scripts/notion-i18n/pull.mjs --dry-run
 *   node scripts/notion-i18n/pull.mjs --since-last-sync
 *
 * Requires: NOTION_TOKEN, NOTION_DATABASE_ID
 */

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
const currentFlat = Object.fromEntries(flattenMessages(pl).map((r) => [r.key, r.value]));
const updates = {};
let pulled = 0;
let skipped = 0;

for (const page of pages) {
  const row = readPageFields(page);
  if (!row.key) continue;

  // Approval gate: only Ready/Done rows are eligible. --since-last-sync narrows
  // that set to rows edited since the last pull; it never bypasses the status.
  if (!(row.status && PULL_STATUSES.has(row.status))) {
    skipped++;
    continue;
  }
  if (sinceLastSync && lastPullAt > 0 && Date.parse(row.lastEdited) <= lastPullAt) {
    skipped++;
    continue;
  }

  // Reject keys absent from the current pl.json template — a typo in Notion must
  // not inject new keys (or sparse null array slots) into the catalog.
  if (!(row.key in currentFlat)) {
    skipped++;
    console.warn(`[pull] skipping unknown key not in messages/pl.json: ${row.key}`);
    continue;
  }

  if (currentFlat[row.key] === row.polish) {
    skipped++;
    continue;
  }

  updates[row.key] = row.polish;
  pulled++;
  if (dryRun) {
    console.log(`[pull] ${row.key} (${row.status})`);
  }
}

if (pulled === 0) {
  console.log(`Nothing to pull (${skipped} rows skipped). Mark edited rows Ready/Done in Notion.`);
  process.exit(0);
}

const merged = { ...currentFlat, ...updates };
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
