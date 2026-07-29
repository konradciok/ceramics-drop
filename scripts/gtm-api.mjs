#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFiles();
const DEFAULT_SERVICE_ACCOUNT_KEY = resolve(repoRoot, '.secrets/gtm-api-deploy.json');
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID ?? 'anna-ciok-studio-analytics';
const SERVICE_ACCOUNT_EMAIL =
  process.env.GTM_SERVICE_ACCOUNT_EMAIL ??
  'gtm-api-deploy@anna-ciok-studio-analytics.iam.gserviceaccount.com';

const SCOPES = [
  'https://www.googleapis.com/auth/tagmanager.readonly',
  'https://www.googleapis.com/auth/tagmanager.edit.containers',
  'https://www.googleapis.com/auth/tagmanager.edit.containerversions',
  'https://www.googleapis.com/auth/tagmanager.publish',
];

const ANALYTICS_EVENTS = [
  'page_view',
  'view_item_list',
  'select_item',
  'view_item',
  'add_to_cart',
  'remove_from_cart',
  'view_cart',
  'begin_checkout',
  'purchase',
  'site_engagement',
];

// Top-level GA4 event params the native GA4 event tag forwards = the 15
// GA4-registered custom dimensions (audit 2026-07-28 §4) + page_path/page_title.
// `page_location` is added separately via the redaction variable; `ecommerce`
// rides sendEcommerceData natively — neither is listed here. Declared up here
// (not near the builders) so it is initialised before setupWorkspace() runs.
const GA4_EVENT_PARAMS = [
  'engagement_type', 'reason', 'status', 'method', 'page', 'locale',
  'from_locale', 'to_locale', 'filter_status', 'topic', 'locker_name',
  'item_id', 'item_category', 'app_version', 'app_git_sha',
  'page_path', 'page_title',
];

// Nested meta.* dataLayer keys the UI-managed Meta Pixel tags read (GTM
// dot-notation resolves these against the nested `meta` object).
const META_EVENT_PARAMS = [
  'meta.event_name', 'meta.event_id', 'meta.content_ids', 'meta.content_type',
  'meta.contents', 'meta.currency', 'meta.value', 'meta.num_items', 'meta.order_id',
];

// Every dataLayer key needing a `DLV - <key>` variable, deduped (page_path is
// shared). Read by both the native GA4 event tag and the UI Meta tags.
const DATALAYER_VARS = [
  ...new Set([
    ...GA4_EVENT_PARAMS,
    ...META_EVENT_PARAMS,
    'user_data.em',
    'event_id',
    'percent_scrolled',
    'engagement_seconds',
  ]),
];

const command = process.argv[2] ?? 'help';
const flags = new Set(process.argv.slice(3));

if (command === 'help' || command === '--help' || command === '-h') {
  printHelp();
  process.exit(0);
}

const auth = await createAuthClient();
const tagmanager = google.tagmanager({ version: 'v2', auth });

