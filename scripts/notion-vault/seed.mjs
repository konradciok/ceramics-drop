#!/usr/bin/env node
/**
 * Seed the Notion knowledge vault (operational DB) — ontology + Tier-0 pages.
 *
 * The vault owns NON-CODE knowledge only (decisions, ops rituals, external
 * accounts, glossary). The repo (AGENTS.md, docs/, code) stays the engineering
 * source of truth; every page names its "Source of truth" cross-link.
 *
 * Idempotent: upserts by page Name (create-or-update-in-place).
 *   --dry-run   print the plan, write nothing
 *   --reset     archive ALL existing rows first (use for a clean re-seed)
 *
 * Usage: node scripts/notion-vault/seed.mjs [--dry-run] [--reset]
 *
 * Reuses NotionClient / loadDotEnv / requireEnv from scripts/notion-i18n/lib.mjs.
 */
import { loadDotEnv, requireEnv, NotionClient } from '../notion-i18n/lib.mjs';

loadDotEnv();
const notion = new NotionClient(requireEnv('NOTION_TOKEN'));
const DB = requireEnv('NOTION_OPERATIONAL_DB_ID');
const DRY = process.argv.includes('--dry-run');
const RESET = process.argv.includes('--reset');

// ─── block builders ────────────────────────────────────────────────────────
const rt = (content, opts = {}) =>
  [{ type: 'text', text: { content, ...(opts.url ? { link: { url: opts.url } } : {}) } }];
const para = (c, o) => ({ type: 'paragraph', paragraph: { rich_text: rt(c, o) } });
const h1 = (c) => ({ type: 'heading_1', heading_1: { rich_text: rt(c) } });
const h2 = (c) => ({ type: 'heading_2', heading_2: { rich_text: rt(c) } });
const h3 = (c) => ({ type: 'heading_3', heading_3: { rich_text: rt(c) } });
const bullet = (c, o) => ({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(c, o) } });
const code = (c, lang = 'plain text') => ({ type: 'code', code: { rich_text: rt(c), language: lang } });
const callout = (c) => ({ type: 'callout', callout: { rich_text: rt(c), icon: { type: 'emoji', emoji: '⚠️' } } });
const adr = (n, title, ctx, dec, alt, rev) => [
  h3(`ADR-${n} — ${title}`),
  para(`Context: ${ctx}`),
  para(`Decision: ${dec}`),
  bullet(`Alternatives considered: ${alt}`),
  bullet(`Reversible? ${rev} (${TODAY})`),
];

// ─── DB schema (the ontology) ──────────────────────────────────────────────
const PROPERTIES = {
  Name: { title: {} },
  Domain: {
    select: {
      options: [
        { name: 'Decisions', color: 'purple' },
        { name: 'Operations', color: 'red' },
        { name: 'Product', color: 'green' },
        { name: 'External Accounts', color: 'blue' },
        { name: 'Glossary', color: 'yellow' },
        { name: 'Roadmap', color: 'orange' },
        { name: 'Editorial', color: 'pink' },
      ],
    },
  },
  Temporal: {
    select: {
      options: [
        { name: 'Living', color: 'green' },
        { name: 'Snapshot', color: 'gray' },
      ],
    },
  },
  Status: {
    select: {
      options: [
        { name: 'Current', color: 'green' },
        { name: 'Draft', color: 'yellow' },
        { name: 'Stale', color: 'red' },
      ],
    },
  },
  'Last verified': { date: {} },
  'Source of truth': { rich_text: {} },
};

// ─── page content ──────────────────────────────────────────────────────────
const TODAY = '2026-07-16';

