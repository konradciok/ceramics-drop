#!/usr/bin/env node
/**
 * Remove stale Namecheap-imported DNS records from a Cloudflare zone.
 * Keeps A/AAAA/CNAME (Worker custom domains). Drops legacy MX/TXT forwarding.
 *
 * Requires CLOUDFLARE_API_TOKEN with Zone.DNS Edit for the zone.
 * Create at: https://dash.cloudflare.com/profile/api-tokens (template: Edit zone DNS)
 */

const ZONE_ID = process.env.CLOUDFLARE_ZONE_ID ?? 'df154a46a71277a8b5b4a9e3d9af23ad';
const ZONE_NAME = process.env.CLOUDFLARE_ZONE_NAME ?? 'anna-ciok.studio';
const API_BASE = 'https://api.cloudflare.com/client/v4';

const STALE_MX = /eforward\d*\.registrar-servers\.com/i;
const STALE_TXT = /spf\.efwd\.registrar-servers\.com/i;

function token() {
  const t = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!t) {
    console.error(
      'Missing CLOUDFLARE_API_TOKEN. Create a token with Zone.DNS Edit for',
      ZONE_NAME,
      'and run:\n  set CLOUDFLARE_API_TOKEN=... && node scripts/cloudflare-dns-cleanup.mjs',
    );
    process.exit(1);
  }
  return t;
}

async function cf(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const body = await res.json();
  if (!body.success) {
    throw new Error(
      `Cloudflare API ${options.method ?? 'GET'} ${path}: ${JSON.stringify(body.errors)}`,
    );
  }
  return body;
}

function isStale(record) {
  if (record.type === 'MX' && STALE_MX.test(record.content)) return true;
  if (record.type === 'TXT' && STALE_TXT.test(record.content)) return true;
  return false;
}

async function listRecords() {
  const all = [];
  let page = 1;
  for (;;) {
    const { result, result_info: info } = await cf(
      `/zones/${ZONE_ID}/dns_records?per_page=100&page=${page}`,
    );
    all.push(...result);
    if (page >= info.total_pages) break;
    page += 1;
  }
  return all;
}

async function main() {
  console.log(`Zone: ${ZONE_NAME} (${ZONE_ID})`);
  const records = await listRecords();
  const stale = records.filter(isStale);
  const keep = records.filter((r) => !isStale(r));

  console.log(`\nKeeping ${keep.length} record(s):`);
  for (const r of keep) {
    console.log(`  ${r.type.padEnd(6)} ${r.name} -> ${r.content} (proxied=${r.proxied})`);
  }

  if (stale.length === 0) {
    console.log('\nNo stale MX/TXT forwarding records found.');
    return;
  }

  console.log(`\nDeleting ${stale.length} stale record(s):`);
  for (const r of stale) {
    console.log(`  ${r.type.padEnd(6)} ${r.name} -> ${r.content}`);
    await cf(`/zones/${ZONE_ID}/dns_records/${r.id}`, { method: 'DELETE' });
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
