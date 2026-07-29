# GTM Native-Tag Migration (retire the Custom-HTML bridges) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. NOTE: this is a GTM container migration — tasks are checklist + Preview/parity verification, not app TDD. The app dataLayer contract does not change.

**Goal:** Replace the four hand-written Custom-HTML GTM tags (and their unofficial-API bridges) with native GA4 Event + Meta Pixel template tags, preserving the dataLayer contract, consent gating, single page_view, and browser↔server dedup.

**Architecture:** The app-side dataLayer contract stays byte-for-byte identical; only the GTM container changes. On the GA4 side, `scripts/gtm-api.mjs` stops emitting Custom HTML and instead defines a native **Google tag** (`googtag`, loads gtag.js with `send_page_view:false`) plus a native **GA4 Event** tag (`gaawe`, `eventName={{Event}}`, `sendEcommerceData` reads the `ecommerce` object natively) fed by data-layer variables — the same `ACC - analytics dataLayer events` / `ACC - Consent Update` triggers as today. On the Meta side, the GTM API cannot import Community-Gallery templates, so — exactly like `Microsoft Clarity - Official` (PR #200) — the official Meta Pixel template is imported once in the GTM UI and its tags are trigger/consent-wired via one-off API calls, with advanced matching moved to the template's documented user-data field (retiring the dead `fbq('set','userData')`, F-04). The two bridges' `google_tag_manager[…].dataLayer.get()` reverse-scan (the ~998-event-loop class of bug, F-03) is deleted outright.

**Tech Stack:** Google Tag Manager API v2 (`scripts/gtm-api.mjs`, service-account `.secrets/gtm-api-deploy.json`), GA4, Meta Pixel.

## Global Constraints
- Build MUST stay `next build --webpack` — never Turbopack.
- The app-side dataLayer contract in `src/lib/analytics.ts` MUST NOT change — container-only migration.
- Preserve consent gating exactly (GA4→analytics_storage, Meta→ad_storage, consentStatus:needed, `ACC - Consent Update` re-fire trigger) and the single `page_view` (`send_page_view:false`) + `eventID`/`transaction_id` dedup.
- Resolve the GTM workspace by NAME (`ACC analytics stack`) at runtime — never hardcode a workspace id. Container `GTM-NPHLG9NR` (account `6000988917`, container `254296918`), live version 13.
- Never publish without GTM Preview / Tag Assistant event-parity verification first; re-export to `docs/GTM-NPHLG9NR_v<N>.json` in the same change. Rollback point: `docs/GTM-NPHLG9NR_v13.json`.

---

## Dependency & version chain (read first)

This migration **assumes the privacy-redaction plan shipped first**: `docs/superpowers/plans/2026-07-28-analytics-privacy-token-redaction.md` (N-1) publishes GTM **v14**, seeding a redacted `page_location` into the Custom-HTML `ga4BaseHtml()` config (`scripts/gtm-api.mjs` ~276-290) and refreshing it in `ga4BridgeHtml()` (~350-375). Because this migration **deletes those Custom-HTML tags**, it MUST carry that redaction forward into the native GA4 tags or it silently re-opens N-1. Task 1 does this with a single fresh-evaluated Custom-JS GTM variable (`Page Location - redacted`) referenced by both the native config (default `page_location`) and the native event tag — replacing the seed **and** the bridge-refresh in one variable.

**Version chain:** privacy plan leaves live = **v14** → this migration publishes = **v15**. If the privacy plan has NOT merged when you start, stop and sequence it first (its layer-1 `history.replaceState` is app code this plan does not touch, and its GA4-layer seed is exactly what the `Page Location - redacted` variable subsumes). Confirm the actual live version at runtime (below) rather than trusting this number — republishes drift.

Live-version check (run before starting and before publishing):
```bash
node -e "
const { google } = require('googleapis');
(async () => {
  const auth = await google.auth.getClient({ keyFile: '.secrets/gtm-api-deploy.json', scopes: ['https://www.googleapis.com/auth/tagmanager.readonly'] });
  const tm = google.tagmanager({ version: 'v2', auth });
  const live = await tm.accounts.containers.versions.live({ parent: 'accounts/6000988917/containers/254296918' });
  console.log('live containerVersionId:', live.data.containerVersionId);
  console.log('tags:', (live.data.tag ?? []).map((t) => t.name + ' [' + t.type + ']'));
})();
"
```
Expected before starting: `live containerVersionId: 14` and the four `ACC - *` tags all `[html]`.

---

## File Structure

Only one repo file changes; the rest of the migration is GTM container state (verified via API + committed as the re-export).

- **Modify:** `scripts/gtm-api.mjs` — replace the four `*Html()` tag builders (`ga4BaseHtml`, `metaBaseHtml`, `ga4BridgeHtml`, `metaBridgeHtml`) and their `customHtmlTag(...)` calls with native GA4 tag builders (`googtag` + `gaawe`), data-layer-variable + custom-JS-variable creation, and the Meta routing triggers. Delete the now-dead `resolveTriggeringEventSnippet` / `dedupeBridgeSendSnippet` helpers.
- **Modify:** `docs/analytics-stack.md` — event-contract/verification/container-change-checklist notes (tag names change from `ACC - GA4 base`/bridge to `ACC - GA4 config`/`ACC - GA4 event`; Meta becomes native template tags).
- **Create:** `docs/GTM-NPHLG9NR_v15.json` — the re-exported live container after publish.
- **Delete:** `docs/GTM-NPHLG9NR_v14.json` — superseded (container-change checklist: "remove the previous export file"). Rollback restore point is `docs/GTM-NPHLG9NR_v13.json`, recoverable from git history, and GTM retains version 13 server-side for one-click re-publish.
- **Not in the repo (GTM UI + one-off API, like Clarity):** the imported Meta Pixel gallery template and its tags. Captured in the `v15` export, never in `gtm-api.mjs`.

Target end-state tag set in the container:
| Tag | Type | Replaces | Triggers | Consent |
|---|---|---|---|---|
| `ACC - GA4 config` | `googtag` | `ACC - GA4 base` | Init + Consent Update | `analytics_storage` |
| `ACC - GA4 event` | `gaawe` | `ACC - GA4 dataLayer bridge` | `ACC - analytics dataLayer events` | `analytics_storage` |
| `ACC - Meta base` | Meta template (init) | `ACC - Meta Pixel base` | Init + Consent Update | `ad_storage` |
| `ACC - Meta standard events` | Meta template (standard) | part of `ACC - Meta dataLayer bridge` | `ACC - meta standard events` | `ad_storage` |
| `ACC - Meta PageView` | Meta template (standard) | part of bridge | `ACC - meta page_view` | `ad_storage` |
| `ACC - Meta SiteEngagement` | Meta template (custom) | part of bridge | `ACC - meta site_engagement` | `ad_storage` |
| `Microsoft Clarity - Official` | `cvt_MQDKZ` | (unchanged) | All Pages + Consent Update | `analytics_storage` |

---

## Task 1: Native GA4 tags + data-layer variables in `scripts/gtm-api.mjs`

**Files:**
- Modify: `scripts/gtm-api.mjs`

**Interfaces:**
- Consumes: existing helpers `getOrCreateWorkspace`, `upsertTrigger`, `upsertTag`, `customEventTrigger`, `consentUpdateTrigger`, `templateParam`, and the `requiredEnv('NEXT_PUBLIC_GA4_MEASUREMENT_ID')` value (all unchanged).
- Produces: GA4 tags `ACC - GA4 config` (`googtag`) and `ACC - GA4 event` (`gaawe`), one Custom-JS variable `Page Location - redacted`, and one `v2` data-layer variable per forwarded param. Verified by reading the workspace back via the API. **No Custom HTML remains on the GA4 side.**

- [ ] **Step 1: Add native-tag helpers**

  In `scripts/gtm-api.mjs`, after the existing `templateParam(key, value)` helper (line ~272), add:

  ```js
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
      // Same list-Parameter shape the current customHtmlTag() uses (a bare array
      // fails with "Proto field is not repeating, cannot start list").
      consentType: { type: 'list', list: [{ type: 'template', value: type }] },
    };
  }
  ```

- [ ] **Step 2: Add the redaction variable + the two GA4 tag builders**

  Add (near the other tag builders):

  ```js
  // N-1 carry-forward: mirrors redactSensitiveUrl() (src/lib/analytics.ts) and the
  // privacy plan's redactLocation() (was inline in ga4BaseHtml/ga4BridgeHtml, v14).
  // Evaluated fresh on every hit, so it is inherently sticky across SPA navigation —
  // this ONE variable replaces both the config seed and the bridge gtag('set') refresh.
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
      tagFiringOption: 'oncePerLoad',
      priority: { key: 'priority', type: 'integer', value: '20' },
      consentSettings: consentNeeded('analytics_storage'),
    };
  }

  // Top-level event params to forward = the 15 GA4-registered custom dimensions
  // (audit 2026-07-28 §4) + the 3 page fields. `ecommerce` (items/value/currency/
  // transaction_id/shipping) rides sendEcommerceData natively — do NOT list it here.
  const GA4_EVENT_PARAMS = [
    'engagement_type', 'reason', 'status', 'method', 'page', 'locale',
    'from_locale', 'to_locale', 'filter_status', 'topic', 'locker_name',
    'item_id', 'item_category', 'app_version', 'app_git_sha',
    'page_path', 'page_title',
  ];

  function ga4EventTag(measurementId, firingTriggerId) {
    return {
      name: 'ACC - GA4 event',
      type: 'gaawe',
      parameter: [
        templateParam('eventName', '{{Event}}'),
        boolParam('sendEcommerceData', true),
        templateParam('getEcommerceDataFrom', 'dataLayer'),
        // NB: the key is measurementIdOverride, NOT measurementId — an empty/wrong
        // key fails with "vendorTemplate.parameter.measurementIdOverride: The value
        // must not be empty".
        templateParam('measurementIdOverride', measurementId),
        listParam('eventParameters', [
          // N-1: override gtag's ambient raw page_location on every app event too.
          nameValue('page_location', '{{Page Location - redacted}}'),
          ...GA4_EVENT_PARAMS.map((p) => nameValue(p, `{{DLV - ${p}}}`)),
        ]),
        // Client-side hashed email (parity with the old bridge's gtag('set','user_data')).
        listParam('userProperties', [
          nameValue('sha256_email_address', '{{DLV - user_data.em}}'),
        ]),
      ],
      firingTriggerId,
      tagFiringOption: 'oncePerEvent',
      consentSettings: consentNeeded('analytics_storage'),
    };
  }

  function dataLayerVariable(dlKey) {
    return {
      name: `DLV - ${dlKey}`,
      type: 'v', // Data Layer Variable; 'v2' is the dataLayerVersion below, not the type
      parameter: [
        templateParam('name', dlKey),
        { key: 'dataLayerVersion', type: 'integer', value: '2' },
        boolParam('setDefaultValue', false),
      ],
    };
  }
  ```

- [ ] **Step 3: Add an `upsertVariable` helper**

  Add next to `upsertTag` (mirrors it against the `.variables` collection):

  ```js
  async function upsertVariable(parent, body) {
    const list = await tagmanager.accounts.containers.workspaces.variables.list({ parent });
    const existing = (list.data.variable ?? []).find((v) => v.name === body.name);
    if (!existing) {
      const created = await tagmanager.accounts.containers.workspaces.variables.create({ parent, requestBody: body });
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
  ```

- [ ] **Step 4: Rewrite the GA4 half of `setupWorkspace()`**

  Replace the two GA4 `upsertTag(... customHtmlTag('ACC - GA4 base' ...))` and `customHtmlTag('ACC - GA4 dataLayer bridge' ...)` calls (and delete the whole Meta half — Meta is Task 2) with:

  ```js
  // Data-layer variables the native GA4 event tag maps as event parameters.
  await upsertVariable(workspace.path, pageLocationRedactedVariable());
  for (const p of [...GA4_EVENT_PARAMS, 'user_data.em']) {
    await upsertVariable(workspace.path, dataLayerVariable(p));
  }

  await upsertTag(
    workspace.path,
    ga4ConfigTag(ga4MeasurementId, [initTrigger.triggerId, consentTrigger.triggerId]),
  );
  await upsertTag(
    workspace.path,
    ga4EventTag(ga4MeasurementId, [trigger.triggerId]),
  );
  ```

  (`trigger` = `ACC - analytics dataLayer events`, `initTrigger` = `ACC - Initialization`, `consentTrigger` = `ACC - Consent Update` — all already created earlier in `setupWorkspace()`.)

- [ ] **Step 5: Delete the dead helpers**

  Remove `ga4BaseHtml`, `metaBaseHtml`, `ga4BridgeHtml`, `metaBridgeHtml`, `resolveTriggeringEventSnippet`, `dedupeBridgeSendSnippet`, and the `customHtmlTag(...)` helper if nothing else references it (grep first — `metaBaseHtml`/Meta stays out per Task 2, so all four HTML builders go). Update the summary `console.log` lines to name the native tags.

- [ ] **Step 6: Run against the draft workspace (no publish) and read back**

  ```bash
  npm run gtm:setup
  ```
  Expected: `Using existing workspace: ACC analytics stack`, then `Created variable: Page Location - redacted`, `Created variable: DLV - engagement_type` … , `Created tag: ACC - GA4 config`, `Created tag: ACC - GA4 event`, and `Not published. Use GTM Preview first…`.

  Read back the two tags:
  ```bash
  node -e "
  const { google } = require('googleapis');
  (async () => {
    const auth = await google.auth.getClient({ keyFile: '.secrets/gtm-api-deploy.json', scopes: ['https://www.googleapis.com/auth/tagmanager.readonly'] });
    const tm = google.tagmanager({ version: 'v2', auth });
    const cp = 'accounts/6000988917/containers/254296918';
    const ws = (await tm.accounts.containers.workspaces.list({ parent: cp })).data.workspace.find((w) => w.name === 'ACC analytics stack');
    const tags = (await tm.accounts.containers.workspaces.tags.list({ parent: ws.path })).data.tag;
    for (const n of ['ACC - GA4 config', 'ACC - GA4 event']) {
      const t = tags.find((x) => x.name === n);
      console.log(n, '| type:', t.type, '| triggers:', t.firingTriggerId, '| consent:', JSON.stringify(t.consentSettings));
    }
  })();
  "
  ```
  Expected: `ACC - GA4 config | type: googtag | triggers: [ <init>, <consentUpdate> ] | consent: {...analytics_storage...}` and `ACC - GA4 event | type: gaawe | triggers: [ <analytics events> ]`. If `gaawe` creation errored on `measurementIdOverride`, re-check the key name (Step 2 note).

- [ ] **Step 7: Lint + commit the script change**

  ```bash
  npm run lint
  git add scripts/gtm-api.mjs
  git commit -m "feat(gtm): native GA4 config+event tags replace the Custom-HTML bridge

Replaces ACC - GA4 base / ACC - GA4 dataLayer bridge (Custom HTML) with a
native Google tag (send_page_view:false) + GA4 Event tag (eventName={{Event}},
sendEcommerceData reads the ecommerce object natively). Carries the N-1
redacted page_location forward as a fresh-evaluated Custom-JS variable that
subsumes the v14 config seed + bridge refresh. dataLayer contract unchanged;
consent gating and the ACC - Consent Update re-fire trigger preserved.
Addresses F-03 (GA4 half). Meta half in a following commit."
  ```

---

## Task 2: Meta Pixel native template — UI import + one-off API wiring

The GTM API **cannot** import Community-Gallery templates (import is UI-only), so — exactly as `Microsoft Clarity - Official` was handled (PR #200, and the Task-3 pattern in `docs/superpowers/plans/2026-07-27-gtm-consent-refire-implementation.md`) — Meta is added in the UI and trigger/consent-wired via one-off API calls, then captured in the `v15` export. It is **not** added to `scripts/gtm-api.mjs`.

**Files:** none committed in this task (GTM workspace state only; captured by Task 5's export).

**Interfaces:**
- Consumes: `NEXT_PUBLIC_META_PIXEL_ID` (`535651705450454`, per the `v13`/`v14` export), the `{{DLV - …}}` variables from Task 1, and the Meta routing triggers created in Step 2 below.
- Produces: four Meta template tags (init + three event tags) gated on `ad_storage`, with `eventID` dedup preserved and advanced matching via the template's user-data field (F-04). Verified by reading the workspace back.

- [ ] **Step 1: Add the Meta routing triggers to `scripts/gtm-api.mjs`**

  Meta must NOT fire on `view_item_list`/`select_item`/`remove_from_cart`/`view_cart` (the old bridge sent nothing for those). Triggers are pure API (no gallery dependency), so codify them. Add builders and `upsertTrigger` calls in `setupWorkspace()`:

  ```js
  function metaStandardTrigger() {
    return {
      name: 'ACC - meta standard events',
      type: 'customEvent',
      customEventFilter: [{ type: 'matchRegex', parameter: [
        templateParam('arg0', '{{_event}}'),
        templateParam('arg1', '^(view_item|add_to_cart|begin_checkout|purchase)$'),
      ] }],
    };
  }
  function metaEqualsTrigger(name, eventName) {
    return {
      name,
      type: 'customEvent',
      customEventFilter: [{ type: 'equals', parameter: [
        templateParam('arg0', '{{_event}}'),
        templateParam('arg1', eventName),
      ] }],
    };
  }
  ```
  ```js
  const metaStd = await upsertTrigger(workspace.path, metaStandardTrigger());
  const metaPv = await upsertTrigger(workspace.path, metaEqualsTrigger('ACC - meta page_view', 'page_view'));
  const metaEng = await upsertTrigger(workspace.path, metaEqualsTrigger('ACC - meta site_engagement', 'site_engagement'));
  console.log('Meta routing triggers ready:', metaStd.name, metaPv.name, metaEng.name);
  ```
  Also add `DLV - meta.event_name`, `DLV - meta.event_id`, `DLV - meta.content_ids`, `DLV - meta.content_type`, `DLV - meta.contents`, `DLV - meta.currency`, `DLV - meta.value`, `DLV - meta.num_items`, `DLV - meta.order_id`, `DLV - event_id`, `DLV - page_path`, `DLV - percent_scrolled`, `DLV - engagement_seconds` to the variable-creation loop from Task 1 Step 4 (GTM dot-notation reads the nested `meta.*` keys). Run `npm run gtm:setup`, confirm the triggers/variables are created, and commit `scripts/gtm-api.mjs` (`feat(gtm): meta routing triggers + dataLayer vars for native pixel tags`).

- [ ] **Step 2: Import the Meta Pixel template from the gallery (GTM UI)**

  In the GTM UI (the operator's own Google login — the service account cannot use the web UI), in the `ACC analytics stack` workspace: **Templates → Tag Templates → Search Gallery →** add the official **Meta Pixel** template → **Add to workspace**. This creates a container-local `customTemplate` (`type: 'cvt_<id>'`, `galleryReference`), analogous to Clarity's `cvt_MQDKZ` block in the export.

- [ ] **Step 3: Configure the four Meta tags (GTM UI), all consent `ad_storage`**

  Field names below are the template's UI labels — the exact `parameter` keys are read back in Step 4. Preserve the current behavior 1:1:
  - **`ACC - Meta base`** (init): Pixel ID `535651705450454`; **leave advanced matching OFF on this tag** — the app pushes `user_data.em` only on `begin_checkout`/`purchase` (`src/lib/analytics.ts`), so at Init / Consent-Update time `{{DLV - user_data.em}}` is empty and binding it here would send blank match data. Advanced matching is wired on the event tag where the hashed email is actually present (see `ACC - Meta standard events` below, **F-04**). Disable any "automatically send PageView" option (we fire PageView explicitly below). Triggers: `ACC - Initialization` + `ACC - Consent Update`.
  - **`ACC - Meta PageView`** (standard, `PageView`): **Event ID** = `{{DLV - event_id}}`. Trigger: `ACC - meta page_view`.
  - **`ACC - Meta standard events`** (standard, event name = `{{DLV - meta.event_name}}`): object properties `content_ids={{DLV - meta.content_ids}}`, `content_type={{DLV - meta.content_type}}`, `contents={{DLV - meta.contents}}`, `currency={{DLV - meta.currency}}`, `value={{DLV - meta.value}}`, `num_items={{DLV - meta.num_items}}`, `order_id={{DLV - meta.order_id}}`; **Event ID** = `{{DLV - meta.event_id}}` (this is `purchase-<pi>` for purchase — the dedup key); **advanced matching = enabled**, email = `{{DLV - user_data.em}}` (already SHA-256-hashed by the app — set the field that accepts a pre-hashed email; this is where the F-04 fix actually lands, since the app supplies `user_data.em` only on `begin_checkout`/`purchase`). This tag's trigger also matches `view_item`/`add_to_cart`; on those the email variable is empty and the template drops the blank `em`, so advanced matching populates only on the `InitiateCheckout`/`Purchase` conversions — the intended behavior. Trigger: `ACC - meta standard events`.
  - **`ACC - Meta SiteEngagement`** (custom, `SiteEngagement`): properties `engagement_type={{DLV - engagement_type}}`, `page_path={{DLV - page_path}}`, `percent_scrolled={{DLV - percent_scrolled}}`, `engagement_seconds={{DLV - engagement_seconds}}`; **Event ID** = `{{DLV - event_id}}`. Trigger: `ACC - meta site_engagement`.

  On each tag set **Consent Settings → Require additional consent for tag to fire → `ad_storage`** (`consentStatus: needed`).

- [ ] **Step 4: Read the Meta tags back and confirm the wiring**

  ```bash
  node -e "
  const { google } = require('googleapis');
  (async () => {
    const auth = await google.auth.getClient({ keyFile: '.secrets/gtm-api-deploy.json', scopes: ['https://www.googleapis.com/auth/tagmanager.readonly'] });
    const tm = google.tagmanager({ version: 'v2', auth });
    const cp = 'accounts/6000988917/containers/254296918';
    const ws = (await tm.accounts.containers.workspaces.list({ parent: cp })).data.workspace.find((w) => w.name === 'ACC analytics stack');
    const tags = (await tm.accounts.containers.workspaces.tags.list({ parent: ws.path })).data.tag;
    for (const t of tags.filter((x) => x.name.startsWith('ACC - Meta'))) {
      console.log(t.name, '| type:', t.type, '| triggers:', t.firingTriggerId, '| consent:', t.consentSettings && t.consentSettings.consentType && JSON.stringify(t.consentSettings.consentType.list));
    }
  })();
  "
  ```
  Expected: all four `ACC - Meta *` tags print `type: cvt_…`, the right trigger id(s), and `[{"type":"template","value":"ad_storage"}]`. `ACC - Meta base` must show TWO triggers (Init + Consent Update). If any tag is missing its `ad_storage` consent, patch it via a one-off `tags.update` (same pattern as the Clarity consent fix in PR #200) before continuing.

---

## Task 3: Delete the four legacy Custom-HTML tags

`upsertTag()` never deletes, and the native GA4 tags use new names (`ACC - GA4 config`/`event`), so the old `ACC - GA4 base`, `ACC - GA4 dataLayer bridge`, `ACC - Meta Pixel base`, `ACC - Meta dataLayer bridge` (all `type: html`) are still present in the draft. Remove them so the container has exactly one GA4 config, one GA4 event tag, and the native Meta tags.

**Files:** none (workspace state only).

- [ ] **Step 1: Delete the four Custom-HTML tags (one-off API, resolve workspace by name)**

  ```bash
  node -e "
  const { google } = require('googleapis');
  (async () => {
    const auth = await google.auth.getClient({ keyFile: '.secrets/gtm-api-deploy.json', scopes: ['https://www.googleapis.com/auth/tagmanager.edit.containers'] });
    const tm = google.tagmanager({ version: 'v2', auth });
    const cp = 'accounts/6000988917/containers/254296918';
    const ws = (await tm.accounts.containers.workspaces.list({ parent: cp })).data.workspace.find((w) => w.name === 'ACC analytics stack');
    const tags = (await tm.accounts.containers.workspaces.tags.list({ parent: ws.path })).data.tag;
    const doomed = ['ACC - GA4 base', 'ACC - GA4 dataLayer bridge', 'ACC - Meta Pixel base', 'ACC - Meta dataLayer bridge'];
    for (const name of doomed) {
      const t = tags.find((x) => x.name === name);
      if (!t) { console.log('already gone:', name); continue; }
      if (t.type !== 'html') throw new Error('refusing to delete non-html tag: ' + name + ' (' + t.type + ')');
      await tm.accounts.containers.workspaces.tags.delete({ path: t.path });
      console.log('deleted:', name);
    }
  })();
  "
  ```
  Expected: four `deleted:` lines (or `already gone:` on a re-run). The `t.type !== 'html'` guard prevents nuking a native tag by a name typo.

- [ ] **Step 2: Confirm the container has no `html` tags left**

  ```bash
  node -e "
  const { google } = require('googleapis');
  (async () => {
    const auth = await google.auth.getClient({ keyFile: '.secrets/gtm-api-deploy.json', scopes: ['https://www.googleapis.com/auth/tagmanager.readonly'] });
    const tm = google.tagmanager({ version: 'v2', auth });
    const cp = 'accounts/6000988917/containers/254296918';
    const ws = (await tm.accounts.containers.workspaces.list({ parent: cp })).data.workspace.find((w) => w.name === 'ACC analytics stack');
    const tags = (await tm.accounts.containers.workspaces.tags.list({ parent: ws.path })).data.tag;
    console.log('html tags remaining:', tags.filter((t) => t.type === 'html').map((t) => t.name));
    console.log('all tags:', tags.map((t) => t.name + ' [' + t.type + ']'));
  })();
  "
  ```
  Expected: `html tags remaining: []`, and `all tags:` lists `ACC - GA4 config [googtag]`, `ACC - GA4 event [gaawe]`, the four `ACC - Meta *` `[cvt_…]`, and `Microsoft Clarity - Official [cvt_MQDKZ]`.

---

## Task 4: GTM Preview / Tag Assistant event-parity gate (BEFORE publish)

Prove the native tags fire the same GA4/Meta events with the same dedup keys as the bridges did, on the draft workspace, before anything goes live. **Do not publish if any check fails.**

**Files:** none — verification against the draft workspace + local dev.

- [ ] **Step 1: Start dev and connect GTM Preview**

  ```bash
  npm run dev
  ```
  In the operator's browser, open `https://tagmanager.google.com/#/container/accounts/6000988917/containers/254296918/workspaces` → the `ACC analytics stack` workspace → **Preview** → connect to `http://localhost:3000`. (If the Claude-in-Chrome / Tag Assistant path is unavailable — as prior sessions hit, see `docs/analytics-stack.md:148` — fall back to GA4 **DebugView** + Meta **Test Events** (`META_TEST_EVENT_CODE`) as the parity oracle and say so in the PR.)

- [ ] **Step 2: Walk the funnel and confirm each event fires natively (Tags Fired, not Not Fired)**

  Accept consent first (so tags are un-gated), then exercise: home + a collection page, open a product lightbox, add to cart, open cart, click checkout, complete a test payment to `/koszyk/return`. Confirm in the Tag Assistant timeline / GA4 DebugView / Meta Test Events:

  | dataLayer event | `ACC - GA4 event` (gaawe) | Meta tag fired | dedup key to eyeball |
  |---|---|---|---|
  | `page_view` | GA4 `page_view` (exactly **one** — no gtag auto page_view; `send_page_view:false`) | `ACC - Meta PageView` → `PageView` | Meta `eventID` = `{{DLV - event_id}}` |
  | `view_item_list` | GA4 `view_item_list` with `items[]` | **none** | — |
  | `select_item` | GA4 `select_item` | **none** | — |
  | `view_item` | GA4 `view_item` | `ACC - Meta standard events` → `ViewContent` | — |
  | `add_to_cart` | GA4 `add_to_cart` | → `AddToCart` | — |
  | `begin_checkout` | GA4 `begin_checkout` | → `InitiateCheckout` | — |
  | `purchase` | GA4 `purchase` with **one** `transaction_id` = `<pi>` | → `Purchase` | Meta `eventID` = `purchase-<pi>`; GA4 `transaction_id` = `<pi>` |
  | one `site_engagement` (e.g. scroll) | GA4 `site_engagement` with `engagement_type` | `ACC - Meta SiteEngagement` → `SiteEngagement` | — |

  Explicitly confirm:
  - **Single page_view:** exactly one GA4 `page_view` per navigation (the app's), no gtag-auto duplicate.
  - **Ecommerce passthrough:** `purchase`/`view_item` carry `items[]`, `currency`, `value` (and `purchase` its `transaction_id`/`shipping`) sourced from the `ecommerce` object via `sendEcommerceData` — no items missing vs the old bridge.
  - **Registered dimensions:** on a `site_engagement` and a `purchase`, DebugView shows the params in `GA4_EVENT_PARAMS` that apply (`engagement_type`, `locale`, `app_version`, `app_git_sha`, `item_id`, `item_category`, …). No registered custom dimension went blank vs v14.
  - **page_location redaction (N-1):** load `http://localhost:3000/koszyk?sale=TEST`; DebugView `page_location` on the app events **and** on GA4 auto-events (`session_start`) shows `…?sale=redacted`, never the raw token. (This is the Task-1 variable doing the v14 seed+refresh job.)
  - **Meta dedup + advanced matching:** `Purchase` carries `eventID = purchase-<pi>` (matches server CAPI in `src/lib/marketing/conversions.ts`); no `fbq('set','userData')` call in the network trace. Advanced matching now rides the `ACC - Meta standard events` tag's user-data field: confirm the hashed `em` is present on the `InitiateCheckout`/`Purchase` fbq calls (where the app supplies `user_data.em`) and is **absent, not blank-bound,** on the `PageView`/init call (the base tag no longer carries an empty `em`).
  - **Consent gate:** in a fresh/incognito session, **reject** consent → none of the GA4/Meta tags fire; **accept** mid-session → they recover on the next event and the base tags fire on `consent_update` (the `ACC - Consent Update` re-fire, preserved).

- [ ] **Step 3: Gate decision**

  - All rows fire correctly, dedup keys match, N-1 redaction holds, consent gate holds → proceed to Task 5.
  - Any parity miss (missing event, blank registered dimension, double page_view, wrong/absent `eventID`, token leaked, tag fires under rejected consent) → **stop.** Fix the tag/variable/trigger in the draft and re-run Step 2. Never publish a partial parity result.

---

## Task 5: Publish, re-export, docs

**Files:**
- Create: `docs/GTM-NPHLG9NR_v15.json`
- Delete: `docs/GTM-NPHLG9NR_v14.json`
- Modify: `docs/analytics-stack.md`

- [ ] **Step 1: Sync the workspace (detect conflicts before publishing)**

  ```bash
  node -e "
  const { google } = require('googleapis');
  (async () => {
    const auth = await google.auth.getClient({ keyFile: '.secrets/gtm-api-deploy.json', scopes: ['https://www.googleapis.com/auth/tagmanager.edit.containers'] });
    const tm = google.tagmanager({ version: 'v2', auth });
    const cp = 'accounts/6000988917/containers/254296918';
    const ws = (await tm.accounts.containers.workspaces.list({ parent: cp })).data.workspace.find((w) => w.name === 'ACC analytics stack');
    const r = await tm.accounts.containers.workspaces.sync({ path: ws.path });
    console.log('workspace:', ws.path); console.log(JSON.stringify(r.data, null, 2));
  })();
  "
  ```
  Expected `{ "syncStatus": {} }` (no conflicts). Resolve any conflict manually before continuing — never publish over an unresolved conflict.

- [ ] **Step 2: Create + publish the version**

  ```bash
  node -e "
  const { google } = require('googleapis');
  (async () => {
    const auth = await google.auth.getClient({ keyFile: '.secrets/gtm-api-deploy.json', scopes: ['https://www.googleapis.com/auth/tagmanager.edit.containers','https://www.googleapis.com/auth/tagmanager.edit.containerversions','https://www.googleapis.com/auth/tagmanager.publish'] });
    const tm = google.tagmanager({ version: 'v2', auth });
    const cp = 'accounts/6000988917/containers/254296918';
    const ws = (await tm.accounts.containers.workspaces.list({ parent: cp })).data.workspace.find((w) => w.name === 'ACC analytics stack');
    const v = await tm.accounts.containers.workspaces.create_version({ path: ws.path, requestBody: {
      name: 'Native GA4 + Meta tags (retire Custom-HTML bridges)',
      notes: 'Replaces the 4 Custom-HTML tags/bridges with native googtag + gaawe (GA4) and the official Meta Pixel template (Meta). Preserves consent gating, single page_view, eventID/transaction_id dedup, and the N-1 page_location redaction. Addresses F-03/F-04.',
    } });
    const vp = v.data.containerVersion.path;
    console.log('created:', vp, '| id:', v.data.containerVersion.containerVersionId);
    const p = await tm.accounts.containers.versions.publish({ path: vp });
    console.log('published:', p.data.containerVersion.path);
  })();
  "
  ```
  Expected: prints the new version id (**15** if v14 was live) and confirms publish.

- [ ] **Step 3: Re-verify the LIVE container**

  Re-run the live-version check from the Dependency section. Expected: `live containerVersionId: 15`; tags list shows `ACC - GA4 config [googtag]`, `ACC - GA4 event [gaawe]`, the four `ACC - Meta * [cvt_…]`, `Microsoft Clarity - Official [cvt_MQDKZ]`, and **no `[html]`**. Spot-check consent + base-tag triggers:
  ```bash
  node -e "
  const { google } = require('googleapis');
  (async () => {
    const auth = await google.auth.getClient({ keyFile: '.secrets/gtm-api-deploy.json', scopes: ['https://www.googleapis.com/auth/tagmanager.readonly'] });
    const tm = google.tagmanager({ version: 'v2', auth });
    const live = await tm.accounts.containers.versions.live({ parent: 'accounts/6000988917/containers/254296918' });
    for (const t of live.data.tag) console.log(t.name, '|', t.type, '| consent:', t.consentSettings && t.consentSettings.consentType && JSON.stringify(t.consentSettings.consentType.list), '| triggers:', t.firingTriggerId);
  })();
  "
  ```
  Expected: GA4 tags on `analytics_storage`, Meta tags on `ad_storage`, all `consentStatus: needed`; `ACC - GA4 config` and `ACC - Meta base` each show two triggers (their base trigger + the `ACC - Consent Update` id).

- [ ] **Step 4: Export the live version, replace v14**

  ```bash
  node -e "
  const fs = require('node:fs');
  const { google } = require('googleapis');
  (async () => {
    const auth = await google.auth.getClient({ keyFile: '.secrets/gtm-api-deploy.json', scopes: ['https://www.googleapis.com/auth/tagmanager.readonly'] });
    const tm = google.tagmanager({ version: 'v2', auth });
    const live = await tm.accounts.containers.versions.live({ parent: 'accounts/6000988917/containers/254296918' });
    const n = new Date(); const pad = (x) => String(x).padStart(2, '0');
    const exportTime = n.getFullYear()+'-'+pad(n.getMonth()+1)+'-'+pad(n.getDate())+' '+pad(n.getHours())+':'+pad(n.getMinutes())+':'+pad(n.getSeconds());
    const out = { exportFormatVersion: 2, exportTime, containerVersion: live.data };
    fs.writeFileSync('docs/GTM-NPHLG9NR_v'+live.data.containerVersionId+'.json', JSON.stringify(out, null, 2) + '\n');
    console.log('wrote docs/GTM-NPHLG9NR_v'+live.data.containerVersionId+'.json');
  })();
  "
  ls docs/GTM-NPHLG9NR_v*.json   # confirm current filename before removing
  git rm docs/GTM-NPHLG9NR_v14.json   # adjust if the live version differed from 15/14
  ```
  Spot-check the export: `grep -c '"type": "gaawe"' docs/GTM-NPHLG9NR_v15.json` → `1`; `grep -c '"type": "html"' docs/GTM-NPHLG9NR_v15.json` → `0`; `grep -c "Page Location - redacted" docs/GTM-NPHLG9NR_v15.json` → ≥ `2` (variable def + config/event reference).

- [ ] **Step 5: Update `docs/analytics-stack.md`**

  - In the `npm run gtm:setup` "creates or updates" list (lines ~108-115), replace the four `ACC - GA4 base`/`Meta Pixel base`/`GA4 dataLayer bridge`/`Meta dataLayer bridge` bullets with `ACC - GA4 config` (Google tag), `ACC - GA4 event` (GA4 Event), and a note that the Meta Pixel template tags are UI-managed (gallery import + one-off API wiring, like `Microsoft Clarity - Official`).
  - In the **Container Change Checklist** (line ~143), update the tag inventory: the GA4 tags are now native (`googtag`/`gaawe`, `analytics_storage`); Meta is the native Pixel template (`ad_storage`); confirm `ACC - GA4 config` and `ACC - Meta base` each fire on their base trigger + `ACC - Consent Update`. Update the "current export is `docs/GTM-NPHLG9NR_v13.json`" pointer (line ~148, whatever v14 left it) to `_v15.json`, and add a one-line note: v15 retired the Custom-HTML bridges for native tags (F-03/F-04), carrying the v14 N-1 `page_location` redaction into the native config via the `Page Location - redacted` variable.

- [ ] **Step 6: Commit + PR**

  ```bash
  git add docs/analytics-stack.md docs/GTM-NPHLG9NR_v*.json
  git commit -m "chore(analytics): publish GTM v15 — native GA4 + Meta tags, retire bridges

Publishes the native-tag container as the new live version. Retires the four
Custom-HTML tags/bridges (F-03) and the dead fbq('set','userData') advanced
matching (F-04) for native googtag + gaawe (GA4) and the official Meta Pixel
template. Consent gating, single page_view, eventID/transaction_id dedup, and
the N-1 page_location redaction all verified in Preview/DebugView before
publishing (Task 4). Rollback: re-publish GTM version 13."
  git push -u origin <branch-name>
  gh pr create --title "feat(analytics): native GTM tags replace the Custom-HTML bridges (F-03/F-04)" --body "Implements docs/superpowers/plans/2026-07-28-gtm-native-tags-migration.md. Depends on the v14 privacy-redaction plan (page_location redaction carried into the native config). Verified event parity in GTM Preview/GA4 DebugView/Meta Test Events before publishing v15."
  ```

- [ ] **Step 7: Post-publish soak (follow-up, not a code step)**

  Over the next 24-48h confirm in GA4 (Realtime + the audit's `pageLocation` Data-API probe, `.secrets/gtm-api-deploy.json`, `analytics.readonly`) that `purchase` stays 1:1 with server transactions (no dedup regression), registered custom dimensions still populate, and no raw `?sale=`/`?preview=`/`payment_intent_client_secret` appears in `page_location`. Confirm in Meta Events Manager that browser↔CAPI `Purchase` still deduplicates on `purchase-<pi>` and advanced-matching coverage is present (this is the F-04 close-out — unverifiable from code).

---

## Rollback

The migration is one atomic GTM publish; the app never changed, so rollback is container-only and instant.

- **Primary:** re-publish container **version 13** (GTM retains every version server-side): GTM UI → **Versions → version 13 → Publish**, or API:
  ```bash
  node -e "
  const { google } = require('googleapis');
  (async () => {
    const auth = await google.auth.getClient({ keyFile: '.secrets/gtm-api-deploy.json', scopes: ['https://www.googleapis.com/auth/tagmanager.publish'] });
    const tm = google.tagmanager({ version: 'v2', auth });
    const p = await tm.accounts.containers.versions.publish({ path: 'accounts/6000988917/containers/254296918/versions/13' });
    console.log('rolled back to:', p.data.containerVersion.path);
  })();
  "
  ```
  (Version 13 is the last known-good Custom-HTML container. Rolling back to 13 rather than 14 also reverts the v14 N-1 redaction — acceptable for an emergency; re-apply 14→15 once the parity issue is fixed. If only the native migration is suspect and v14 must be kept, re-publish **14** instead.)
- **Offline restore point:** `docs/GTM-NPHLG9NR_v13.json` lives in git history (`git show <sha>:docs/GTM-NPHLG9NR_v13.json`) even after the checklist removes the on-disk export; it can be re-imported via GTM UI → **Admin → Import Container** if a server-side version were ever lost.
- **When to roll back:** `purchase` diverges from server transactions in GA4 Realtime (dedup broke), a funnel event stops appearing, a tag fires under rejected consent, or a token reappears in `page_location`. Roll back first, then diagnose the draft.

---

## Why this shape (not more)

- **GA4 in `gtm-api.mjs`, Meta in the UI:** the GTM API can create native *vendor* templates (`googtag`/`gaawe`) but **cannot import Community-Gallery templates** — so Meta follows the established Clarity path (UI import + one-off API wiring) rather than a fictional pure-API definition. No new tooling; reuses the exact PR #200 pattern.
- **One redaction variable, not a seed + a refresh:** a fresh-evaluated Custom-JS variable is read on every hit, so it covers both the config default (auto-events) and per-navigation freshness that the v14 Custom-HTML needed two separate code blocks for.
- **Forward only the 15 registered GA4 dimensions + 3 page fields:** GA4 drops unregistered params anyway (audit N-8), so enumerating exactly the queryable set is the parity target — not a blanket copy of every dataLayer key (that blanket copy *was* the non-standard bridge behavior being retired).
- **No app-code changes, no new deps, no migrations.** The dataLayer contract is already the right shape; this plan only stops the container from reconstructing it by hand.
