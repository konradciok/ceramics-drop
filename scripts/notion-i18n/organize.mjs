#!/usr/bin/env node
/**
 * Backfill Area / Page / Section on existing Notion rows (no text changes).
 *
 * Usage: node scripts/notion-i18n/organize.mjs
 */

import {
  loadDotEnv,
  requireEnv,
  classifyKey,
  readPageFields,
  richText,
  NotionClient,
  sleep,
} from './lib.mjs';

loadDotEnv();

const token = requireEnv('NOTION_TOKEN');
const databaseId = requireEnv('NOTION_DATABASE_ID');
const notion = new NotionClient(token);

const pages = await notion.queryAll(databaseId);
let updated = 0;
let skipped = 0;

for (const row of pages) {
  const fields = readPageFields(row);
  if (!fields.key) continue;

  const want = classifyKey(fields.key);
  if (
    fields.area === want.area &&
    fields.page === want.page &&
    fields.section === want.section
  ) {
    skipped++;
    continue;
  }

  await notion.updatePage(row.id, {
    Area: { select: { name: want.area } },
    Page: { select: { name: want.page } },
    Section: { rich_text: richText(want.section) },
  });
  updated++;
  if (updated % 25 === 0) console.log(`… ${updated} updated, ${skipped} skipped`);
  await sleep(350);
}

console.log(`Organize complete: ${updated} updated, ${skipped} already grouped.`);
