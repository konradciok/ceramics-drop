#!/usr/bin/env node
/**
 * Diagnose Notion i18n setup (token, database access, sharing).
 *
 * Usage: node scripts/notion-i18n/check.mjs
 */

import { loadDotEnv, requireEnv, NotionClient } from './lib.mjs';

loadDotEnv();

const token = requireEnv('NOTION_TOKEN');
const databaseId = process.env.NOTION_DATABASE_ID?.trim();
const notion = new NotionClient(token);

let ok = true;

try {
  const me = await notion.request('GET', '/users/me');
  console.log(`✓ Token valid — integration "${me.name}" (${me.type})`);
} catch (e) {
  console.error(`✗ Token invalid: ${e.message}`);
  process.exit(1);
}

const search = await notion.request('POST', '/search', { page_size: 1 });
const visible = search.results?.length ?? 0;
if (visible === 0) {
  console.error(
    '✗ Integration cannot see any pages or databases yet.\n' +
      '  In Notion: open the translations database (or a parent page) → ⋯ → Connections → add your integration.',
  );
  ok = false;
} else {
  console.log(`✓ Integration has access to at least one page/database`);
}

if (!databaseId) {
  console.error('✗ NOTION_DATABASE_ID is not set in .env');
  ok = false;
} else {
  try {
    const db = await notion.request('GET', `/databases/${databaseId}`);
    const title = db.title?.map((t) => t.plain_text).join('') || databaseId;
    console.log(`✓ Database accessible: "${title}" (${databaseId})`);
  } catch (e) {
    ok = false;
    if (e.message.includes('404')) {
      console.error(
        `✗ Cannot access database ${databaseId}.\n` +
          '  The ID may be wrong, or the database is not shared with this integration.\n' +
          '  Fix: open https://app.notion.com/p/' +
          databaseId.replace(/-/g, '') +
          ' → ⋯ → Connections → add your integration (same name as above).',
      );
    } else {
      console.error(`✗ Database check failed: ${e.message}`);
    }
  }
}

if (!ok) {
  console.error('\nAfter sharing, run: npm run i18n:check && npm run i18n:push');
  process.exit(1);
}

console.log('\nReady. Run: npm run i18n:push');
