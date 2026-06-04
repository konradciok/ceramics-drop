# GTM hotfix: stop GA4/Meta event loop on page reload

## Symptom

~998 `gtag('event', …)` calls per single app `page_view` on reload.

## Cause

The GA4 bridge calls `gtag('event', …)`, which pushes back into `dataLayer` and re-fires the same GTM custom-event trigger until the queue cap (~1000).

## Fix

Bridge tags dedupe by `event_id` via `window.__accBridgeSent` (see `scripts/gtm-api.mjs`).

Publish with:

```bash
npm run gtm:setup -- --publish
```

## Verify

```bash
node scripts/verify-analytics-count.mjs https://anna-ciok.studio/en
```

Expected: `totalGtagEvents` is **1** (homepage) or **2** (collection pages with `view_item_list`).

Live container versions:

- **v5** — published without dedupe (loop still present)
- **v6+** — includes dedupe guard (loop fixed)
