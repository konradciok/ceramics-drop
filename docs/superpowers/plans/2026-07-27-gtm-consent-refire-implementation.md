# GTM consent re-fire fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A visitor who accepts the cookie banner mid-session (rather than arriving with consent already stored) gets working GA4/Meta/Clarity tracking for the rest of that session, instead of none.

**Architecture:** `setConsent()` pushes a new `consent_update` dataLayer event immediately after its existing `gtag('consent','update',...)` call. A new GTM trigger matching that event is added as a second firing trigger on the three tags currently gated only by a one-shot trigger (`ACC - GA4 base`, `ACC - Meta Pixel base`, `Microsoft Clarity - Official`).

**Tech Stack:** TypeScript/Vitest (app side), `googleapis` Tag Manager API v2 via `scripts/gtm-api.mjs` (GTM side, service account `gtm-api-deploy@anna-ciok-studio-analytics.iam.gserviceaccount.com`, key at `.secrets/gtm-api-deploy.json`).

## Global Constraints

- `consent_update` must NOT be added to `ANALYTICS_EVENTS` in `src/lib/analytics.ts` — it must never be forwarded to GA4/Meta as a fake event.
- `defaultConsentSnippet()` (the before-GTM returning-visitor bootstrap) is not touched — it already works correctly.
- `consentSettings` and `oncePerLoad` on the three affected tags stay exactly as they are — only their `firingTriggerId` list changes.
- Nothing publishes to the live GTM container until Task 4's Preview verification passes.
- No server-side code, Supabase, or webhook changes — this is 100% client-side GTM/dataLayer.

Full context and rejected alternatives: `docs/superpowers/specs/2026-07-27-gtm-consent-refire-design.md`.

---

### Task 1: App-side `consent_update` event on `setConsent()`

**Files:**
- Modify: `src/components/consent/consent-mode.ts`
- Test: `src/components/consent/consent-mode.test.ts`

**Interfaces:**
- Consumes: `pushDataLayer` from `@/lib/analytics` (existing, signature `(event: DataLayerEvent) => void`; `DataLayerEvent` has an open `[key: string]: unknown` index signature, so `{ event: 'consent_update', consent_state: 'granted' | 'denied' }` type-checks with no cast).
- Produces: `setConsent(value: ConsentValue): void` (signature unchanged — same as today, just does one more thing internally). Nothing downstream depends on new exports from this task.

- [ ] **Step 1: Write the failing tests**

Add to the bottom of `src/components/consent/consent-mode.test.ts` (keep the existing `import` and `describe('consent mode', ...)` block above untouched, just add `vi` to the vitest import and a new `describe` block):

```ts
import { describe, it, expect, vi } from 'vitest';
import { defaultConsentSnippet, COOKIE_NAME, readConsent, setConsent } from './consent-mode';
```

