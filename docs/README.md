# Docs index

Status tags: **active** (current guidance — trust it) · **runbook** (operator
procedures) · **reference** (background/deep-dive, verify dates) ·
**historical** (archived — see `archive/`, facts may be false today).

Lifecycle rule (also in `AGENTS.md` § Context map): plans/specs are dated
`YYYY-MM-DD-*`; when done or superseded, move them to `docs/archive/` and update
this index. Audits go in `docs/audits/`. Volatile feature-state facts go in
`STATUS.md`, not in `AGENTS.md`.

## Start here

| Doc | Status | What it is |
|---|---|---|
| [`STATUS.md`](STATUS.md) | active | Volatile feature-state facts with last-verified dates |
| [`../AGENTS.md`](../AGENTS.md) | active | Canonical agent/project context (architecture, commands, conventions) |
| [`copy-source-of-truth.md`](copy-source-of-truth.md) | active | Owner-approved brand and terminology decisions; draft PL copy, verified fulfillment facts, and implementation gaps (2026-09-09) |
| [`copy/2026-09-09/README.md`](copy/2026-09-09/README.md) | active | PL approval package: preview, full key register, proposed CMS changes and draft documents; not published |
| [`plans/2026-09-09-studio-copy-sales-model.md`](plans/2026-09-09-studio-copy-sales-model.md) | active | Owner's complete copy and sales-model implementation plan; PL approval gate first |

## Guides & runbooks

| Doc | Status | What it is |
|---|---|---|
| [`cloudflare-deployment.md`](cloudflare-deployment.md) | runbook | Workers Builds CI, deploy, env vars |
| [`customer-accounts-runbook.md`](customer-accounts-runbook.md) | runbook | Auth provider setup, Apple secret rotation, deletion |
| [`orders-cli.md`](orders-cli.md) | active | `npm run orders` usage, safety guards, exit codes |
| [`prodigi-cli.md`](prodigi-cli.md) | active | `npm run prodigi` usage (sandbox-first) |
| [`prodigi-contract-smoke.md`](prodigi-contract-smoke.md) | runbook | Sandbox contract smoke (audit H-1) |
| [`prodigi-sku-catalog.md`](prodigi-sku-catalog.md) | reference | Verified Prodigi SKU / print-area matrix |
| [`print-asset-runbook.md`](print-asset-runbook.md) | runbook | Print-asset pipeline operator procedures |
| [`analytics-stack.md`](analytics-stack.md) | active | GA4 + Meta via GTM: event contract, consent, server conversions |
| [`e2e-playwright-purchase-flow.md`](e2e-playwright-purchase-flow.md) | active | E2E design: tags, hermetic mode, destructive opt-in |
| [`stripe-operations.md`](stripe-operations.md) | runbook | Stripe operational procedures |
| [`promo-codes.md`](promo-codes.md) | active | Promo codes: operator runbook (`/admin/promotions`) + technical reference (discount math, redemption lifecycle, analytics contract) |
| [`gift-cards.md`](gift-cards.md) | active | Gift cards: backend contract (`src/lib/gift-cards.ts`), Option A promo_codes mint/revoke design, checkout/webhook wiring, and the `/karta-podarunkowa` PDP + dedicated checkout |
| [`cms-api-data-model.md`](cms-api-data-model.md) | reference | CMS API (S1) data model: draft/revision/publish, audit log, idempotency ledger |
| [`cms-api-integration-environment.md`](cms-api-integration-environment.md) | runbook | Provisioning a real cms-ceramics <-> ceramics-drop Service Binding integration environment |
| [`cms-api-s1-handoff.md`](cms-api-s1-handoff.md) | active | S1 Definition-of-Done handoff: what shipped vs. what still needs an operator or the CMS repo |
| [`notion-i18n.md`](notion-i18n.md) | active | Notion-backed translation workflow |
| [`abandoned-cart-resend.md`](abandoned-cart-resend.md) | reference | Abandoned-cart email design |
| [`complete-inpost.md`](complete-inpost.md) | reference | InPost ShipX integration notes |
| [`gtm-hotfix.md`](gtm-hotfix.md) | reference | GTM hotfix procedure (uses `scripts/verify-analytics-count.mjs`) |

## Cleanup & audits

Trust chain for cleanup work: **`cleaning-instructions.md` is authoritative**;
`pony-audit.md` is reference (mind its CATALOG_SOURCE retraction);
`archive/CODE_CLEANING_PLAN.md` is superseded.

| Doc | Status | What it is |
|---|---|---|
| [`cleaning-instructions.md`](cleaning-instructions.md) | active | Actionable cleanup tasks + agent rules (read before cleanup work) |
| [`pony-audit.md`](pony-audit.md) | reference | Over-engineering audit feeding the above |
| [`github-actions-audit.md`](github-actions-audit.md) | reference | 2026-07-23 CI audit + operator checklist |
| [`audits/`](audits/) | reference | Domain audits (analytics, event system, …) — incl. `backend-audit-2026-08-12.md` (the Aug-2026 backend audit) + its `-verification.md` live-gate log, and `2026-09-11-production-launch-audit.md` (pre-launch audit: 7 fixes shipped, 3 operator launch checks open) |
| [`audit-ceramics-prints-separation.md`](audit-ceramics-prints-separation.md) | reference | Ceramics/prints separation audit |
| [`superpowers/plans/2026-08-12-remediation-00-master-index.md`](superpowers/plans/2026-08-12-remediation-00-master-index.md) | active | Backend-audit remediation master index (14 plans, execution order, live-gate status — the entry point for the Aug-2026 audit follow-up work) |

## Plans & specs

| Location | Status | What it is |
|---|---|---|
| [`plans/2026-09-09-cms-rebuild-repository-fit.md`](plans/2026-09-09-cms-rebuild-repository-fit.md) | reference | Proposed CMS rebuild fitted to the actual repository: catalog ownership, new workflows/UI, retained integrations, migration stages and acceptance criteria |
| [`plans/`](plans/) | active | Feature plans (customer accounts, print pipeline, private sale, …) |
| [`superpowers/plans/`](superpowers/plans/) | active | Dated implementation plans |
| [`superpowers/specs/`](superpowers/specs/) | active | Dated design specs |
| [`superpowers/summaries/`](superpowers/summaries/) | reference | Executive summaries |

## Archive

[`archive/`](archive/) — superseded/historical material, kept for rationale.
Every file carries a banner naming what superseded it. Facts inside may be
false today; never act on them without verifying against the code. Contents
include the 2026-07-07 code-cleaning plan, the Prodigi build-time master
prompt/phases/decisions (June 2026), the Stripe stage-one audit, and generic
CSS scroll-animation guides from the storefront-upgrade exploration.
