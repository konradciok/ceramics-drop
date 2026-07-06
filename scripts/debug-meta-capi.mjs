#!/usr/bin/env node
/**
 * Diagnose Meta Conversions API failures (the `meta capi purchase http error 400`
 * issues piling up in Sentry) without ever printing the access token.
 *
 * Meta's Graph API returns HTTP 400 for both "malformed payload" and "credentials
 * mismatch" (wrong/expired token, or a token that isn't authorized for this pixel),
 * and `src/lib/marketing/meta-capi.ts` currently only logs the status code, not the
 * response body — so Sentry can't tell you which one it is. This script calls the
 * same Graph API surface directly and prints Meta's real error body.
 *
 * Usage:
 *   node scripts/debug-meta-capi.mjs
 *   META_CAPI_ACCESS_TOKEN=<prod token> node scripts/debug-meta-capi.mjs --pixel-id 535651705450454
 *   node scripts/debug-meta-capi.mjs --send --test-event-code TEST12345
 *
 * Prefer the env var over --token: shell history and `ps` both expose CLI
 * arguments to anyone else on the machine, so `export META_CAPI_ACCESS_TOKEN=...`
 * (or `.dev.vars`/`.env.local` for a local-only value) is safer than passing the
 * token as an argument. --token is still supported for one-off copy/paste checks,
 * but prints a warning when used.
 *
 * Precedence for pixel id / token (highest wins): 1. --pixel-id / --token CLI
 * flags, 2. process.env, 3. .dev.vars, 4. .env.local. To check the values
 * actually live on the Worker, run this with the *production*
 * META_CAPI_ACCESS_TOKEN (get it from Meta Events Manager → Settings →
 * Conversions API, or your password manager if you generated it there) —
 * `wrangler secret put` values cannot be read back, only replaced, so a
 * mismatch can only be confirmed against the real deployed value.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GRAPH_API_VERSION = 'v21.0';

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  const parsed = {};
  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf('=');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

// Precedence low -> high: .env.local, then .dev.vars, then process.env (each
// spread overrides the previous). getArg() in main() then outranks all three.
function loadLocalEnv() {
  return {
    ...parseEnvFile(resolve(repoRoot, '.env.local')),
    ...parseEnvFile(resolve(repoRoot, '.dev.vars')),
    ...process.env,
  };
}

function getArg(name) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function mask(secret) {
  if (!secret) return '(empty)';
  if (secret.length <= 10) return '*'.repeat(secret.length);
  return `${secret.slice(0, 6)}...${secret.slice(-4)} (len=${secret.length})`;
}

async function graphGet(path, params) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body };
}

/**
 * Classifies a failed Graph API call so the final verdict doesn't lump
 * transient errors (rate limits, Meta-side 5xx) or plain payload mistakes in
 * with an actual credentials/permission mismatch.
 *
 * - "mismatch"      — OAuthException (codes 10/190/200/...), or the classic
 *                      GraphMethodException/code 100 "object does not exist /
 *                      missing permission" shape — the "token can't see this
 *                      pixel" case. Code 100 is Meta's generic invalid-parameter
 *                      error and is *also* used for unrelated malformed
 *                      requests, so it's only treated as a mismatch when the
 *                      message matches that specific shape (see below) — a
 *                      bare `code === 100` is NOT sufficient on its own.
 * - "indeterminate" — 429 (rate limited) or 5xx (Meta-side issue) — re-run
 *                      later, this run proves nothing either way.
 * - "unknown"       — anything else (e.g. a malformed request) — don't claim
 *                      it's a credentials problem.
 */
function classifyGraphFailure(status, errorObj) {
  const code = errorObj?.code;
  const type = errorObj?.type;
  const message = String(errorObj?.message ?? '');
  if (type === 'OAuthException') return 'mismatch';
  if (type === 'GraphMethodException' && code === 100 && /does not exist|missing permission/i.test(message)) {
    return 'mismatch';
  }
  if (status === 429 || status >= 500) return 'indeterminate';
  return 'unknown';
}