```ts
describe('setConsent', () => {
  function stubWindowAndDocument() {
    const gtagCalls: unknown[][] = [];
    const cookieStore = { cookie: '' };
    vi.stubGlobal('document', cookieStore);
    vi.stubGlobal('window', {
      dataLayer: [],
      gtag: (...args: unknown[]) => { gtagCalls.push(args); },
      document: { documentElement: { dataset: {} } },
      location: { hostname: 'example.com' },
    });
    return { gtagCalls, cookieStore };
  }

  it('granted: writes the cookie, updates gtag consent, and pushes consent_update', () => {
    const { gtagCalls, cookieStore } = stubWindowAndDocument();

    setConsent('granted');

    expect(cookieStore.cookie).toContain(`${COOKIE_NAME}=granted`);
    expect(gtagCalls).toEqual([
      ['consent', 'update', {
        ad_storage: 'granted',
        ad_user_data: 'granted',
        ad_personalization: 'granted',
        analytics_storage: 'granted',
      }],
    ]);
    expect(window.dataLayer).toEqual([
      expect.objectContaining({ event: 'consent_update', consent_state: 'granted' }),
    ]);
  });

  it('denied: writes the cookie, updates gtag consent, and pushes consent_update', () => {
    const { gtagCalls, cookieStore } = stubWindowAndDocument();

    setConsent('denied');

    expect(cookieStore.cookie).toContain(`${COOKIE_NAME}=denied`);
    expect(gtagCalls).toEqual([
      ['consent', 'update', {
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
        analytics_storage: 'denied',
      }],
    ]);
    expect(window.dataLayer).toEqual([
      expect.objectContaining({ event: 'consent_update', consent_state: 'denied' }),
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/consent/consent-mode.test.ts`
Expected: FAIL — `window.dataLayer` is `[]` (no `consent_update` push exists yet); `setConsent` is not yet imported-compatible with the new assertions (it will still run, it just won't push anything).

- [ ] **Step 3: Implement `setConsent`'s `consent_update` push**

In `src/components/consent/consent-mode.ts`, add the import at the top (after the existing content, before the first `export`):

```ts
import { pushDataLayer } from '@/lib/analytics';
```

Replace the existing `setConsent` function:

```ts
/** Client-only: persist choice + push the consent update to GTM. */
export function setConsent(value: ConsentValue): void {
  document.cookie = `${COOKIE_NAME}=${value}; path=/; max-age=${60 * 60 * 24 * 180}; SameSite=Lax; Secure`;
  const state = value === 'granted' ? 'granted' : 'denied';
  // @ts-expect-error gtag is injected by the default snippet
  window.gtag?.('consent', 'update', {
    ad_storage: state, ad_user_data: state, ad_personalization: state, analytics_storage: state,
  });
  // GTM's Additional Consent Checks only gate a tag at the moment its own
  // trigger fires — they don't re-fire a previously-blocked tag when consent
  // updates later. This gives GTM's `ACC - Consent Update` trigger a fresh
  // moment to re-evaluate the base tags now that consent has changed.
  pushDataLayer({ event: 'consent_update', consent_state: state });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/consent/consent-mode.test.ts`
Expected: PASS (5 tests: 3 existing + 2 new).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/consent/consent-mode.ts src/components/consent/consent-mode.test.ts
git commit -m "fix(consent): push consent_update event so GTM can re-fire blocked tags

GTM's Additional Consent Checks are a one-time gate at trigger-fire time —
they don't listen for later gtag('consent','update',...) calls. A visitor
who accepts the cookie banner mid-session (rather than arriving with
consent already stored) currently gets no GA4/Meta tracking for that
session, since the tags that load gtag.js/fbq.js fire on a one-shot
Initialization trigger. setConsent() now pushes a dedicated consent_update
dataLayer event a new GTM trigger can catch (added in a following commit)."
```

---

### Task 2: GTM trigger + base-tag wiring in `scripts/gtm-api.mjs`

**Files:**
- Modify: `scripts/gtm-api.mjs`

**Interfaces:**
- Consumes: existing `upsertTrigger(parent, body)`, `upsertTag(parent, body)`, `customHtmlTag(name, html, firingTriggerId, options)`, `templateParam(key, value)` helpers already defined in this file (unchanged signatures).
- Produces: a GTM trigger named `ACC - Consent Update` (workspace-scoped, created/updated by `setupWorkspace()`), and the two base tags' `firingTriggerId` arrays now include both `ACC - Initialization` and `ACC - Consent Update`. No other task depends on new JS exports — this task's output is GTM workspace state, verified by reading it back via the API.

- [ ] **Step 1: Add the trigger-definition function**

In `scripts/gtm-api.mjs`, add this function right after `customEventTrigger()` (which ends around line 219):

```js
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
```

- [ ] **Step 2: Create the trigger and wire it into the two base tags**

In `setupWorkspace()`, change:

```js
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
      consentTypes: ['analytics_storage'],
    }),
  );
  await upsertTag(
    workspace.path,
    customHtmlTag('ACC - Meta Pixel base', metaBaseHtml(metaPixelId), [initTrigger.triggerId], {
      oncePerLoad: true,
      priority: 10,
      consentTypes: ['ad_storage'],
    }),
  );
