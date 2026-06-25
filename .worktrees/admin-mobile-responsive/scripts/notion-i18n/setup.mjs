#!/usr/bin/env node
/**
 * One-time: create the Notion translations database under a parent page.
 *
 * Usage:
 *   node scripts/notion-i18n/setup.mjs
 *
 * Requires: NOTION_TOKEN, NOTION_PARENT_PAGE_ID
 * Prints NOTION_DATABASE_ID to add to .env
 */

import {
  loadDotEnv,
  requireEnv,
  NotionClient,
} from './lib.mjs';

loadDotEnv();

const token = requireEnv('NOTION_TOKEN');
const parentPageId = requireEnv('NOTION_PARENT_PAGE_ID');
const title = process.env.NOTION_DATABASE_TITLE?.trim() || 'ACC — Polish translations (pl.json)';

const notion = new NotionClient(token);
const db = await notion.createDatabase(parentPageId, title);

console.log('Created Notion database:');
console.log(`  title: ${title}`);
console.log(`  url:   ${db.url ?? '(open in Notion workspace)'}`);
console.log('');
console.log('Add to your .env:');
console.log(`NOTION_DATABASE_ID=${db.id}`);
