#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFiles();
const DEFAULT_SERVICE_ACCOUNT_KEY = resolve(repoRoot, '.secrets/gtm-api-deploy.json');
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID ?? 'bloomy-tale-477216';
const SERVICE_ACCOUNT_EMAIL =
  process.env.GTM_SERVICE_ACCOUNT_EMAIL ??
  'gtm-api-deploy@bloomy-tale-477216.iam.gserviceaccount.com';

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
  const metaPixelId = requiredEnv('NEXT_PUBLIC_META_PIXEL_ID');
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

  await upsertTag(
    workspace.path,
    customHtmlTag('ACC - GA4 base', ga4BaseHtml(ga4MeasurementId), [initTrigger.triggerId], {
      oncePerLoad: true,
      priority: 20,
    }),
  );
  await upsertTag(
    workspace.path,
    customHtmlTag('ACC - Meta Pixel base', metaBaseHtml(metaPixelId), [initTrigger.triggerId], {
      oncePerLoad: true,
      priority: 10,
    }),
  );
  await upsertTag(
    workspace.path,
    customHtmlTag('ACC - GA4 dataLayer bridge', ga4BridgeHtml(), [trigger.triggerId]),
  );
  await upsertTag(
    workspace.path,
    customHtmlTag('ACC - Meta dataLayer bridge', metaBridgeHtml(), [trigger.triggerId]),
  );

  console.log(`Workspace ready: ${workspace.name} (${workspace.path})`);
  console.log('Created/updated GTM tags: GA4 base, Meta base, GA4 bridge, Meta bridge.');

  if (flags.has('--publish')) {
    const version = await tagmanager.accounts.containers.workspaces.create_version({
      path: workspace.path,
      requestBody: {
        name: 'ACC analytics stack',
        notes:
          'GA4 + Meta Pixel stack for Anna Ciok Ceramics ecommerce and engagement dataLayer events.',
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

function customHtmlTag(name, html, firingTriggerId, options = {}) {
  return {
    name,
    type: 'html',
    parameter: [
      templateParam('html', html),
      { key: 'supportDocumentWrite', type: 'boolean', value: 'false' },
    ],
    firingTriggerId,
    tagFiringOption: options.oncePerLoad ? 'oncePerLoad' : 'oncePerEvent',
    ...(options.priority
      ? { priority: { key: 'priority', type: 'integer', value: String(options.priority) } }
      : {}),
  };
}

function templateParam(key, value) {
  return { key, type: 'template', value };
}

function ga4BaseHtml(measurementId) {
  return `<script>
(function(w,d,s,id){
  w.dataLayer = w.dataLayer || [];
  w.gtag = w.gtag || function(){ w.dataLayer.push(arguments); };
  w.gtag('js', new Date());
  w.gtag('config', id, { send_page_view: false });
  var firstScript = d.getElementsByTagName(s)[0];
  var tag = d.createElement(s);
  tag.async = true;
  tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
  firstScript.parentNode.insertBefore(tag, firstScript);
})(window, document, 'script', '${measurementId}');
</script>`;
}

function metaBaseHtml(pixelId) {
  return `<script>
(function(f,b,e,v,n,t,s){
  if (f.fbq) return;
  n = f.fbq = function(){ n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
  if (!f._fbq) f._fbq = n;
  n.push = n;
  n.loaded = true;
  n.version = '2.0';
  n.queue = [];
  t = b.createElement(e);
  t.async = true;
  t.src = v;
  s = b.getElementsByTagName(e)[0];
  s.parentNode.insertBefore(t, s);
})(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${pixelId}');
</script>`;
}

/**
 * Shared JS snippet that resolves the EXACT raw dataLayer event object that
 * fired this tag. GTM processes the dataLayer message queue one message at a
 * time; while a message is being processed its `event_id` is reflected in the
 * container's data model, reachable via
 * `google_tag_manager['{{Container ID}}'].dataLayer.get('event_id')`. We read
 * that id, then find the raw object in window.dataLayer whose own `event_id`
 * matches it (scanning from the end). Matching the precise raw object — rather
 * than "the latest analytics event" — prevents collapse/double-send when two
 * analytics events are pushed back-to-back in one tick. Leaves `payload` set
 * to the resolved object, or returns (no-ops) if it cannot be resolved.
 */
function resolveTriggeringEventSnippet() {
  return `  var gtm = window.google_tag_manager && window.google_tag_manager['{{Container ID}}'];
  var targetId = gtm && gtm.dataLayer && typeof gtm.dataLayer.get === 'function'
    ? gtm.dataLayer.get('event_id')
    : null;
  if (!targetId) return;
  var dl = window.dataLayer || [];
  var payload = null;
  for (var i = dl.length - 1; i >= 0; i--) {
    var entry = dl[i];
    if (entry && typeof entry === 'object' && entry.event_id === targetId) {
      payload = entry;
      break;
    }
  }
  if (!payload) return;`;
}

function ga4BridgeHtml() {
  return `<script>
(function(){
${resolveTriggeringEventSnippet()}
  if (!window.gtag) return;
  var params = {};
  for (var key in payload) {
    if (Object.prototype.hasOwnProperty.call(payload, key) && key !== 'event' && key !== 'meta' && key !== 'ecommerce') {
      params[key] = payload[key];
    }
  }
  if (payload.ecommerce && typeof payload.ecommerce === 'object') {
    for (var ek in payload.ecommerce) {
      if (Object.prototype.hasOwnProperty.call(payload.ecommerce, ek)) {
        params[ek] = payload.ecommerce[ek];
      }
    }
  }
  window.gtag('event', payload.event, params);
})();
</script>`;
}

function metaBridgeHtml() {
  return `<script>
(function(){
${resolveTriggeringEventSnippet()}
  if (!window.fbq) return;
  if (payload.event === 'page_view') {
    window.fbq('track', 'PageView', {}, { eventID: payload.event_id });
    return;
  }
  if (payload.meta && payload.meta.event_name) {
    var meta = payload.meta;
    var params = {
      content_ids: meta.content_ids,
      content_type: meta.content_type,
      currency: meta.currency,
      value: meta.value,
      num_items: meta.num_items
    };
    if (meta.order_id) params.order_id = meta.order_id;
    window.fbq('track', meta.event_name, params, { eventID: meta.event_id });
    return;
  }
  if (payload.event === 'site_engagement') {
    window.fbq('trackCustom', 'SiteEngagement', {
      engagement_type: payload.engagement_type,
      page_path: payload.page_path,
      percent_scrolled: payload.percent_scrolled,
      engagement_seconds: payload.engagement_seconds
    }, { eventID: payload.event_id });
  }
})();
</script>`;
}

/** Prefer the bloomy-tale deploy service account key, then ADC. */
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
        '  gcloud config set project bloomy-tale-477216',
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
  NEXT_PUBLIC_META_PIXEL_ID

Authentication:
  npm run gtm:key              # create .secrets/gtm-api-deploy.json once
  GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json

Service account:
  ${SERVICE_ACCOUNT_EMAIL}
  project ${GCP_PROJECT_ID}`);
}
