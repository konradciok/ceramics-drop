# Analytics remediation plans — index & execution order (2026-07-28)

Six per-domain implementation plans addressing every actionable finding in `docs/audits/analytics-architecture-audit-2026-07-28.md`. Each is a standalone, independently-shippable PR (per the repo's per-domain stacked-PR convention). Findings are `N-*` (this audit) and `F-*` (prior `event-system-audit.md`).

| # | Plan | Severity | Findings | Tasks | Touches |
|---|---|---|---|---|---|
| 1 | [`…-analytics-privacy-token-redaction`](2026-07-28-analytics-privacy-token-redaction.md) | **Critical (Phase 0)** | N-1 | 6 | `koszyk`/PDP/`return` client, new `use-strip-url-token.ts`, `scripts/gtm-api.mjs` (GA4 base), new `e2e/analytics-token-leak.spec.ts`, GTM **v14** |
| 2 | [`…-analytics-prints-parity`](2026-07-28-analytics-prints-parity.md) | High | N-2, F-07 | 6 | `feed.ts` + feed routes, `analytics.ts` (4 print builders), `PrintProductScreen`/`PrintCollectionScreen`/`CartView`/`PrintConfigurator` |
| 3 | [`…-analytics-event-correctness`](2026-07-28-analytics-event-correctness.md) | Medium | N-4, N-5, F-09, N-10, F-25 | 5 | `ga4-mp.ts`/`conversions.ts`, `ProductTile`/`SelectionBar`, `checkout-analytics.ts`/`CartView`, `FooterNewsletterForm` (rename), `stripe/webhook` |
| 4 | [`…-ga4-measurement-hygiene`](2026-07-28-ga4-measurement-hygiene.md) | Medium/Low | N-3, N-8, N-11, N-12, F-22, F-21, F-20 | 5 | GA4 Admin API (custom dims, EM settings), `meta-capi.ts`, `AnalyticsEvents`/`ContactForm`, `docs/analytics-stack.md` |
| 5 | [`…-analytics-identity-testing-governance`](2026-07-28-analytics-identity-testing-governance.md) | Low / Phase 3 | N-6, N-7, F-19, F-16, F-11+N-9, F-18, F-13 | 46 (7 groups) | checkout capture, `auth/callback` + new client island, ESLint, `sentry-options`, `middleware` CSP + new `/api/csp-report`, 2 migrations |
| 6 | [`…-gtm-native-tags-migration`](2026-07-28-gtm-native-tags-migration.md) | Architectural (optional) | F-03, F-04 | 5 | `scripts/gtm-api.mjs` (native `googtag`+`gaawe`), Meta gallery template, GTM **v15** |

## Recommended execution order & dependencies

Only two hard cross-plan dependencies exist; everything else is independent and can ship in parallel PRs.

1. **Plan 1 first** (Critical — a live secret/token leak). It publishes GTM container **v14** with the redacted `page_location`.
2. **Plans 2, 3, 4, 5 in any order / parallel** — no ordering constraints between them. Plan 5 is large (7 loosely-related deliverables, 46 tasks); consider splitting it into stacked PRs by group (G1 identity, G2 auth events, G3 CI guards, G4 Sentry, G5 CSP, G6 webhook ledger, G7 email correlation).
3. **Plan 6 last** — it deletes the Custom-HTML GA4 tags Plan 1 edits, so it **must run after Plan 1** and carries the v14 `page_location` redaction forward into the native tag, publishing **v15**. **Plan 1 must NOT delete `docs/GTM-NPHLG9NR_v13.json`** — it is Plan 6's committed rollback reference. Keep the v13 snapshot in the repo (v13/v14/v15 exports coexist) until Plan 6 lands, even though GTM also retains version 13 server-side.

### Reconciled cross-plan overlaps (already resolved in the plan text)
- **Newsletter event:** Plan 3 (N-10) renames `newsletter_signup` → `newsletter_signup_requested` and **keeps** it; Plan 4 (N-3) does **not** delete it — native `form_submit` reports an empty `form_id` for the footer form, so the named event is the reliable conversion signal. Plan 4 deletes only `scroll_depth` + `contact_form_mailto_open`.
- **Token-leak e2e:** Plan 1 owns the authoritative `e2e/analytics-token-leak.spec.ts` (URL-strip + no token in any dataLayer push or network request). Plan 5 G3a's dataLayer smoke defers to it and should drop the duplicate `?sale=` push assertion once Plan 1 merges.

## Execution

Each plan carries the standard header instructing agentic workers to use `superpowers:subagent-driven-development` (fresh subagent + two-stage review per task) or `superpowers:executing-plans` (inline batch with checkpoints).