```

to:

```js
  const workspace = await getOrCreateWorkspace(parent, workspaceName);
  const trigger = await upsertTrigger(workspace.path, customEventTrigger());
  const initTrigger = await upsertTrigger(workspace.path, {
    name: 'ACC - Initialization',
    type: 'init',
  });
  const consentTrigger = await upsertTrigger(workspace.path, consentUpdateTrigger());

  await upsertTag(
    workspace.path,
    customHtmlTag(
      'ACC - GA4 base',
      ga4BaseHtml(ga4MeasurementId),
      [initTrigger.triggerId, consentTrigger.triggerId],
      { oncePerLoad: true, priority: 20, consentTypes: ['analytics_storage'] },
    ),
  );
  await upsertTag(
    workspace.path,
    customHtmlTag(
      'ACC - Meta Pixel base',
      metaBaseHtml(metaPixelId),
      [initTrigger.triggerId, consentTrigger.triggerId],
      { oncePerLoad: true, priority: 10, consentTypes: ['ad_storage'] },
    ),
  );
```

(The two `ACC - * dataLayer bridge` tag calls immediately below are unchanged — they already re-evaluate on every `ANALYTICS_EVENTS` push and don't need the new trigger.)

- [ ] **Step 3: Update the summary log line**

Change:

```js
  console.log('Created/updated GTM tags: GA4 base, Meta base, GA4 bridge, Meta bridge.');
```

to:

```js
  console.log('Created/updated GTM tags: GA4 base, Meta base, GA4 bridge, Meta bridge.');
  console.log('GA4 base and Meta Pixel base now also fire on ACC - Consent Update (re-fire after mid-session Accept).');
```

- [ ] **Step 4: Run against the real draft workspace (no publish) and verify**

Run: `npm run gtm:setup`
Expected output includes lines like:
```
Using existing workspace: ACC analytics stack
Created trigger: ACC - Consent Update
Updated tag: ACC - GA4 base
Updated tag: ACC - Meta Pixel base
Updated tag: ACC - GA4 dataLayer bridge
Updated tag: ACC - Meta dataLayer bridge
Created/updated GTM tags: GA4 base, Meta base, GA4 bridge, Meta bridge.
GA4 base and Meta Pixel base now also fire on ACC - Consent Update (re-fire after mid-session Accept).
Not published. Use GTM Preview first, then rerun with --publish if it looks good.
```

- [ ] **Step 5: Read back and confirm the wiring (read-only check, not a repo file — run inline)**

```bash
node -e "
const { google } = require('googleapis');
(async () => {
  const auth = await google.auth.getClient({
    keyFile: '.secrets/gtm-api-deploy.json',
    scopes: ['https://www.googleapis.com/auth/tagmanager.readonly'],
  });
  const tagmanager = google.tagmanager({ version: 'v2', auth });
  const parent = 'accounts/6000988917/containers/254296918/workspaces/12';
  const tags = await tagmanager.accounts.containers.workspaces.tags.list({ parent });
  for (const t of ['ACC - GA4 base', 'ACC - Meta Pixel base']) {
    const tag = tags.data.tag.find((x) => x.name === t);
    console.log(t, '| firingTriggerId:', tag.firingTriggerId);
  }
})();
"
```
Expected: both lines show TWO trigger ids (the `ACC - Initialization` id from before, plus a new one for `ACC - Consent Update`).

Note: no `git commit` for this task's *effect* (it changes live GTM workspace state, not a file), but the `scripts/gtm-api.mjs` source diff from Steps 1–3 does get committed:

- [ ] **Step 6: Commit the script change**

```bash
git add scripts/gtm-api.mjs
git commit -m "feat(gtm): add ACC - Consent Update trigger to the two base tags