async function main() {
  const env = loadLocalEnv();
  const pixelId = getArg('pixel-id') ?? env.NEXT_PUBLIC_META_PIXEL_ID;
  const tokenFromArg = getArg('token');
  const token = tokenFromArg ?? env.META_CAPI_ACCESS_TOKEN;
  const testEventCode = getArg('test-event-code') ?? env.META_TEST_EVENT_CODE;
  const send = hasFlag('send');

  if (tokenFromArg) {
    console.log(
      'WARNING: --token was passed on the command line. That value is visible in shell history and to ' +
        'anyone who can run `ps` on this machine while the script runs. Prefer `export META_CAPI_ACCESS_TOKEN=...` ' +
        '(or .dev.vars for a local-only value) instead.\n',
    );
  }

  console.log('Meta CAPI credentials check');
  console.log('============================');
  console.log(`pixel id : ${pixelId ?? '(missing)'}`);
  console.log(`token    : ${mask(token)}`);
  console.log('');

  if (!pixelId) throw new Error('No pixel id. Pass --pixel-id or set NEXT_PUBLIC_META_PIXEL_ID.');
  if (!token) {
    throw new Error(
      'No access token. Set the META_CAPI_ACCESS_TOKEN env var (preferred) or pass --token <value>, using the ' +
        'token you set via `wrangler secret put META_CAPI_ACCESS_TOKEN` (that command cannot read the value back, ' +
        'so it must come from wherever you generated/stored it — Meta Events Manager → Settings → Conversions API ' +
        '→ generate access token, or your password manager).',
    );
  }

  let verdictInvalidToken = false;
  let verdictMismatch = false;
  let verdictIndeterminate = false;
  let verdictPayloadError = false;

  // Step 1: what is this token, and what can it see?
  console.log('1. debug_token — what app/pixel(s) is this token actually scoped to?');
  const debug = await graphGet('debug_token', { input_token: token, access_token: token });
  if (!debug.ok) {
    const kind = classifyGraphFailure(debug.status, debug.body.error);
    if (kind === 'indeterminate') {
      verdictIndeterminate = true;
      console.log(`   HTTP ${debug.status} — Meta-side/rate-limit issue, not conclusive:`);
    } else {
      verdictInvalidToken = true;
      console.log(`   HTTP ${debug.status} — token itself is rejected:`);
    }
    console.log('  ', JSON.stringify(debug.body.error ?? debug.body, null, 2).split('\n').join('\n   '));
  } else {
    const data = debug.body.data ?? {};
    console.log(`   app_id:       ${data.app_id ?? '(none)'}`);
    console.log(`   application:  ${data.application ?? '(none)'}`);
    console.log(`   is_valid:     ${data.is_valid}`);
    console.log(`   expires_at:   ${data.expires_at ? new Date(data.expires_at * 1000).toISOString() : '(never / not set)'}`);
    console.log(`   scopes:       ${(data.scopes ?? []).join(', ') || '(none)'}`);
    if (Array.isArray(data.granular_scopes) && data.granular_scopes.length > 0) {
      console.log('   granular_scopes:');
      for (const gs of data.granular_scopes) {
        console.log(`     - ${gs.scope}: target_ids=${JSON.stringify(gs.target_ids ?? [])}`);
      }
      const adsScopes = data.granular_scopes.filter((gs) => /ads_management|business_management/.test(gs.scope));
      const coversPixel = adsScopes.some((gs) => (gs.target_ids ?? []).includes(String(pixelId)));
      if (adsScopes.length > 0 && !coversPixel) {
        verdictMismatch = true;
        console.log(`   \u26a0 none of the granular ad-scopes list pixel ${pixelId} in target_ids.`);
      }
    }
    if (data.is_valid === false) verdictInvalidToken = true;
  }
  console.log('');

  // Step 2: can this token actually read the pixel we send events to?
  console.log(`2. GET /${pixelId} — can this token read the pixel itself?`);
  const pixelInfo = await graphGet(String(pixelId), { fields: 'id,name', access_token: token });
  if (pixelInfo.ok) {
    console.log(`   OK — token can read pixel: ${JSON.stringify(pixelInfo.body)}`);
  } else {
    const kind = classifyGraphFailure(pixelInfo.status, pixelInfo.body.error);
    if (kind === 'mismatch') {
      verdictMismatch = true;
      console.log(`   HTTP ${pixelInfo.status} — token cannot read this pixel (looks like a credentials/permission mismatch):`);
    } else if (kind === 'indeterminate') {
      verdictIndeterminate = true;
      console.log(`   HTTP ${pixelInfo.status} — Meta-side/rate-limit issue, not conclusive:`);
    } else {
      console.log(`   HTTP ${pixelInfo.status} — failed, but not clearly a credentials issue:`);
    }
    console.log('  ', JSON.stringify(pixelInfo.body.error ?? pixelInfo.body, null, 2).split('\n').join('\n   '));
  }
  console.log('');

  // Step 3 (optional, explicit opt-in): fire one real event and show the raw error body.
  if (send) {
    console.log(`3. POST /${pixelId}/events — sending one diagnostic event${testEventCode ? ' (test mode)' : ' (LIVE — no test_event_code set!)'}`);
    if (!testEventCode) {
      console.log('   Refusing to send a live event without --test-event-code — pass one from Events Manager → Test Events, or set META_TEST_EVENT_CODE.');
    } else {
      const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(token)}`;
      const payload = {
        data: [
          {
            event_name: 'Purchase',
            event_time: Math.floor(Date.now() / 1000),
            event_id: `debug-meta-capi-${Date.now()}`,
            action_source: 'website',
            user_data: { client_ip_address: '127.0.0.1', client_user_agent: 'debug-meta-capi-script' },
            custom_data: { currency: 'PLN', value: 1 },
          },
        ],
        test_event_code: testEventCode,
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      console.log(`   HTTP ${res.status}`);
      console.log('  ', JSON.stringify(body, null, 2).split('\n').join('\n   '));
      if (!res.ok) {
        const kind = classifyGraphFailure(res.status, body.error);
        if (kind === 'mismatch') verdictMismatch = true;
        else if (kind === 'indeterminate') verdictIndeterminate = true;
        else verdictPayloadError = true;
      }
    }
    console.log('');
  }

  console.log('Verdict');
  console.log('=======');
  if (verdictInvalidToken) {
    console.log('The token itself is invalid or expired — regenerate it in Meta Events Manager and re-run:');
    console.log('  npx wrangler secret put META_CAPI_ACCESS_TOKEN');
  } else if (verdictMismatch) {
    console.log(`Credentials mismatch confirmed: this token does not have access to pixel ${pixelId}.`);
    console.log('Either the token was generated for a different pixel/dataset, or it is missing');
    console.log('ads_management scope for this one. Fix: in Meta Events Manager, open the pixel with');
    console.log(`id ${pixelId}, go to Settings -> Conversions API -> generate a token scoped to THIS pixel,`);
    console.log('then `npx wrangler secret put META_CAPI_ACCESS_TOKEN` with the new value.');
    console.log('Also double-check NEXT_PUBLIC_META_PIXEL_ID in the Workers Build config matches this pixel id.');
  } else if (verdictPayloadError) {
    console.log('The token/pixel pair looks fine (steps 1-2 passed) — the failure in step 3 was Meta rejecting');
    console.log('the *event payload* itself, not the credentials. Check the error message/code printed above');
    console.log('against the fields sent by src/lib/marketing/conversions.ts (currency, value, contents, etc.),');
    console.log('not the token or pixel id.');
  } else if (verdictIndeterminate) {
    console.log('Meta returned a rate-limit or server-side error during this check — inconclusive either way.');
    console.log('Wait a bit and re-run before concluding there is (or isn\u2019t) a credentials mismatch.');
  } else {
    console.log('No mismatch detected between this token and this pixel id.');
    console.log('If production is still failing, re-run this script with the exact token/pixel-id');
    console.log('pair currently deployed (Workers Build env var + `wrangler secret put` value) — a stale');
    console.log('local .env.local/.dev.vars value would hide a real production-only mismatch.');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
