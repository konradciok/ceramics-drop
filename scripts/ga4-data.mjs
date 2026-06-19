#!/usr/bin/env node
/**
 * GA4 Data API — query reports from the anna-ciok.studio GA4 property.
 *
 * Usage:
 *   npm run ga4:report
 *   npm run ga4:report -- --days 7
 *   npm run ga4:report -- sessions | purchases | funnel
 *
 * Prerequisites:
 *   1. npm run gtm:key   (creates .secrets/gtm-api-deploy.json)
 *   2. GA4 Admin → Property → Property Access Management:
 *      add gtm-api-deploy@anna-ciok-studio-analytics.iam.gserviceaccount.com as Viewer
 *   3. GA4_PROPERTY_ID set in .env.local
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFiles();

const DEFAULT_KEY = resolve(repoRoot, '.secrets/gtm-api-deploy.json');
const SA_EMAIL = process.env.GTM_SERVICE_ACCOUNT_EMAIL
  ?? 'gtm-api-deploy@anna-ciok-studio-analytics.iam.gserviceaccount.com';
const PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const args = process.argv.slice(2);
const DAYS = parseInt(args.find(a => a.startsWith('--days='))?.split('=')[1] ?? '30', 10);
const REPORT = args.find(a => !a.startsWith('-')) ?? 'all';
const GA4_BASE = 'https://analyticsdata.googleapis.com/v1beta';

if (!PROPERTY_ID) {
  console.error(
    'Missing GA4_PROPERTY_ID in .env.local\n' +
      'Find it: GA4 Admin → Property Settings → Property ID (a number, not G-XXXXX)',
  );
  process.exit(1);
}

const keyFile = resolveKeyFile();
if (!keyFile) {
  console.error(
    'No service account key found.\n' +
      'Run: npm run gtm:key\n' +
      'Or set GOOGLE_APPLICATION_CREDENTIALS to a key JSON path.',
  );
  process.exit(1);
}

console.log(`Using key: ${keyFile}`);
console.log(`Property: ${PROPERTY_ID}  |  Last ${DAYS} days\n`);

const auth = await google.auth.getClient({
  keyFile,
  scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
});
const { token } = await auth.getAccessToken();

if (REPORT === 'all' || REPORT === 'sessions') await reportSessions();
if (REPORT === 'all' || REPORT === 'purchases') await reportPurchases();
if (REPORT === 'all' || REPORT === 'funnel') await reportFunnel();

// ---------------------------------------------------------------------------

async function runReport(body) {
  const res = await fetch(`${GA4_BASE}/properties/${PROPERTY_ID}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  const data = await res.json();

  if (!res.ok) {
    if (res.status === 403) {
      console.error(
        `\nPermission denied (403) — the service account lacks GA4 property access.\n` +
          `Fix: GA4 Admin → Property → Property Access Management\n` +
          `     Add ${SA_EMAIL} as Viewer`,
      );
      process.exit(1);
    }
    throw new Error(`GA4 API error ${res.status}: ${data.error?.message ?? JSON.stringify(data)}`);
  }

  return data;
}

async function reportSessions() {
  console.log('=== Sessions & Users ===');
  const data = await runReport({
    dateRanges: [{ startDate: `${DAYS}daysAgo`, endDate: 'today' }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'bounceRate' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
  });
  printTable(data);
}

async function reportPurchases() {
  console.log('=== Purchases & Revenue by Category ===');
  const data = await runReport({
    dateRanges: [{ startDate: `${DAYS}daysAgo`, endDate: 'today' }],
    dimensions: [{ name: 'itemCategory' }],
    metrics: [
      { name: 'itemsViewed' },
      { name: 'itemsAddedToCart' },
      { name: 'itemsPurchased' },
      { name: 'itemRevenue' },
    ],
    orderBys: [{ metric: { metricName: 'itemsPurchased' }, desc: true }],
  });
  printTable(data);

  console.log('=== Overall Conversion ===');
  const totals = await runReport({
    dateRanges: [{ startDate: `${DAYS}daysAgo`, endDate: 'today' }],
    metrics: [
      { name: 'transactions' },
      { name: 'purchaseRevenue' },
      { name: 'purchaserConversionRate' },
    ],
  });
  printTable(totals);
}

async function reportFunnel() {
  console.log('=== Checkout Funnel ===');
  const data = await runReport({
    dateRanges: [{ startDate: `${DAYS}daysAgo`, endDate: 'today' }],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        inListFilter: { values: ['add_to_cart', 'begin_checkout', 'purchase'] },
      },
    },
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
  });
  printTable(data);
}

// ---------------------------------------------------------------------------

function printTable(response) {
  if (!response?.rows?.length) {
    console.log('  (no data)\n');
    return;
  }

  const headers = [
    ...(response.dimensionHeaders?.map(h => h.name) ?? []),
    ...(response.metricHeaders?.map(h => h.name) ?? []),
  ];

  const rows = response.rows.map(row => [
    ...(row.dimensionValues?.map(v => v.value) ?? []),
    ...(row.metricValues?.map(v => v.value) ?? []),
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => String(r[i] ?? '').length)),
  );

  console.log(headers.map((h, i) => h.padEnd(widths[i])).join('  '));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(row.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  '));
  }
  console.log();
}

function resolveKeyFile() {
  const candidates = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    process.env.GTM_SERVICE_ACCOUNT_KEY,
    DEFAULT_KEY,
  ].filter(Boolean);

  for (const c of candidates) {
    const p = isAbsolute(c) ? c : resolve(repoRoot, c);
    if (existsSync(p)) return p;
  }
  return null;
}

function loadEnvFiles() {
  for (const file of ['.env', '.env.local']) {
    const path = resolve(repoRoot, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const sep = trimmed.indexOf('=');
      if (sep === -1) continue;
      const key = trimmed.slice(0, sep).trim();
      const value = trimmed.slice(sep + 1).trim();
      if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
    }
  }
}