Wires a second firing trigger onto ACC - GA4 base / ACC - Meta Pixel base so
they get a fresh chance to fire once a visitor accepts consent mid-session,
instead of staying blocked for the rest of that session (see
docs/superpowers/specs/2026-07-27-gtm-consent-refire-design.md)."
```

---

### Task 3: Gate Microsoft Clarity with the same trigger

**Files:** none committed — Clarity is managed directly via the GTM UI/API, not by `scripts/gtm-api.mjs` (see PR #200). This is a one-off operational action against the live workspace, run the same way the original Clarity consent-gating fix was done.

**Interfaces:**
- Consumes: the `ACC - Consent Update` trigger created in Task 2 (looked up by name, not hardcoded id — its numeric id isn't known ahead of time).
- Produces: Clarity's `firingTriggerId` array in the draft workspace gains the new trigger's id, alongside its existing one. Nothing else about the tag changes.

- [ ] **Step 1: Run this one-off script**

```bash
node -e "
const { google } = require('googleapis');
(async () => {
  const auth = await google.auth.getClient({
    keyFile: '.secrets/gtm-api-deploy.json',
    scopes: [
      'https://www.googleapis.com/auth/tagmanager.readonly',
      'https://www.googleapis.com/auth/tagmanager.edit.containers',
    ],
  });
  const tagmanager = google.tagmanager({ version: 'v2', auth });
  // Workspace IDs are not stable in this container (observed 12 -> 16 -> 17
  // across one session) — always resolve by name, never hardcode a path.
  const containerPath = 'accounts/6000988917/containers/254296918';
  const workspaces = await tagmanager.accounts.containers.workspaces.list({ parent: containerPath });
  const ws = workspaces.data.workspace.find((w) => w.name === 'ACC analytics stack');
  if (!ws) throw new Error('ACC analytics stack workspace not found (run Task 2 first)');
  const parent = ws.path;

  const tags = await tagmanager.accounts.containers.workspaces.tags.list({ parent });
  const triggers = await tagmanager.accounts.containers.workspaces.triggers.list({ parent });

  const clarity = tags.data.tag.find((t) => t.name === 'Microsoft Clarity - Official');
  const consentTrigger = triggers.data.trigger.find((t) => t.name === 'ACC - Consent Update');
  if (!clarity) throw new Error('Clarity tag not found');
  if (!consentTrigger) throw new Error('ACC - Consent Update trigger not found (run Task 2 first)');

  const firingTriggerId = Array.from(new Set([...(clarity.firingTriggerId ?? []), consentTrigger.triggerId]));

  const updated = await tagmanager.accounts.containers.workspaces.tags.update({
    path: clarity.path,
    requestBody: { ...clarity, firingTriggerId },
  });
  console.log('Updated tag:', updated.data.name, '| firingTriggerId:', updated.data.firingTriggerId);
})();
"
```
Expected: prints `Updated tag: Microsoft Clarity - Official | firingTriggerId: [ '<All Pages id>', '<Consent Update id>' ]` (two ids).

- [ ] **Step 2: No commit** — this step changes only live GTM workspace state, matching how the Clarity consent-gating fix in PR #200 was done (no repo file to stage).

---

### Task 4: Verify re-fire behaviour in GTM Preview before publishing

**Files:** none — this is verification against the live draft workspace, not a code change.

**Interfaces:** none (this task consumes Tasks 1–3's combined state and produces a pass/fail verification result gating Task 5).

- [ ] **Step 1: Start the local dev server**

```bash
npm run dev
```

- [ ] **Step 2: Open GTM Preview**

In the browser (the user's own logged-in Google session — the service account cannot use the GTM web UI): go to `https://tagmanager.google.com/#/container/accounts/6000988917/containers/254296918/workspaces/12`, click **Preview**, enter the local dev server URL (e.g. `http://localhost:3000`), click **Connect**. This opens the site in a new tab wired to Tag Assistant's debug panel.

- [ ] **Step 3: Simulate a first-time visitor who accepts mid-session**

In the connected tab: open a fresh/incognito-equivalent session (no `ciok_consent` cookie), confirm the consent banner is visible, then click **Accept**.

- [ ] **Step 4: Confirm in Tag Assistant**

In the Tag Assistant panel, find the `consent_update` entry in the event timeline and confirm all three of these fired under it (not just evaluated — actually fired, "Tags Fired" not "Tags Not Fired"):
- `ACC - GA4 base`
- `ACC - Meta Pixel base`
- `Microsoft Clarity - Official`

Also confirm the two bridge tags (`ACC - GA4 dataLayer bridge`, `ACC - Meta dataLayer bridge`) fire correctly on the *next* qualifying event after that (e.g. click something that fires `add_to_cart` or navigate to fire a fresh `page_view`), confirming `window.gtag`/`window.fbq` are now defined.

- [ ] **Step 5: Handle the outcome**

- **All three fire correctly:** proceed to Task 5.
- **Any of the three still show "Tags Not Fired" under `consent_update`:** this confirms the community-reported "once per page consumes the budget even when blocked" GTM quirk applies here. Do not proceed to Task 5. Stop and report which tag(s) failed — the fallback (Alternative 1 in the design doc: trigger-level consent logic instead of tag-level Additional Consent Checks) needs its own follow-up plan, not a same-session patch.

---

