# GitHub Actions audit — 2026-07-23

Scope: every workflow in `.github/workflows/` — is it needed, does it overlap
with another, is it stale? Evidence: workflow sources, `gh` run history,
failure logs, repo secrets/variables listings, and a live probe of the
production signed print-asset route.

## Verdict per workflow

| Workflow | Created | Last success | Verdict |
|---|---|---|---|
| `ci.yml` — lint · typecheck · unit · build | 2026-06-08 | 2026-07-21 | **Keep.** The only quality gate. Healthy; every failure after 07-22 is the billing outage, not code. |
| `e2e.yml` — Playwright `@ci`, hermetic | 2026-06-05 | 2026-07-21 | **Keep.** The only browser-level gate. Healthy. |
| `db.yml` — pgTAP (split out of `ci.yml` by this audit) | 2026-07-23 | n/a | **Keep.** Runs only when `supabase/**` changes. |
| `release-please.yml` | 2026-07-16 | 2026-07-18 | **Keep.** Versioning engine per AGENTS.md § Versioning. Works; recent reds are all billing. v0.9.2 tag/release were created manually after the billing block — state is consistent. |
| `post-deploy-smoke.yml` — daily signed-route HEAD | 2026-07-12 | 2026-07-12 (only the creation-day dispatch) | **Keep — it caught a real problem nobody looked at.** Red every day since 07-13: HTTP 403 on the signed `fap01` URL. Diagnosed 2026-07-23: a local probe with the operator's `PRINT_ASSET_TOKEN_SECRET` returns **200 OK** against production — the Worker and asset are fine; the **GitHub secret copy is stale/wrong**. Refresh it (checklist below). |
| `prodigi-contract-smoke.yml` — manual sandbox contract gate | 2026-07-14 | **never ran** | **Keep, but wire it up.** It is the documented audit-H-1 rollout gate, yet it has zero dispatches and its required secret `PRODIGI_API_KEY_SANDBOX` does not exist in the repo — a dispatch today would fail on the missing key. Either add the secret and dispatch it once, or accept the local `npm run prodigi:contract-smoke` path as the only gate and delete the workflow. Wiring it is the cheaper end state given the pending print rollout. |

**Overlap: none worth removing.** CI and E2E both build the app, but they run
on separate VMs — merging the files would save zero minutes. The two smoke
workflows probe different things (HTTP reachability of the signed route vs the
Prodigi API contract round-trip).

## Systemic findings

1. **Nothing has run since ~2026-07-22 08:00.** Every job dies at start with
   *"recent account payments have failed or your spending limit needs to be
   increased"*. Private repo on the free plan → 2,000 Actions minutes/month;
   the July PR cadence (#147→#178) at ~20–25 min per push/PR-sync (CI verify +
   pgTAP with Docker pulls + Playwright browser download on every run)
   plausibly exhausted it. Until billing is fixed, **prod still deploys on
   every push** — Cloudflare Workers Builds is independent of Actions, so the
   site ships with no CI gate at all.
2. **CI has never blocked a merge.** Branch protection / rulesets are
   unavailable on the free plan for private repos. Actions here are advisory.
   Making the repo public (or GitHub Pro) would enable required checks *and*
   remove the minutes cap.
3. **A red scheduled workflow was ignored for 11 days.** post-deploy-smoke
   failed daily since 07-13 and the signal was lost. After billing is
   restored, watch the first runs — and treat scheduled reds as pages, or add
   a notification step if email alone keeps getting missed.
4. **Action pins had rotted.** `actions/checkout@v4.2.2` and
   `setup-node@v4.1.0` were emitting Node 20 deprecation warnings (runners
   force Node 24). `supabase/setup-cli` floated on a mutable `@v1` tag,
   inconsistent with the repo's pin-to-SHA policy (PR #37). No
   dependabot/renovate existed to keep pins current.

## Fixes applied by this audit (PR)

- Bumped all action pins to current Node-24-native releases, SHA-pinned with
  version comments: checkout v7.0.1, setup-node v7.0.0, upload-artifact
  v7.0.1, cache v6.1.0, supabase/setup-cli v3.0.0 (now SHA-pinned too; v3
  keeps the `version: latest` input and drops the unused `github-token`).
- Split pgTAP into `db.yml` with `paths: supabase/**` — it no longer burns
  ~4 min of quota on every app-only push.
- Added a Playwright browser cache to `e2e.yml` keyed on the installed
  Playwright version (~150 MB download and ~1–2 min saved per warm run).
- Added `paths-ignore: docs/**, **.md` to `ci.yml` and `e2e.yml` — docs-only
  pushes no longer trigger builds. `release-please.yml` deliberately still
  sees every push (it must).
- Added `.github/dependabot.yml` (monthly, grouped `github-actions` updates)
  so the SHA pins stop rotting.
- Removed an invalid `branches: [main]` key under `workflow_dispatch` in
  `post-deploy-smoke.yml` (caught by actionlint; GitHub silently ignored it —
  the job-level default-branch `if` is the real guard).

None of these can be exercised until billing is restored; they are validated
by `actionlint` locally and by the first green run after unblock.

## Operator checklist (account-level, outside the repo)

1. **Fix billing**: GitHub → Settings → Billing & plans — settle the failed
   payment / raise the spending limit. This single action un-bricks all five
   workflows. Consider making the repo public: unlimited minutes + branch
   protection for free.
2. **Refresh the smoke secret**: `gh secret set PRINT_ASSET_TOKEN_SECRET`
   with the current production value (the one in local `.dev.vars` verified
   green on 2026-07-23). Then dispatch post-deploy-smoke once and expect
   green.
3. **Wire the contract gate**: `gh secret set PRODIGI_API_KEY_SANDBOX`, then
   dispatch `prodigi-contract-smoke` once (it has never run).
4. **Flip strict mode** now that fap01 is published:
   `gh variable set PRINT_SMOKE_STRICT --body true` (and
   `PRODIGI_SMOKE_STRICT` once the contract smoke is green).
5. After unblock, watch the first scheduled post-deploy-smoke run and the
   Playwright cache-hit line in the first two E2E runs.
