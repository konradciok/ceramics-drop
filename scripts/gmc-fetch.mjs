#!/usr/bin/env node
/**
 * Merchant Center — refresh the scheduled-fetch product feeds NOW.
 *
 * Merchant Center pulls /api/feed/google on a daily schedule. After a CMS
 * publish of shipping rates or prices, run this so Google re-reads the feeds
 * within minutes instead of up to 24 h later (the on-page JSON-LD already
 * changed immediately; this closes the feed ↔ landing-page window). See
 * docs/shipping-rates-runbook.md.
 *
 * Usage:
 *   npm run gmc:fetch                      # dry run: lists the sources it WOULD fetch
 *   npm run gmc:fetch -- --confirm         # triggers a fetch of every scheduled-fetch source
 *   npm run gmc:fetch -- --confirm --only 10742148188
 *
 * Auth: a service account key with access to the Merchant Center account.
 *   --key-file <path> | GMC_KEY_FILE | GOOGLE_APPLICATION_CREDENTIALS
 * Account: --account <id> | GMC_ACCOUNT_ID (default 5587575053, "Anna Ciok - Art and Prints").
 * Scope `https://www.googleapis.com/auth/content` (Merchant API v1, datasources.fetch).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DEFAULT_ACCOUNT_ID = '5587575053';
const API = 'https://merchantapi.googleapis.com';

/** @param {string[]} argv */
export function parseArgs(argv) {
  const opts = { confirm: false, only: null, account: null, keyFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = (name) => {
      if (arg === `--${name}`) {
        const value = argv[i + 1];
        if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`);
        i += 1;
        return value;
      }
      return arg.startsWith(`--${name}=`) ? arg.slice(name.length + 3) : undefined;
    };
    if (arg === '--confirm') opts.confirm = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else {
      const only = take('only');
      const account = take('account');
      const keyFile = take('key-file');
      if (only !== undefined) opts.only = only;
      else if (account !== undefined) opts.account = account;
      else if (keyFile !== undefined) opts.keyFile = keyFile;
      else throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (opts.only !== null && !/^\d+$/.test(opts.only)) throw new Error('--only must be a numeric data source id');
  if (opts.account !== null && !/^\d+$/.test(opts.account)) throw new Error('--account must be a numeric account id');
  return opts;
}

/**
 * Only scheduled-fetch FILE sources can be refreshed; API/other inputs have no
 * fetch to trigger. `only` narrows to a single data source id.
 * @param {Array<Record<string, any>>} dataSources
 * @param {string | null} only
 */
export function selectFetchSources(dataSources, only = null) {
  return dataSources.filter((ds) => {
    if (ds.input !== 'FILE' || ds.fileInput?.fileInputType !== 'FETCH') return false;
    return only === null || ds.dataSourceId === only;
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: npm run gmc:fetch -- [--confirm] [--only <dataSourceId>] [--account <id>] [--key-file <path>]');
    return;
  }
  const keyFile = opts.keyFile ?? process.env.GMC_KEY_FILE ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyFile) {
    throw new Error('No service account key: pass --key-file, or set GMC_KEY_FILE / GOOGLE_APPLICATION_CREDENTIALS.');
  }
  const resolvedKey = resolve(keyFile);
  if (!existsSync(resolvedKey)) throw new Error(`Key file not found: ${resolvedKey}`);
  const account = opts.account ?? process.env.GMC_ACCOUNT_ID ?? DEFAULT_ACCOUNT_ID;

  const { google } = await import('googleapis');
  const auth = new google.auth.GoogleAuth({ keyFile: resolvedKey, scopes: ['https://www.googleapis.com/auth/content'] });
  const client = await auth.getClient();

  const listed = await client.request({ url: `${API}/datasources/v1/accounts/${account}/dataSources` });
  const sources = selectFetchSources(listed.data.dataSources ?? [], opts.only);
  if (sources.length === 0) {
    console.error('No scheduled-fetch data sources matched.');
    process.exitCode = 1;
    return;
  }

  console.log(`${opts.confirm ? 'Fetching' : 'Dry run — would fetch'} ${sources.length} source(s) for account ${account}:`);
  for (const ds of sources) {
    const p = ds.primaryProductDataSource ?? {};
    console.log(`  ${ds.dataSourceId}  ${p.feedLabel ?? '-'}/${p.contentLanguage ?? '-'}  ${ds.fileInput.fetchSettings?.fetchUri ?? '-'}`);
  }
  if (!opts.confirm) {
    console.log('\nNothing triggered. Re-run with --confirm to start the fetches.');
    return;
  }

  let failed = 0;
  for (const ds of sources) {
    const res = await client.request({ url: `${API}/datasources/v1/${ds.name}:fetch`, method: 'POST', data: {}, validateStatus: () => true });
    const ok = res.status >= 200 && res.status < 300;
    if (!ok) failed += 1;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${ds.dataSourceId} (HTTP ${res.status})${ok ? '' : ` ${JSON.stringify(res.data?.error?.message ?? res.data)}`}`);
  }
  if (failed > 0) {
    console.error(`\n${failed} fetch(es) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nFetches requested. Merchant Center processes them asynchronously (usually within minutes).');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