const PAGES = [
  // 1 ── Start Here ───────────────────────────────────────────────────────
  {
    name: 'Start Here',
    domain: null,
    temporal: 'Living',
    status: 'Current',
    verified: TODAY,
    sot: 'Router page. Engineering source of truth: AGENTS.md (repo).',
    children: [
      h1('Start Here — Knowledge Vault'),
      para('Anna Ciok Ceramics — a storefront for one-of-a-kind ceramic pieces (~125 across 9 categories) plus fine-art prints fulfilled on demand via Prodigi. Next.js 16 App Router on Cloudflare Workers (OpenNext). 4 locales (PL default + /en /es /de), multi-currency via a currency_pref cookie. Live at anna-ciok.studio.'),
      h2('What this vault is — and is not'),
      callout('Non-code knowledge only. The repo (AGENTS.md, docs/, code) is the engineering source of truth. This vault owns only what code cannot answer: why decisions were made, operational rituals, external-account locations, domain vocabulary. Every page names its "Source of truth" cross-link — if a page duplicates the repo, delete it.'),
      h2('Ontology'),
      bullet('Domain — Decisions · Operations · Product · External Accounts · Glossary · Roadmap · Editorial'),
      bullet('Temporal — Living (current truth, maintained when reality changes) vs Snapshot (a frozen single record — a standalone ADR or postmortem). The Tier-0 pages here are all Living logs/indexes; individual ADRs and postmortems added later are Snapshots.'),
      bullet('Status — Current · Draft · Stale. A Living page not edited for >6 months should be flagged Stale and verified before an agent trusts it as current.'),
      h2('Section map — where each kind of knowledge lives'),
      bullet('Engineering (architecture, commands, conventions, DB schema, deploy, env vars) → AGENTS.md'),
      bullet('CLI usage (orders / prodigi / print-assets) → docs/*-cli.md + .cursor/rules/*.mdc'),
      bullet('Per-initiative plans & live progress → docs/plans/, docs/superpowers/{specs,plans}/'),
      bullet('Decision rationale (the "why") → this vault, [ADR] Decision log'),
      bullet('Operational rituals (migration drift, prod-inventory e2e, debug tokens) → this vault, [OPS] Operational rituals'),
      bullet('External accounts & dashboards → this vault, [ACCT] External accounts'),
      bullet('Terms & vocabulary → this vault, [GLOSSARY] Terms'),
      bullet('UI strings → messages/{pl,en,es,de}.json · DB schema → supabase/migrations/ · CI/deploy → .github/workflows/, wrangler.jsonc'),
      h2('How agents query this vault'),
      para('Via the Notion MCP server (named "notion"). Read this Start Here page first, then the relevant [OPS] / [ACCT] / [GLOSSARY] page. The database id lives in NOTION_OPERATIONAL_DB_ID. For programmatic access from scripts, reuse the NotionClient in scripts/notion-i18n/lib.mjs (reads NOTION_TOKEN from .env).'),
      h2('Freshness'),
      para('Living pages reflect current truth — update them when reality changes, and set "Last verified". Snapshot pages are frozen on creation. When in doubt, check "Last verified" and Status before acting on a page.'),
    ],
  },

  // 2 ── Glossary ─────────────────────────────────────────────────────────
  {
    name: '[GLOSSARY] Terms',
    domain: 'Glossary',
    temporal: 'Living',
    status: 'Current',
    verified: TODAY,
    sot: 'Terms are defined in code: src/lib/products.ts, prints.ts, print-cart.ts, private-sale.ts, inventory.ts, checkout.ts.',
    children: [
      h1('Glossary'),
      para('Shared vocabulary used across code and docs. Each term links to its defining code so this page never drifts from the implementation.'),
      h2('Catalogue & inventory'),
      bullet('drop — a release cohort of pieces. Each piece carries a dropId (default drop-1); drops carry active/ended state and a label. (src/lib/products.ts)'),
      bullet('piece — a single one-of-a-kind ceramic product (id like k01 = kubki 01). No quantities; once sold, gone. The id is a stable token that never renumbers. (src/lib/products.ts)'),
      bullet('variant — a purchasable option of a fine-art PRINT (size × frame × mount × frameColour). Prints are NOT one-of-a-kind. (src/lib/prints.ts, src/lib/print-cart.ts)'),
      bullet('showroom — a piece status: rendered on the storefront with a badge but excluded from purchase by isProductPurchasable. (src/lib/products.ts)'),
      bullet('noteIndex — index into messages/{locale}.json for a product’s editorial notes. (src/lib/products.ts)'),
      h2('Checkout'),
      bullet('attemptId — client-side checkout attempt id. Stale → 409 order_conflict (client resets it); concurrent/unresolvable → 409 checkout_in_progress (client KEEPS it and retries). (src/app/api/checkout/route.ts)'),
      bullet('private-sale token — single-use token that re-offers an already-SOLD piece to a specific buyer. Ceramics-only; checkout rejects a token combined with prints. (src/lib/private-sale.ts, private_sales table)'),
      bullet('CATALOG_SOURCE — env selecting the storefront catalogue source: db (production — Supabase shadow tables) vs code (static registry; local/test fallback). (src/lib/catalog/, wrangler.jsonc)'),
      h2('Fulfilment'),
      bullet('POD variant — print-on-demand variant mapped to a Prodigi SKU (pod_variants table, reconciled by npm run sync-prodigi-skus). (src/lib/print-cart.ts)'),
      bullet('fulfilment job — a row in fulfilment_jobs queued for async Prodigi submission via the Cloudflare Queue prodigi-fulfilment. (src/server/fulfilment/)'),
      bullet('print-area profile — per-product Prodigi print-area definition used to derive fulfilment assets. (config/print-assets/)'),
      h2('Conventions'),
      bullet('ponytail: marker — a code comment flagging a deliberate shortcut or known ceiling (e.g. “global lock, per-account locks if throughput matters”). Tracked by docs/pony-audit.md and the ponytail-debt ledger; not a TODO.'),
    ],
  },

  // 3 ── Operational rituals ──────────────────────────────────────────────
  {
    name: '[OPS] Operational rituals',
    domain: 'Operations',
    temporal: 'Living',
    status: 'Current',
    verified: TODAY,
    sot: 'The rituals live here (no in-repo canonical home). Underlying code: AGENTS.md, supabase/migrations/, src/app/api/.',
    children: [
      h1('Operational rituals'),
      callout('These have no canonical home in the repo and have already caused a production outage. If you change schema, fulfilment, or e2e, read this page first.'),
      h2('Supabase migrations: merge ≠ apply'),
      para('Merging a PR that ships supabase/migrations/*.sql does NOT apply it to production. The Cloudflare Workers deploy (Workers Builds CI, fires on push to main) is app-only — it never touches DB schema. Migrations apply separately, via supabase db push or the Supabase MCP.'),
      para('Why it matters: storefront inventory reads degrade gracefully (getSoldIds / getShowroomIds are .catch(() => [])), so the site looks fine. But admin pages and API routes that select the new columns/tables without a catch will 500 until the migration lands. After PR #127 merged on 2026-07-09, /admin/inventory, /api/admin/*, and /api/interest were broken until the showroom migration was applied.'),
      h2('Migration drift ledger'),
      para('The CLI tracks applied migrations by version timestamp. A migration applied via MCP/manual SQL can register under a different version than the local file, so supabase migration list shows a local/remote mismatch. This is history drift, not a missing schema change. Reconcile with migration repair --linked:'),
      bullet('remote-only orphan (no local file) → --status reverted <ver> clears the bookkeeping (does NOT revert the actual schema).'),
      bullet('local file merged-but-never-pushed whose schema is already live under an orphan → --status applied <ver> marks the local version applied without running it. Verify the schema is genuinely live first (supabase db query --linked against information_schema), since marking applied hides any real gap.'),
      para('migration list is the source of truth for drift — re-check it before pushing. As of 2026-07-16 the ledger is fully reconciled and clean (no pending, no orphans). Drift recurs whenever schema is changed outside db push.'),
      h3('Audit for missing piece_state rows'),
      para('reserve_pieces() only UPDATEs existing rows, so a catalogue id with no row is never actually reserved (silent double-sale risk). Paste current ids (getProducts().map(p => p.id)) into the array; any rows returned are missing a piece_state row:'),
      code("select unnest(array['k01','k02','…']) as id\nexcept\nselect product_id from piece_state;", 'sql'),
      h2('No dev/staging DB — local dev & e2e hit real prod inventory'),
      para('There is no separate dev/staging Supabase project. npm run dev and local Playwright (PLAYWRIGHT_BASE_URL=http://localhost:3000) read/write the same production project via .dev.vars, so local + hermetic e2e see real sold-through inventory.'),
      callout('E2E specs MUST be sell-through-robust. Never assert a specific piece (e.g. the first/lead tile like k01) is available or shoppable — target the first available (:not(.sold)) tile instead. getSoldIds() returns only genuinely sold rows; reservations use status=\'reserved\' + reserved_until and are not included.'),
      h2('Destructive print-purchase E2E — debug token contract'),
      para('/api/debug/fulfilment-status is fail-closed and secret-gated by FULFILMENT_DEBUG_TOKEN (404 unless the token is set, 401 on mismatch); never set in production. The E2E runner passes the same value via E2E_FULFILMENT_DEBUG_TOKEN. It returns a minimal read ({ fulfilmentStatus, prodigiOrderId }, no PII) looked up by ?payment_intent=, used by the destructive print-purchase E2E to assert the Stripe → webhook → queue → Prodigi pipeline advanced (audit H-2).'),
    ],
  },

  // 4 ── External accounts ────────────────────────────────────────────────
  {
    name: '[ACCT] External accounts',
    domain: 'External Accounts',
    temporal: 'Living',
    status: 'Current',
    verified: TODAY,
    sot: 'Dashboard URLs + refs live here. Credentials: .env.example + AGENTS.md §Environment Variables (runtime secrets via wrangler secret put / .dev.vars).',
    children: [
      h1('External accounts & dashboards'),
      para('Where each external service lives and which env var maps to it. Credentials themselves are runtime secrets — never stored here. Build-time NEXT_PUBLIC_* vars are set as Workers Build env vars, NOT wrangler secrets.'),
      h2('Core'),
      bullet('Supabase — project ref wnlysejenowymjdxlnaq (name “ceramics”, region eu-west-1, db host db.wnlysejenowymjdxlnaq.supabase.co). Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Manage migrations via the CLI (supabase db push), never by pasting SQL into Studio.'),
      bullet('Cloudflare Workers — account 3ebc59b80b15b6b4850ae0734a24ce26, worker “ceramics-drop”, zone df154a46a71277a8b5b4a9e3d9af23ad (anna-ciok.studio). Bindings: R2 PRINT_ASSETS (bucket anna-ciok-print-assets), Queue prodigi-fulfilment. Dashboard: dash.cloudflare.com. Workers Logs at 25% head sampling.'),
      h2('Payments & shipping'),
      bullet('Stripe — PaymentIntent (BLIK/P24/Bizum/cards via pmc_… Payment Method Configuration) + webhook. Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET. Dashboard: dashboard.stripe.com.'),
      bullet('InPost — shipments & Paczkomat lockers (Geowidget v5). Env: INPOST_API_TOKEN, INPOST_ORGANIZATION_ID, INPOST_API_URL, INPOST_WEBHOOK_TOKEN.'),
      bullet('Prodigi — print-on-demand fulfilment (sandbox vs live via PRODIGI_ENV). Env: PRODIGI_API_KEY_SANDBOX, PRODIGI_API_KEY_LIVE, PRODIGI_CALLBACK_TOKEN, PRODIGI_DEFAULT_SHIPPING_METHOD. CLI: npm run prodigi.'),
      h2('Email & analytics'),
      bullet('Resend — transactional email (order confirmations, return labels). Env: RESEND_API_KEY, RESEND_WEBHOOK_SECRET, STUDIO_NOTIFY_EMAIL.'),
      bullet('Meta Conversions API — server-side purchase conversion. Env: META_CAPI_ACCESS_TOKEN (+ optional META_TEST_EVENT_CODE).'),
      bullet('GA4 Measurement Protocol — server-side purchase. Env: GA4_API_SECRET (+ build var NEXT_PUBLIC_GA4_MEASUREMENT_ID). Client analytics via GTM (NEXT_PUBLIC_GTM_ID); GTM API scripts are dev-only.'),
      h2('Access & this vault'),
      bullet('Cloudflare Access — gates /admin and /api/admin in prod. Env: CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, ADMIN_ALLOWED_EMAILS (STUDIO_ADMIN_LOCAL_BYPASS skips it locally).'),
      bullet('Notion — the “glm” integration. NOTION_TOKEN, NOTION_DATABASE_ID (translations DB e0a71651…), NOTION_OPERATIONAL_DB_ID (this vault 39f1bd1a…).'),
    ],
  },

  // 5 ── ADR log (template) ───────────────────────────────────────────────
  {
    name: '[ADR] Decision log',
    domain: 'Decisions',
    temporal: 'Living',
    status: 'Draft',
    verified: TODAY,
    sot: 'Rationale is not in code. Related design specs: docs/superpowers/specs/. Each ADR below is a Snapshot once written as its own page.',
    children: [
      h1('Decision log (ADRs)'),
      para('Why a decision was made — the part code and specs bury as prose. Each entry should record: Context · Decision · Alternatives considered · Date · Reversible? Promote a standalone ADR page (Temporal = Snapshot) when the rationale is long.'),
      h2('To draft'),
      ...adr(1, 'Mixed cart cannot check out together',
        'Ceramics are one-of-a-kind, fulfilled via an InPost shipment created from the Stripe webhook; fine-art prints are print-on-demand, fulfilled asynchronously via Prodigi through a Cloudflare Queue. A cart can hold both kinds.',
        'Checkout rejects a mixed cart — the two kinds must be checked out separately, producing separate orders on separate fulfilment paths.',
        'One order with two fulfilment sub-flows — rejected: rare case, and ceramic reservation vs print-asset resolution have different failure/rollback semantics.',
        'Yes, but would mean unifying two pipelines; no mixed-cart demand observed.'),
      ...adr(2, 'Display currency is decoupled from locale (currency_pref cookie)',
        'Four locales (PL default + EN/ES/DE). Visitors need PLN (Poland), EUR (most of EU), or GBP (UK), but locale does not map cleanly to currency (e.g. an English-locale visitor in Poland).',
        'Display currency comes from a currency_pref cookie, not the locale. PL → always PLN; other locales default to EUR and can switch to GBP, seeded from CF-IPCountry and clamped to a switchable set.',
        'One currency per locale (simpler) — rejected because it misprices visitors whose locale and country diverge.',
        'Yes; cookie-driven, no schema coupling.'),
      ...adr(3, 'Deterministic purchase event_id dedups browser + server measurement',
        'Purchase is measured twice — client-side (GA4/Meta via GTM) and server-side (Meta CAPI + GA4 MP from the webhook). Without dedup the same purchase counts twice.',
        'Both sides use a deterministic event_id of purchase-<payment_intent_id>. The browser defaults orderNo to the PaymentIntent id on /koszyk/return; conversions.ts uses the same key.',
        'Browser-generated UUID passed to the server — rejected as fragile extra contract surface; relying on platform fuzzy dedup — rejected as unreliable.',
        'Yes, but changing the key without updating BOTH sides re-breaks dedup (see docs/analytics-stack.md).'),
      h2('Still to draft'),
      bullet('No separate “gb” locale — GBP is a cookie-driven display currency, merged into /en. Spec: docs/superpowers/specs/2026-07-05-en-gb-locale-merge-design.md.'),
      bullet('CATALOG_SOURCE=db in production — storefront reads Supabase shadow tables; code registry remains the structural seed. (wrangler.jsonc, src/lib/catalog/)'),
      bullet('src/middleware.ts must not be renamed to proxy.ts — Next 16 proxy.ts is Node-runtime only; OpenNext rejects it and the Cloudflare build breaks.'),
      bullet('Hardcoded STRIPE_PMC_ID (pmc_…) — enables BLIK/P24/Bizum/cards without per-Dashboard wiring.'),
    ],
  },

  // 6 ── Domains / system map (template) ──────────────────────────────────
  {
    name: 'Domains — system map',
    domain: 'Roadmap',
    temporal: 'Living',
    status: 'Draft',
    verified: TODAY,
    sot: 'Thin router into AGENTS.md §Architecture. This page adds only the at-a-glance map.',
    children: [
      h1('System domains'),
      para('A one-line map of the system’s domains, each pointing into AGENTS.md for the real detail. Kept thin on purpose — do not copy architecture prose here.'),
      bullet('Storefront — collection pages, /sklep hub, PDPs (route groups under src/app/[locale]/). → AGENTS.md §Storefront Surfaces'),
      bullet('Cart & checkout — Zustand cart (acc_cart_v1), POST /api/checkout, reserve_pieces, Stripe PI. → AGENTS.md §Cart, §Checkout Flow'),
      bullet('Ceramic fulfilment — InPost shipment creation from the Stripe webhook. → AGENTS.md §Webhook Fulfillment'),
      bullet('Print fulfilment (Prodigi) — queue pipeline + callbacks. → AGENTS.md §Fine-Art Prints & Prodigi'),
      bullet('Admin / CMS — back-office UI + Cloudflare Access gate + CMS publish. → AGENTS.md §Admin'),
      bullet('Analytics & conversions — GTM/GA4/Meta client + CAPI/MP server. → AGENTS.md §Analytics & Conversions, docs/analytics-stack.md'),
      bullet('i18n — 4 locales, next-intl, Notion translation editor. → AGENTS.md §Internationalization, docs/notion-i18n.md'),
    ],
  },

  // 7 ── Products editorial (template) ────────────────────────────────────
  {
    name: 'Products — catalogue editorial',
    domain: 'Product',
    temporal: 'Living',
    status: 'Draft',
    verified: TODAY,
    sot: 'Structural registry: src/lib/products.ts + src/lib/prints.ts. This page owns only the editorial layer code cannot carry.',
    children: [
      h1('Catalogue editorial layer'),
      para('The narrative, provenance, and curation context behind the pieces — everything the registry’s ids and prices cannot express. The structural catalogue (ids, categories, prices, image paths) lives in code; do not duplicate it here.'),
      h2('Sections to fill'),
      bullet('Drop narrative — the story behind each drop (drop-1, …).'),
      bullet('Provenance — clay/glaze origin, firing, one-of-a-kind notes per piece or category.'),
      bullet('Photography status — which pieces/sets are shot vs pending; the design/uploads → public/uploads pipeline (npm run optimize-images).'),
      bullet('Pricing rationale — why per-category PLN/EUR/GBP (src/lib/pricing.ts states values, not reasoning).'),
      bullet('Featured / hero pieces — what’s surfaced on the homepage and /sklep, and why.'),
    ],
  },

  // 8 ── Conventions editorial (template) ─────────────────────────────────
  {
    name: 'Conventions — editorial & content',
    domain: 'Editorial',
    temporal: 'Living',
    status: 'Draft',
    verified: TODAY,
    sot: 'Engineering conventions (monetary, IDs, CSS, API errors, build system) → AGENTS.md §Key Conventions. This page owns only content/voice conventions.',
    children: [
      h1('Editorial & content conventions'),
      para('Voice, naming, and content rules — the editorial layer. Engineering conventions live in AGENTS.md §Key Conventions; do not mirror them here.'),
      h2('Sections to fill'),
      bullet('Brand voice — tone for PL/EN/ES/DE copy (Anna Ciok studio).'),
      bullet('Piece naming — how display names and categories are written across locales.'),
      bullet('Photography conventions — framing, background, natural ratio (never cropped), WebP pipeline.'),
      bullet('Code comment conventions — the ponytail: marker (deliberate shortcut with named ceiling + upgrade path); see docs/pony-audit.md.'),
    ],
  },

  // 9 ── Timeline (template) ──────────────────────────────────────────────
  {
    name: 'ChangeLog — milestones & incidents',
    domain: 'Operations',
    temporal: 'Living',
    status: 'Draft',
    verified: TODAY,
    sot: 'Code releases (commit-level) → CHANGELOG.md (release-please). This page owns business/operational events only.',
    children: [
      h1('Timeline — milestones & incidents'),
      para('Business milestones, drops, launches, and incidents — the operational history that release-please’s CHANGELOG.md does not capture. Individual incident entries become Snapshot pages when written up fully.'),
      h2('Seed incidents (to expand)'),
      bullet('GTM event loop on page reload (~998 GA4/Meta calls) — postmortem in docs/gtm-hotfix.md.'),
      bullet('Migration-drift outage after PR #127 — /admin/inventory, /api/admin/*, /api/interest 500’d until the showroom migration was applied (2026-07-09). Ritual captured on [OPS] Operational rituals.'),
    ],
  },
];