if (command === 'list') {
  await listContainers();
} else if (command === 'setup') {
  await setupWorkspace();
} else {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

async function listContainers() {
  const accounts = await tagmanager.accounts.list();
  for (const account of accounts.data.account ?? []) {
    console.log(`${account.name} | accountId=${account.accountId}`);
    const containers = await tagmanager.accounts.containers.list({
      parent: account.path,
    });
    for (const container of containers.data.container ?? []) {
      console.log(
        `  ${container.name} | containerId=${container.containerId} | publicId=${container.publicId}`,
      );
    }
  }
}

async function setupWorkspace() {
  const accountId = requiredEnv('GTM_ACCOUNT_ID');
  const containerId = requiredEnv('GTM_CONTAINER_ID');
  const gtmPublicId = requiredEnv('NEXT_PUBLIC_GTM_ID');
  const ga4MeasurementId = requiredEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID');
  const workspaceName = process.env.GTM_WORKSPACE_NAME ?? 'ACC analytics stack';
  const parent = `accounts/${accountId}/containers/${containerId}`;

  const container = await tagmanager.accounts.containers.get({ path: parent });
  if (container.data.publicId !== gtmPublicId) {
    throw new Error(
      `NEXT_PUBLIC_GTM_ID (${gtmPublicId}) does not match container publicId (${container.data.publicId}).`,
    );
  }

  const workspace = await getOrCreateWorkspace(parent, workspaceName);
  const trigger = await upsertTrigger(workspace.path, customEventTrigger());
  const initTrigger = await upsertTrigger(workspace.path, {
    name: 'ACC - Initialization',
    type: 'init',
  });
  const consentTrigger = await upsertTrigger(workspace.path, consentUpdateTrigger());

  // Meta routing triggers. The Meta Pixel template tags themselves are UI-imported
  // (the GTM API cannot import Community-Gallery templates), but their triggers are
  // pure API, so they are codified here and wired to the UI tags. Meta must NOT fire
  // on view_item_list/select_item/remove_from_cart/view_cart (the old bridge didn't).
  const metaStd = await upsertTrigger(workspace.path, metaStandardTrigger());
  const metaPv = await upsertTrigger(workspace.path, metaEqualsTrigger('ACC - meta page_view', 'page_view'));
  const metaEng = await upsertTrigger(workspace.path, metaEqualsTrigger('ACC - meta site_engagement', 'site_engagement'));

  // Data-layer + redaction variables the native GA4 event tag and the UI Meta tags
  // map. `Page Location - redacted` carries the N-1 redaction forward (v14 seed +
  // bridge refresh, now one fresh-evaluated variable).
  const existingVars =
    (await tagmanager.accounts.containers.workspaces.variables.list({ parent: workspace.path }))
      .data.variable ?? [];
  await upsertVariable(workspace.path, pageLocationRedactedVariable(), existingVars);
  for (const key of DATALAYER_VARS) {
    await upsertVariable(workspace.path, dataLayerVariable(key), existingVars);
  }

  await upsertTag(
    workspace.path,
    ga4ConfigTag(ga4MeasurementId, [initTrigger.triggerId, consentTrigger.triggerId]),
  );
  await upsertTag(workspace.path, ga4EventTag(ga4MeasurementId, [trigger.triggerId]));

  console.log(`Workspace ready: ${workspace.name} (${workspace.path})`);
  console.log(
    'Native GA4 tags: ACC - GA4 config (googtag, send_page_view:false) + ACC - GA4 event (gaawe) — replacing the Custom-HTML bridge.',
  );
  console.log(`Meta routing triggers ready: ${metaStd.name}, ${metaPv.name}, ${metaEng.name}.`);
  console.log(
    'Meta Pixel tags are UI-managed (gallery import + one-off API consent/trigger wiring, like Microsoft Clarity) — not created here.',
  );
  console.log(
    'ACC - GA4 config fires on ACC - Initialization + ACC - Consent Update (re-fire after mid-session Accept).',
  );

  if (flags.has('--publish')) {
    const version = await tagmanager.accounts.containers.workspaces.create_version({
      path: workspace.path,
      requestBody: {
        name: 'ACC analytics stack',
        notes:
          'Native GA4 (googtag + gaawe) + Meta Pixel template stack for Anna Ciok Ceramics ecommerce and engagement dataLayer events.',
      },
    });
    const versionPath = version.data.containerVersion?.path;
    if (!versionPath) throw new Error('GTM did not return a container version path.');
    await tagmanager.accounts.containers.versions.publish({ path: versionPath });
    console.log(`Published ${versionPath}.`);
  } else {
    console.log('Not published. Use GTM Preview first, then rerun with --publish if it looks good.');
  }
}

async function getOrCreateWorkspace(parent, name) {
  const list = await tagmanager.accounts.containers.workspaces.list({ parent });
  const existing = (list.data.workspace ?? []).find((workspace) => workspace.name === name);
  if (existing) {
    console.log(`Using existing workspace: ${existing.name}`);
    return existing;
  }

  const created = await tagmanager.accounts.containers.workspaces.create({
    parent,
    requestBody: {
      name,
      description:
        'Automated analytics workspace for GA4 ecommerce events, Meta Pixel standard events and engagement tracking.',
    },
  });
  console.log(`Created workspace: ${created.data.name}`);
  return created.data;
}

async function upsertTrigger(parent, body) {
  const list = await tagmanager.accounts.containers.workspaces.triggers.list({ parent });
  const existing = (list.data.trigger ?? []).find((trigger) => trigger.name === body.name);
  if (!existing) {
    const created = await tagmanager.accounts.containers.workspaces.triggers.create({
      parent,
      requestBody: body,
    });
    console.log(`Created trigger: ${created.data.name}`);
    return created.data;
  }

  const updated = await tagmanager.accounts.containers.workspaces.triggers.update({
    path: existing.path,
    requestBody: { ...existing, ...body },
  });
  console.log(`Updated trigger: ${updated.data.name}`);
  return updated.data;
}

async function upsertTag(parent, body) {
  const list = await tagmanager.accounts.containers.workspaces.tags.list({ parent });
  const existing = (list.data.tag ?? []).find((tag) => tag.name === body.name);
  if (!existing) {
    const created = await tagmanager.accounts.containers.workspaces.tags.create({
      parent,
      requestBody: body,
    });
    console.log(`Created tag: ${created.data.name}`);
    return created.data;
  }

  const updated = await tagmanager.accounts.containers.workspaces.tags.update({
    path: existing.path,
    requestBody: { ...existing, ...body },
  });
  console.log(`Updated tag: ${updated.data.name}`);
  return updated.data;
}

async function upsertVariable(parent, body, existingVars) {
  // existingVars lets a caller pre-fetch the variable list once and reuse it
  // across a batch (a ~30-var loop would otherwise re-list on every call).
  const variables =
    existingVars ??
    (await tagmanager.accounts.containers.workspaces.variables.list({ parent })).data.variable ??
    [];
  const existing = variables.find((variable) => variable.name === body.name);
  if (!existing) {
    const created = await tagmanager.accounts.containers.workspaces.variables.create({
      parent,
      requestBody: body,
    });
    console.log(`Created variable: ${created.data.name}`);
    return created.data;
  }

  const updated = await tagmanager.accounts.containers.workspaces.variables.update({
    path: existing.path,
    requestBody: { ...existing, ...body },
  });
  console.log(`Updated variable: ${updated.data.name}`);
  return updated.data;
}

function customEventTrigger() {
  return {
    name: 'ACC - analytics dataLayer events',
    type: 'customEvent',
    customEventFilter: [
      {
        type: 'matchRegex',
        parameter: [
          templateParam('arg0', '{{_event}}'),
          templateParam('arg1', `^(${ANALYTICS_EVENTS.join('|')})$`),
        ],
      },
    ],
  };
}

function consentUpdateTrigger() {
  return {
    name: 'ACC - Consent Update',
    type: 'customEvent',
    customEventFilter: [
      {
        type: 'equals',
        parameter: [
          templateParam('arg0', '{{_event}}'),
          templateParam('arg1', 'consent_update'),
        ],
      },
    ],
  };
}

function templateParam(key, value) {
  return { key, type: 'template', value };
}

function boolParam(key, value) {
  return { key, type: 'boolean', value: String(value) };
}

function listParam(key, list) {
  return { key, type: 'list', list };
}

function mapEntry(map) {
  return { type: 'map', map };
}

/** GA4 event-parameter / user-property row: { name, value }. */
function nameValue(name, value) {
  return mapEntry([templateParam('name', name), templateParam('value', value)]);
}

/** Google-tag configSettingsTable row: { parameter, parameterValue }. */
function configRow(parameter, parameterValue) {
  return mapEntry([templateParam('parameter', parameter), templateParam('parameterValue', parameterValue)]);
}

function consentNeeded(type) {
  return {
    consentStatus: 'needed',
    // Same list-Parameter shape customHtmlTag() used (a bare array fails with
    // "Proto field is not repeating, cannot start list").
    consentType: { type: 'list', list: [{ type: 'template', value: type }] },
  };
}

// N-1 carry-forward: mirrors redactSensitiveUrl() (src/lib/analytics.ts) and the
// privacy plan's inline redactLocation() (was in ga4BaseHtml/ga4BridgeHtml, v14).
// Evaluated fresh on every hit, so it is inherently sticky across SPA navigation —
// this ONE variable replaces both the v14 config seed and the bridge gtag('set')
// refresh. Keep the key list in sync with SENSITIVE_QUERY_PARAMS in analytics.ts.
function pageLocationRedactedVariable() {
  return {
    name: 'Page Location - redacted',
    type: 'jsm',
    parameter: [
      templateParam(
        'javascript',
        `function(){\n  try {\n    var u = new URL(document.location.href);\n    var keys = ['order','payment_intent','payment_intent_client_secret','sale','preview'];\n    for (var i=0;i<keys.length;i++){ if(u.searchParams.has(keys[i])){ u.searchParams.set(keys[i],'redacted'); } }\n    return u.toString();\n  } catch(e){ return document.location.href; }\n}`,
      ),
    ],
  };
}

function ga4ConfigTag(measurementId, firingTriggerId) {
  return {
    name: 'ACC - GA4 config',
    type: 'googtag',
    parameter: [
      templateParam('tagId', measurementId),
      listParam('configSettingsTable', [
        configRow('send_page_view', 'false'),
        // N-1: clean default page_location for GA4 auto-events (session_start,
        // first_visit, user_engagement, scroll) that fire outside our event tag.
        configRow('page_location', '{{Page Location - redacted}}'),
      ]),
    ],
    firingTriggerId,
    // Must be 'unlimited', not 'oncePerLoad': the config fires on Init AND on
    // ACC - Consent Update so it recovers after a mid-session Accept. oncePerLoad
    // budgets one fire per load, which the consent-blocked Init fire consumes
    // (the quirk noted in docs/analytics-stack.md) — so the re-fire never lands.
    // Native googtag config is idempotent, so re-firing is safe.
    tagFiringOption: 'unlimited',
    priority: { key: 'priority', type: 'integer', value: '20' },
    consentSettings: consentNeeded('analytics_storage'),
  };
}

function ga4EventTag(measurementId, firingTriggerId) {
  return {
    name: 'ACC - GA4 event',
    type: 'gaawe',
    parameter: [
      templateParam('eventName', '{{Event}}'),
      boolParam('sendEcommerceData', true),
      templateParam('getEcommerceDataFrom', 'dataLayer'),
      // NB: measurementIdOverride, NOT measurementId — a wrong/empty key fails with
      // "vendorTemplate.parameter.measurementIdOverride: The value must not be empty".
      templateParam('measurementIdOverride', measurementId),
      listParam('eventParameters', [
        // N-1: override gtag's ambient raw page_location on every app event too.
        nameValue('page_location', '{{Page Location - redacted}}'),
        ...GA4_EVENT_PARAMS.map((p) => nameValue(p, `{{DLV - ${p}}}`)),
      ]),
      // NB: deliberately NO GA4 user-provided data here. The old bridge's
      // gtag('set','user_data',{sha256_email_address}) fed GA4's User-Provided
      // Data (enhanced-conversions) API — NOT a user property. A user property
      // named sha256_email_address would neither feed UPD matching nor comply
      // with Google's PII-in-user-properties policy. Server-side GA4 MP already
      // sends hashed match data (src/lib/marketing/conversions.ts); if client-side
      // UPD is wanted, wire it via a native User-Provided Data variable during the
      // Task 4 Preview gate. (DLV - user_data.em is still used by the Meta tag.)
    ],
    firingTriggerId,
    tagFiringOption: 'oncePerEvent',
    consentSettings: consentNeeded('analytics_storage'),
  };
}

function dataLayerVariable(dlKey) {
  return {
    name: `DLV - ${dlKey}`,
    // 'v' = Data Layer Variable. NB: the "v2" is the dataLayerVersion param
    // below, NOT the type — GTM 400s ("Unknown entity type … v2") on type:'v2'.
    type: 'v',
    parameter: [
      templateParam('name', dlKey),
      { key: 'dataLayerVersion', type: 'integer', value: '2' },
      boolParam('setDefaultValue', false),
    ],
  };
}

function metaStandardTrigger() {
  return {
    name: 'ACC - meta standard events',
    type: 'customEvent',
    customEventFilter: [
      {
        type: 'matchRegex',
        parameter: [
          templateParam('arg0', '{{_event}}'),
          templateParam('arg1', '^(view_item|add_to_cart|begin_checkout|purchase)$'),
        ],
      },
    ],
  };
}

function metaEqualsTrigger(name, eventName) {
  return {
    name,
    type: 'customEvent',
    customEventFilter: [
      {
        type: 'equals',
        parameter: [
          templateParam('arg0', '{{_event}}'),
          templateParam('arg1', eventName),
        ],
      },
    ],
  };
}

/** Prefer the gtm-api-deploy service account key, then ADC. */
async function createAuthClient() {
  const keyFile = resolveCredentialsPath();
  if (keyFile) {
    console.log(`Using service account key: ${keyFile}`);
    return google.auth.getClient({
      keyFile,
      scopes: SCOPES,
    });
  }

  try {
    return await google.auth.getClient({ scopes: SCOPES });
  } catch (error) {
    if (!isMissingAdcError(error)) throw error;

    throw new Error(
      [
        'Google credentials not found for the Tag Manager API.',
        '',
        `Expected service account: ${SERVICE_ACCOUNT_EMAIL}`,
        `Expected project: ${GCP_PROJECT_ID}`,
        '',
        'Create the local key once:',
        `  gcloud config set project ${GCP_PROJECT_ID}`,
        '  npm run gtm:key',
        '',
        'Or set GOOGLE_APPLICATION_CREDENTIALS / GTM_SERVICE_ACCOUNT_KEY to a JSON key file.',
      ].join('\n'),
      { cause: error },
    );
  }
}

function resolveCredentialsPath() {
  const candidates = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    process.env.GTM_SERVICE_ACCOUNT_KEY,
    DEFAULT_SERVICE_ACCOUNT_KEY,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = isAbsolute(candidate) ? candidate : resolve(repoRoot, candidate);
    if (existsSync(resolved)) return resolved;
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

      const separator = trimmed.indexOf('=');
      if (separator === -1) continue;

      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      const current = process.env[key];
      if (current === undefined || current === '') process.env[key] = value;
    }
  }
}

