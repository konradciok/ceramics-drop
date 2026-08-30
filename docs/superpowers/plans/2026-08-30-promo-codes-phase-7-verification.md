# Promo Codes — Phase 7: Verification, docs & final report

> **For agentic workers:** Part of `2026-08-30-promo-codes-master.md`. Runs after Phases 1–6 are individually green. This is the integration gate: nothing is "done" on code inspection alone — every claim below must be backed by actual command output from this run. Worktree `feat/promo-codes`.

**Goal:** Full verification matrix executed and its real output inspected; operator/developer documentation written; a final report that separates verified results from environment-blocked items; branch ready for PR.

**Files:**
- Create: `docs/promo-codes.md` (operator runbook + technical reference)
- Modify: `AGENTS.md` (API error additions, DB schema section, admin section, scripts table untouched)
- Modify: `docs/STATUS.md` (feature-state entry with last-verified date)
- Modify: `docs/README.md` (index the new doc)

---

## Task 1: Verification matrix

Run each check and **read the output**. Record pass/fail + evidence (test counts, spec names) in the final report.

- [ ] **Step 1:** `npm run lint` — clean (delete `playwright-report/` first, Windows gotcha).
- [ ] **Step 2:** `npm run typecheck` — clean (app + worker tsconfig).
- [ ] **Step 3:** `npm run test` — full vitest suite. Compare failures against the `main` baseline recorded at setup (4 known Windows-local failures may exist; anything new is yours).
- [ ] **Step 4:** Hermetic e2e: `npx playwright test --grep @ci` against a manual serve on :3210 with `PLAYWRIGHT_BASE_URL` set. Must include `promo-code.spec.ts`, `mixed-cart.spec.ts`, `analytics-funnel.spec.ts`, `checkout-409.spec.ts` — all green.
- [ ] **Step 5:** Build gate: `npm run build` (webpack, postbuild manifest guard). Then, if the environment allows, `npm run preview:cf` and load `/koszyk` + `/admin/promotions` on the Workers runtime (`STUDIO_ADMIN_LOCAL_BYPASS`). If preview can't run here, mark environment-blocked.
- [ ] **Step 6:** Cross-phase consistency greps (cheap tripwires):
  - `grep -rn "promo" src/ --include="*.ts*" -l` — every file listed is one a phase claimed; no stray debug code.
  - Search for any remaining `amount - subtotalMinor` shipping derivation in the checkout route (must be gone — Phase 2).
  - Confirm no `unstable_cache` wraps any promo read.
  - Confirm `messages/{pl,en,es,de}.json` all contain the full `cart.promo` key set (run `npm run i18n:check` if applicable).
- [ ] **Step 7:** Migration re-review against the auto-apply-to-prod constraint: additive-only, defaults present, no lock-heavy operation on `orders` (column adds with constant defaults are safe on PG ≥ 11 — confirm the `discount ... not null default 0` add is metadata-only).
- [ ] **Step 8: Commit** any fixes surfaced, then `git commit -m "test(promo): verification sweep fixes"` (skip if clean).

### Environment-blocked (list verbatim in the report if not run)
- Real Stripe test-mode purchase with a promo (`@destructive` e2e or `npm run test:e2e:edge`) — needs operator-approved environment; the discounted `amount` at Stripe is otherwise verified only by unit tests.
- Live webhook settlement (`markPaid` → `settle_promo_redemption`) against real Stripe deliveries.
- Admin create/toggle against a real database (local env points at **prod** Supabase — mutations were verified via unit tests + UI smoke only).
- Real welcome-email delivery via Resend.
- GA4 DebugView confirmation of `coupon` on live events.
- The prod migration apply (happens automatically on merge).

## Task 2: Documentation

- [ ] **Step 1: Write `docs/promo-codes.md`** with two audiences:
  - *Operator runbook:* creating a promotion at `/admin/promotions` (field-by-field: kind, per-currency amounts in major units, applies_to and what "track" means, window, max redemptions, newsletter flag and its one-active rule); activating/deactivating (instant for new checkouts; an in-flight checkout with a just-deactivated code fails with a clear message and the customer retries without it); reading the stats columns (pending = claimed by an unfinished checkout, released = never paid, redeemed = paid; refunds stay counted); the newsletter welcome-email behavior and the stateless re-confirm re-send edge (Phase 5).
  - *Technical reference:* ownership model (Supabase-owned, Stripe PI amount + metadata only — with the Stripe docs links from the master), discount semantics + clamps, redemption lifecycle diagram (pending → redeemed/released), error codes, analytics event contract (copy Phase 6's block verbatim), the "new silter"→newsletter interpretation and its confirmation status.
- [ ] **Step 2: Update `AGENTS.md`:** add `promo_codes`/`promo_redemptions` + the two RPCs to the Database Schema section; add the new error codes (400 `invalid_promo`, 409 `promo_exhausted`) to the API-error-responses convention paragraph; one line under Admin for `/admin/promotions`; one line in Other API Routes for `/api/promo/validate`. Keep edits minimal and in the file's voice.
- [ ] **Step 3: Update `docs/STATUS.md`** (feature shipped-to-branch state, verified date, the operator-confirmation open item) and add `docs/promo-codes.md` to `docs/README.md` with an `active` tag.
- [ ] **Step 4: Commit** — `git commit -m "docs(promo): operator runbook, AGENTS.md schema/API updates, status entry"`

## Task 3: Final report (deliver to the user, not a repo file)

- [ ] **Step 1:** Compose the final response per the master's success criteria, leading with implemented/verified status, then:
  - architecture + source-of-truth decision (one paragraph, with the Stripe PaymentIntents limitation and doc links);
  - what changed per layer (checkout server/UI, admin, DB, webhook/cron, Resend, analytics) — file-level, not line-level;
  - verification actually performed with real results (counts, spec names), and the environment-blocked list verbatim;
  - unresolved items: the "new silter" interpretation awaiting operator confirmation; first live discounted refund to watch; `@destructive` Stripe run pending;
  - required operator/deployment steps: confirm interpretation → create first promo in admin → (optional) flag newsletter promo; merge auto-applies the migration to prod before the worker deploy (safe because code tolerates the columns' absence until deployed — verify this claim: the OLD worker never selects the new columns, and the NEW worker requires them, so migration-first ordering is exactly right).
- [ ] **Step 2:** Do NOT push or open a PR unless the user has authorized it; otherwise end with the branch name, commit count, and the suggested PR title `feat: promo codes across both checkout tracks`.

## Acceptance checklist (phase self-review)

- [ ] Every "verified" claim in the report maps to command output produced in this run.
- [ ] Docs accurately describe what was built (re-read `docs/promo-codes.md` against the final diff, not against the plan).
- [ ] No production/external side effects occurred across all phases (audit the shell history for stray `wrangler`, `supabase`, Resend, or Stripe live calls).
- [ ] Worktree clean, all commits conventional, no `.next` symlink or `playwright-report/` staged.