// ─── helpers ───────────────────────────────────────────────────────────────
const titleOf = (page) => page.properties?.Name?.title?.map((t) => t.plain_text).join('') ?? '';

async function listRows() {
  const rows = [];
  let cursor;
  do {
    const res = await notion.request('POST', `/databases/${DB}/query`, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    rows.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return rows;
}

function propsFor(p) {
  const props = {
    Name: { title: rt(p.name) },
    Temporal: { select: { name: p.temporal } },
    Status: { select: { name: p.status } },
    'Last verified': { date: { start: p.verified } },
    'Source of truth': { rich_text: rt(p.sot) },
  };
  if (p.domain) props.Domain = { select: { name: p.domain } };
  return props;
}

async function archiveChildren(pageId) {
  let cursor;
  do {
    const qs = new URLSearchParams({ page_size: '100', ...(cursor ? { start_cursor: cursor } : {}) });
    const res = await notion.request('GET', `/blocks/${pageId}/children?${qs}`);
    for (const b of res.results) {
      await notion.request('PATCH', `/blocks/${b.id}`, { archived: true });
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
}

// ─── run ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`vault DB: ${DB}`);
  console.log(`mode: ${DRY ? 'DRY-RUN (no writes)' : 'LIVE'}${RESET ? ' + RESET' : ''}`);
  console.log('');

  // 1. schema
  console.log(`schema: patch ${Object.keys(PROPERTIES).join(', ')}`);
  if (!DRY) await notion.request('PATCH', `/databases/${DB}`, { properties: PROPERTIES });

  // 2. existing rows
  const rows = await listRows();
  const byName = new Map(rows.filter((r) => titleOf(r)).map((r) => [titleOf(r), r.id]));
  const unnamed = rows.filter((r) => !titleOf(r)).map((r) => r.id);
  console.log(`existing: ${rows.length} rows (${byName.size} named, ${unnamed.length} empty)\n`);

  if (RESET && !DRY) {
    for (const id of rows.map((r) => r.id)) {
      await notion.request('PATCH', `/pages/${id}`, { archived: true });
    }
    console.log(`reset: archived ${rows.length} existing rows\n`);
    byName.clear();
  } else if (RESET && DRY) {
    console.log(`reset (dry-run): would archive ${rows.length} existing rows\n`);
  }

  // 3. upsert pages
  for (const p of PAGES) {
    const existingId = byName.get(p.name);
    const action = existingId ? 'update' : 'create';
    console.log(`  [${action}] ${p.name}  (${p.domain ?? '—'} · ${p.temporal} · ${p.status})  [${p.children.length} blocks]`);
    if (DRY) continue;
    if (existingId) {
      await notion.request('PATCH', `/pages/${existingId}`, { properties: propsFor(p) });
      await archiveChildren(existingId);
      for (let i = 0; i < p.children.length; i += 100) {
        await notion.request('PATCH', `/blocks/${existingId}/children`, { children: p.children.slice(i, i + 100) });
      }
    } else {
      await notion.request('POST', '/pages', {
        parent: { database_id: DB },
        icon: { type: 'emoji', emoji: '🗂️' },
        properties: propsFor(p),
        children: p.children.slice(0, 100),
      });
    }
  }

  // 4. cleanup unnamed (non-reset runs)
  if (!RESET && unnamed.length && !DRY) {
    for (const id of unnamed) await notion.request('PATCH', `/pages/${id}`, { archived: true });
    console.log(`\ncleanup: archived ${unnamed.length} empty row(s)`);
  } else if (!RESET && unnamed.length && DRY) {
    console.log(`\ncleanup (dry-run): would archive ${unnamed.length} empty row(s)`);
  }

  console.log(`\ndone: ${PAGES.length} pages ${DRY ? 'planned' : 'upserted'}.`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