### Task 5: Publish and update docs

**Files:**
- Modify: `docs/analytics-stack.md`
- Create: `docs/GTM-NPHLG9NR_v<N>.json` (N = the new published version number, known only after Step 3)
- Delete: `docs/GTM-NPHLG9NR_v12.json` (the version this supersedes — confirm the exact current filename with `ls docs/GTM-NPHLG9NR_v*.json` first, since PR #200/#201 may have changed it by the time this task runs)

**Interfaces:** none — this is the rollout/documentation task, no code consumed or produced.

- [ ] **Step 1: Sync the workspace before publishing**

```bash
node -e "
const { google } = require('googleapis');
(async () => {
  const auth = await google.auth.getClient({
    keyFile: '.secrets/gtm-api-deploy.json',
    scopes: ['https://www.googleapis.com/auth/tagmanager.edit.containers'],
  });
  const tagmanager = google.tagmanager({ version: 'v2', auth });
  // Workspace IDs are not stable in this container (observed 12 -> 16 -> 17
  // across one session in Task 2) — always resolve by name, never hardcode a path.
  const containerPath = 'accounts/6000988917/containers/254296918';
  const workspaces = await tagmanager.accounts.containers.workspaces.list({ parent: containerPath });
  const ws = workspaces.data.workspace.find((w) => w.name === 'ACC analytics stack');
  if (!ws) throw new Error('ACC analytics stack workspace not found (run Task 2 first)');
  const result = await tagmanager.accounts.containers.workspaces.sync({ path: ws.path });
  console.log('workspace path used:', ws.path);
  console.log(JSON.stringify(result.data, null, 2));
})();
"
```
Expected: `{ "syncStatus": {} }` (no conflicts). If it reports conflicts, stop and resolve them manually before continuing — do not publish over an unresolved conflict.

- [ ] **Step 2: Create and publish the version**

```bash
node -e "
const { google } = require('googleapis');
(async () => {
  const auth = await google.auth.getClient({
    keyFile: '.secrets/gtm-api-deploy.json',
    scopes: [
      'https://www.googleapis.com/auth/tagmanager.readonly',
      'https://www.googleapis.com/auth/tagmanager.edit.containers',
      'https://www.googleapis.com/auth/tagmanager.edit.containerversions',
      'https://www.googleapis.com/auth/tagmanager.publish',
    ],
  });
  const tagmanager = google.tagmanager({ version: 'v2', auth });
  const containerPath = 'accounts/6000988917/containers/254296918';
  const workspaces = await tagmanager.accounts.containers.workspaces.list({ parent: containerPath });
  const ws = workspaces.data.workspace.find((w) => w.name === 'ACC analytics stack');
  if (!ws) throw new Error('ACC analytics stack workspace not found (run Task 2 first)');
  const version = await tagmanager.accounts.containers.workspaces.create_version({
    path: ws.path,
    requestBody: {
      name: 'Consent-update re-fire for base tags + Clarity',
      notes: 'Adds ACC - Consent Update trigger so GA4 base, Meta Pixel base, and Clarity get a fresh chance to fire when a visitor accepts consent mid-session, instead of staying blocked for the rest of that session.',
    },
  });
  const versionPath = version.data.containerVersion.path;
  console.log('Created version:', versionPath, '| containerVersionId:', version.data.containerVersion.containerVersionId);
  const published = await tagmanager.accounts.containers.versions.publish({ path: versionPath });
  console.log('Published:', published.data.containerVersion.path);
})();
"
```
Expected: prints the new version path and containerVersionId, then confirms publish.

- [ ] **Step 3: Re-verify the live container**

```bash
node -e "
const { google } = require('googleapis');
(async () => {
  const auth = await google.auth.getClient({
    keyFile: '.secrets/gtm-api-deploy.json',
    scopes: ['https://www.googleapis.com/auth/analytics.readonly', 'https://www.googleapis.com/auth/tagmanager.readonly'],
  });
  const tagmanager = google.tagmanager({ version: 'v2', auth });
  const live = await tagmanager.accounts.containers.versions.live({
    parent: 'accounts/6000988917/containers/254296918',
  });
  console.log('containerVersionId:', live.data.containerVersionId);
  for (const t of ['ACC - GA4 base', 'ACC - Meta Pixel base', 'Microsoft Clarity - Official']) {
    const tag = live.data.tag.find((x) => x.name === t);
    console.log(t, '| firingTriggerId:', tag.firingTriggerId, '| consentStatus:', tag.consentSettings?.consentStatus);
  }
})();
"
```
Expected: `containerVersionId` matches Step 2's output; all three tags show two firing triggers and `consentStatus: needed` (Clarity) / already-correct values (base tags, unchanged from before).

- [ ] **Step 4: Export the new live version, replace the old one**

```bash
ls docs/GTM-NPHLG9NR_v*.json
```
Note the current filename (the plan assumes `docs/GTM-NPHLG9NR_v12.json` — adjust if PR #200/#201 shipped a different number by the time this runs). Then:

```bash
node -e "
const fs = require('node:fs');
const { google } = require('googleapis');
(async () => {
  const auth = await google.auth.getClient({
    keyFile: '.secrets/gtm-api-deploy.json',
    scopes: ['https://www.googleapis.com/auth/tagmanager.readonly'],
  });
  const tagmanager = google.tagmanager({ version: 'v2', auth });
  const live = await tagmanager.accounts.containers.versions.live({
    parent: 'accounts/6000988917/containers/254296918',
  });
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const exportTime = \`\${now.getFullYear()}-\${pad(now.getMonth() + 1)}-\${pad(now.getDate())} \${pad(now.getHours())}:\${pad(now.getMinutes())}:\${pad(now.getSeconds())}\`;
  const out = { exportFormatVersion: 2, exportTime, containerVersion: live.data };
  fs.writeFileSync(\`docs/GTM-NPHLG9NR_v\${live.data.containerVersionId}.json\`, JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote docs/GTM-NPHLG9NR_v' + live.data.containerVersionId + '.json');
})();
"
git rm docs/GTM-NPHLG9NR_v12.json  # replace 12 with whatever Step 4's `ls` actually showed
```

- [ ] **Step 5: Document the new event and the fix in `docs/analytics-stack.md`**

Add a row to the Event Contract section, right after the existing table that lists `page_view`…`site_engagement` (find the line `| \`site_engagement\` | scroll depth, ... |` and add directly below the table, before the `All custom events ride...` paragraph):

```markdown
`consent_update` is a GTM-internal signal only — pushed by `setConsent()` in `src/components/consent/consent-mode.ts` right after its `gtag('consent','update',...)` call, so GTM's `ACC - Consent Update` trigger can give the two base tags (and Microsoft Clarity) a fresh chance to fire if a visitor accepts consent mid-session rather than arriving with it already granted. Deliberately excluded from `ANALYTICS_EVENTS`, so it's never forwarded to GA4/Meta as a fake event.
```

Update the Container Change Checklist's tag list (find the line starting `3. Confirm every consent-relevant tag...` from PR #200's revision) to mention the new trigger:

```markdown
3. Confirm every consent-relevant tag still shows `consentSettings.consentStatus: "needed"` in the export, gated on `analytics_storage` or `ad_storage` as appropriate, **and** that `ACC - GA4 base`, `ACC - Meta Pixel base`, and `Microsoft Clarity - Official` each fire on two triggers (`ACC - Initialization`/its own base trigger, plus `ACC - Consent Update`) — this is what lets them recover if a visitor accepts consent mid-session instead of on load.
```

- [ ] **Step 6: Commit**

```bash
git add docs/analytics-stack.md docs/GTM-NPHLG9NR_v*.json
git commit -m "docs(analytics-stack): publish GTM consent-update re-fire fix

Published as the new live container version. GA4 base, Meta Pixel base, and
Microsoft Clarity now each fire on two triggers, so a visitor who accepts
consent mid-session gets working tracking for the rest of that session
instead of none. Verified in GTM Preview before publishing (see
docs/superpowers/specs/2026-07-27-gtm-consent-refire-design.md)."
```

- [ ] **Step 7: Push and open a PR**

```bash
git push -u origin <branch-name>
gh pr create --title "fix(analytics): re-fire GA4/Meta/Clarity when consent is granted mid-session" --body "Implements docs/superpowers/specs/2026-07-27-gtm-consent-refire-design.md. Verified in GTM Preview per Task 4 before publishing as the new live container version — see commit history for the exact verification result."
```
