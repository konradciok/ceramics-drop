#!/usr/bin/env node
/**
 * BigQuery — query raw GA4 event data exported to anna-ciok-studio-analytics.
 *
 * Usage:
 *   npm run bq:query
 *   npm run bq:query -- --days 7
 *   npm run bq:query -- purchases | demand | funnel
 *
 * Prerequisites (one-time manual setup):
 *   1. npm run gtm:key   (creates .secrets/gtm-api-deploy.json)
 *   2. GCP IAM: grant the service account roles/bigquery.dataViewer + roles/bigquery.jobUser
 *      https://console.cloud.google.com/iam-admin/iam?project=anna-ciok-studio-analytics
 *   3. GA4 Admin → Property → BigQuery Links → New Link → select anna-ciok-studio-analytics
 *      Dataset: analytics_raw  |  Export: daily (or streaming)
 *   4. BIGQUERY_DATASET_ID set in .env.local (default: analytics_raw)
 *   5. GA4_PROPERTY_ID set in .env.local
 *
 * Note: GA4 export starts flowing ~24h after the BigQuery Link is created.
 *       Tables are date-sharded: analytics_raw.events_YYYYMMDD
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { BigQuery } from '@google-cloud/bigquery';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFiles();

const DEFAULT_KEY = resolve(repoRoot, '.secrets/gtm-api-deploy.json');
const GCP_PROJECT = process.env.GCP_PROJECT_ID ?? 'anna-ciok-studio-analytics';
const DATASET = process.env.BIGQUERY_DATASET_ID ?? 'analytics_raw';
const BQ_LOCATION = process.env.BIGQUERY_LOCATION ?? 'europe-west1';
const PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const args = process.argv.slice(2);
const DAYS = parseInt(args.find(a => a.startsWith('--days='))?.split('=')[1] ?? '7', 10);
const REPORT = args.find(a => !a.startsWith('-')) ?? 'all';

if (!PROPERTY_ID) {
  console.error('Missing GA4_PROPERTY_ID in .env.local');
  process.exit(1);
}

const keyFile = resolveKeyFile();
if (!keyFile) {
  console.error('No service account key found. Run: npm run gtm:key');
  process.exit(1);
}

console.log(`Using key: ${keyFile}`);
console.log(`Project: ${GCP_PROJECT}  |  Dataset: ${DATASET}  |  Last ${DAYS} days\n`);

const bq = new BigQuery({ projectId: GCP_PROJECT, keyFilename: keyFile });

// Verify dataset exists before running queries
await checkDatasetExists();

// Table wildcard covers all date-sharded event tables
const TABLE = `\`${GCP_PROJECT}.${DATASET}.events_*\``;
const DATE_FILTER = `_TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE(), INTERVAL ${DAYS} DAY)) AND FORMAT_DATE('%Y%m%d', CURRENT_DATE())`;

if (REPORT === 'all' || REPORT === 'purchases') await reportPurchases();
if (REPORT === 'all' || REPORT === 'demand') await reportDemand();
if (REPORT === 'all' || REPORT === 'funnel') await reportFunnel();

async function checkDatasetExists() {
  const [datasets] = await bq.getDatasets();
  const names = datasets.map(d => d.id);
  if (!names.includes(DATASET)) {
    console.error(
      `Dataset '${DATASET}' not found in project '${GCP_PROJECT}'.\n` +
        `Available datasets: ${names.length ? names.join(', ') : '(none)'}\n\n` +
        `To set up the GA4 BigQuery export:\n` +
        `  GA4 Admin → Property → BigQuery Links → New Link\n` +
        `  Select project: ${GCP_PROJECT}  |  Dataset: ${DATASET}\n` +
        `  Data flows ~24h after linking.`,
    );
    process.exit(1);
  }
  console.log(`Dataset '${DATASET}' found. Querying...\n`);
}

// ---------------------------------------------------------------------------

async function reportPurchases() {
  console.log('=== Purchase Events ===');
  const query = `
    SELECT
      FORMAT_TIMESTAMP('%Y-%m-%d', TIMESTAMP_MICROS(event_timestamp)) AS date,
      (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'transaction_id') AS transaction_id,
      (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'currency') AS currency,
      (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'value') AS revenue_pln,
      ARRAY_LENGTH(items) AS item_count
    FROM ${TABLE}
    WHERE ${DATE_FILTER}
      AND event_name = 'purchase'
    ORDER BY date DESC
    LIMIT 50
  `;
  await runAndPrint(query);
}

async function reportDemand() {
  console.log('=== Category Demand (view_item_list) ===');
  const query = `
    SELECT
      items.item_category AS category,
      COUNT(*) AS views,
      COUNT(DISTINCT user_pseudo_id) AS unique_users
    FROM ${TABLE},
      UNNEST(items) AS items
    WHERE ${DATE_FILTER}
      AND event_name = 'view_item_list'
      AND items.item_category IS NOT NULL
    GROUP BY category
    ORDER BY views DESC
  `;
  await runAndPrint(query);
}

async function reportFunnel() {
  console.log('=== Checkout Funnel ===');
  const query = `
    SELECT
      event_name,
      COUNT(*) AS event_count,
      COUNT(DISTINCT user_pseudo_id) AS unique_users
    FROM ${TABLE}
    WHERE ${DATE_FILTER}
      AND event_name IN ('add_to_cart', 'begin_checkout', 'purchase')
    GROUP BY event_name
    ORDER BY event_count DESC
  `;
  await runAndPrint(query);
}

// ---------------------------------------------------------------------------

async function runAndPrint(query) {
  try {
    const [rows] = await bq.query({ query, location: BQ_LOCATION });

    if (!rows.length) {
      console.log('  (no data — check that the BigQuery export has been running ≥24h)\n');
      return;
    }

    const headers = Object.keys(rows[0]);
    const widths = headers.map(h =>
      Math.max(h.length, ...rows.map(r => String(r[h] ?? '').length)),
    );

    console.log(headers.map((h, i) => h.padEnd(widths[i])).join('  '));
    console.log(widths.map(w => '-'.repeat(w)).join('  '));
    for (const row of rows) {
      console.log(headers.map((h, i) => String(row[h] ?? '').padEnd(widths[i])).join('  '));
    }
    console.log();
  } catch (err) {
    if (err.message?.includes('Not found')) {
      console.log(
        `  (table not found — the GA4 BigQuery export may not be set up yet)\n` +
          `  Expected: ${GCP_PROJECT}.${DATASET}.events_YYYYMMDD\n`,
      );
    } else {
      throw err;
    }
  }
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