function isMissingAdcError(error) {
  return error instanceof Error && error.message.includes('Could not load the default credentials');
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
        `Add it to ${resolve(repoRoot, '.env.local')} (see .env.example).`,
    );
  }
  const isPlaceholder =
    (name === 'NEXT_PUBLIC_GA4_MEASUREMENT_ID' && /^G-XXXXXXXXXX$/i.test(value)) ||
    (name === 'NEXT_PUBLIC_META_PIXEL_ID' && /^0+$/.test(value));
  if (isPlaceholder) {
    console.warn(
      `Warning: ${name} is still a placeholder (${value}). GTM tags will be created, but replace it with a real ID before publishing.`,
    );
  }
  return value;
}

function printHelp() {
  console.log(`Usage:
  npm run gtm:list
  npm run gtm:setup
  npm run gtm:setup -- --publish

Required for setup:
  GTM_ACCOUNT_ID
  GTM_CONTAINER_ID
  NEXT_PUBLIC_GTM_ID
  NEXT_PUBLIC_GA4_MEASUREMENT_ID
  (Meta Pixel tags are UI-managed; the pixel ID lives in the GTM UI, not here.)

Authentication:
  npm run gtm:key              # create .secrets/gtm-api-deploy.json once
  GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json

Service account:
  ${SERVICE_ACCOUNT_EMAIL}
  project ${GCP_PROJECT_ID}`);
}
