# S1 handoff: CMS API delivered from the ceramics-drop side

Per the S1 brief's Definition of Done (§9) and the parent plan's step-1 delivery
list (§4): what this plan shipped, and what still needs a human or the CMS
repo's own follow-through.

## Delivered (this repo, this plan)

1. **Canonical contract** — `contracts/cms-v1.json` (OpenAPI 3.1, `1.0.0`,
   corrected against the real data model — see the diffs from the draft
   documented inline in Task 1 of `docs/superpowers/plans/2026-09-12-cms-api-s1.md`)
   + fixtures for every S1 operation in `contracts/fixtures/`.
2. **Migrations** — `supabase/migrations/20260912120000_cms_api_products.sql`
   and `20260912130000_cms_api_proof_decision.sql`, both additive, both with
   pgTAP coverage (`supabase/tests/cms_api_products.sql`,
   `supabase/tests/cms_api_proof_decision.sql`).
3. **Data model description** — `docs/cms-api-data-model.md`.
4. **API implementation** — `src/server/cms-api/**`, wired into `worker.ts`
   as the `CmsApi` named entrypoint. Every S1 operation from the brief's
   Aneks A table is implemented; every S2/S3/S4-tagged operation 404s
   `NOT_IMPLEMENTED` by design (the router's fallback, not a stub per path).
5. **Test results** — unit tests for every handler/module under
   `src/server/cms-api/` (run `npx vitest run src/server/cms-api/` for the
   current count), pgTAP tests for every new RPC (`supabase test db`), and
   these exact negative scenarios from brief §8, proven across two layers:
   the real-JWT integration suite (`request-handler.test.ts`) for
   auth/routing —
   - missing token → 401
   - expired token → 401
   - forged signature → 401
   - wrong audience (right team, wrong app) → 403
   - wrong issuer → 403
   - valid token, email outside `CMS_OWNERS` → 403
   - missing `Idempotency-Key` on `POST /v1/products` → 422
   - an S2/S3/S4 path → 404 `NOT_IMPLEMENTED`

   — and the colocated handler-level unit tests (`handlers/*.test.ts`) for
   the write-path business rules each handler enforces —
   - stale `expectedRevision` on a write → 409 `REVISION_CONFLICT` with `currentRevision` (products/publication/proofs handlers)
   - a repeated `Idempotency-Key` with a different body → 422 `IDEMPOTENCY_KEY_REUSE` (products/publication handlers)
   - a print publish attempt with an incomplete proof set → 422 `PRINT_ASSETS_INCOMPLETE` (publication handler)
   - an availability change against an actively reserved or online-sold piece → 409 `RESERVATION_ACTIVE` (availability handler)

## Not delivered by this plan — needs a human or the CMS repo

- **A deployed integration environment.** `docs/cms-api-integration-environment.md`
  is the provisioning runbook; nobody has run it yet. Nothing in this plan
  creates cloud resources or spends money.
- **A literal Cloudflare Service Binding + Workers-runtime test.** This
  plan's integration suite exercises the real JWT-verification and
  request-handling logic under Node/Vitest (see Task 12's design note in
  the plan) but not the actual RPC hop through a deployed Service Binding —
  that needs either `@cloudflare/vitest-pool-workers` (not currently a
  dependency of this repo) or a live two-Worker deployment to test against.
- **`contractVersion` mismatch handling** is entirely the CMS side's
  responsibility per the brief (§3, §5.9) — this repo only needs to report
  its own correct version via `GET /v1/capabilities`, which it does.
- **Handing the canonical contract to `cms-ceramics`.** Per this plan's
  Global Constraints, nothing here writes into the sibling repo — copying
  `contracts/cms-v1.json` + `contracts/fixtures/` into `cms-ceramics` and
  regenerating its client is the CMS side's own step once this PR merges.
