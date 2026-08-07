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
| [`audits/`](audits/) | reference | Domain audits (analytics, event system, …) |
| [`audit-ceramics-prints-separation.md`](audit-ceramics-prints-separation.md) | reference | Ceramics/prints separation audit |

## Plans & specs

| Location | Status | What it is |
|---|---|---|
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
