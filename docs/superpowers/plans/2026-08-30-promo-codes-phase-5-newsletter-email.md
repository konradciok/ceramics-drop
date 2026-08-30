# Promo Codes — Phase 5: Newsletter welcome email ("new silter" resolution)

> **For agentic workers:** Part of `2026-08-30-promo-codes-master.md` — master decisions/constraints binding. Depends on Phase 1 (schema) and Phase 4 (`getActiveNewsletterPromo`, admin flag). Worktree `feat/promo-codes`; commit per green step; self-review loop at the end.

**Interpretation note (binding, but flagged):** The original requirement said a promo code should reach "a new silter … in the inviting email". The repo has zero invite/silter/sitter prior art; the only invitation-like email flow is the **newsletter double opt-in**. This phase therefore implements: *after a subscriber confirms (GET `/api/newsletter/confirm` succeeds), send a localized welcome email containing the promo flagged `newsletter_welcome` in admin — if and only if such an active promo exists.* The operator must confirm this reading before flipping the flag on in production; the code path is inert (exactly today's behavior) while no promo carries the flag. Record the confirmation status in the Phase 7 report.

**Goal:** Best-effort welcome email with the promo code after successful confirmation; zero behavior change when no promo is flagged; no real emails sent during development.

**Files:**
- Modify: `src/lib/newsletter.ts` (welcome email builder + sender)
- Modify: `src/app/api/newsletter/confirm/route.ts` (send after successful subscribe)
- Modify: `src/lib/newsletter.test.ts` (or create if the existing tests live elsewhere — locate the current newsletter tests first and extend in place)

**Interfaces:**
- Consumes: `getActiveNewsletterPromo(supabase)` from `src/lib/promo.ts` (Phase 4); `PromoCode`; email primitives from `src/lib/email-layout.ts` (`resendTemplateHtml`, `emailParagraph`, `emailMutedParagraph`); the existing `postResendJson`/send helper inside `newsletter.ts`; `EMAIL_FROM` from `src/lib/email-addresses.ts`.
- Produces:
```ts
// src/lib/newsletter.ts
export function buildNewsletterWelcomeEmail(params: {
  locale: 'pl' | 'en' | 'es' | 'de'
  promo: { code: string; kind: 'percent' | 'fixed'; percent: number | null;
           // amount_* are RAW STORED MINOR UNITS (grosze / euro-cents / pence) —
           // the builder converts to major units for the copy (5000 → "50 zł").
           amount_pln: number | null; amount_eur: number | null; amount_gbp: number | null }
}): { subject: string; html: string }

export async function sendNewsletterWelcomeEmail(params: {
  apiKey: string; to: string; subject: string; html: string
}): Promise<void>   // same raw-fetch Resend call shape as sendNewsletterConfirmEmail
```

---

## Task 1: Welcome email builder (TDD)

- [ ] **Step 1: Failing tests** — for each of the 4 locales, `buildNewsletterWelcomeEmail` returns a subject and html containing: the promo code verbatim (uppercase, visually prominent — assert the string appears), a human description of the value (percent: "−10%"-style; fixed: one sentence listing all three amounts "50 zł / 12 € / 10 £", since the email doesn't know the reader's display currency — the amounts are stored in MINOR units, so the builder must divide by 100 for the copy; the tests pass raw stored values and assert the major-unit rendering: `amount_pln: 5000` → "50 zł" (never "5000 zł"), `amount_eur: 1200` → "12 €", `amount_gbp: 1000` → "10 £"), and a shop link to `https://anna-ciok.studio` (localized path for non-PL). Follow the copy idiom of `buildNewsletterConfirmEmail`'s inline `I18N_CONFIRM`-style locale map; add `I18N_WELCOME` the same way. Keep issuance/selection OUT of the builder — it receives the promo, pure function (master requirement: selection logic separate from presentation).
- [ ] **Step 2: Implement + run to green.** Reuse `resendTemplateHtml` + paragraph primitives; no new layout machinery.
- [ ] **Step 3: Commit** — `git commit -m "feat(promo): newsletter welcome email builder with promo code (4 locales)"`

## Task 2: Send after confirm

- [ ] **Step 1: Failing tests** on the confirm route (extend the existing confirm-route tests, mocked fetch + Supabase): (a) valid token + subscribe success + an active `newsletter_welcome` promo → welcome email sent to the subscriber with the promo code, and the 302 redirect to `confirmed` still happens; (b) no flagged promo → **no** second email, redirect unchanged (regression); (c) welcome-email send throws / Resend 5xx → error logged, redirect to `confirmed` STILL returned (best-effort — email failure must not break opt-in; mirror how other best-effort sends swallow+log); (d) `getActiveNewsletterPromo` DB error → treated as "no promo", logged, flow unaffected.
- [ ] **Step 2: Implement** in `GET /api/newsletter/confirm`: after `subscribeNewsletterContact` succeeds, `getActiveNewsletterPromo(getSupabaseAdmin())` → if present, build + `sendNewsletterWelcomeEmail` inside try/catch (log via the route's existing logging convention; add a Sentry capture only if the route already imports Sentry — do not introduce it here otherwise). Note: the "already exists" (409) subscribe outcome counts as success today — decide and encode: an already-subscribed re-confirm does **not** get the welcome email if distinguishable; if the current code collapses 409 into success without a flag, keep the simple behavior (send) and note it in the runbook as a known re-send edge (stateless flow, no dedup store — consistent with the feature's stateless design).
- [ ] **Step 3: Run to green. Commit** — `git commit -m "feat(promo): send welcome email with flagged promo after newsletter confirm"`

## Task 3: Rendering check without sending real mail

- [ ] **Step 1:** Add a tiny scratch script OR a vitest snapshot that writes the built HTML for all 4 locales to the session scratchpad (not the repo), open the PL + EN files in a browser, and eyeball layout against an existing confirm-email render. No Resend API calls.
- [ ] **Step 2:** Fix any layout issues; **commit** any builder fixes — `git commit -m "fix(promo): welcome email rendering polish"` (skip if none).

## Acceptance checklist (phase self-review)

- [ ] With no flagged promo, the confirm route's behavior and response are exactly `main`'s (covered by regression test b).
- [ ] Email failure can never break the opt-in redirect; promo lookup failure degrades to "no promo".
- [ ] Builder is pure; selection lives in the route; both are separately tested.
- [ ] Fixed amounts render in MAJOR units in every locale — minor→major conversion covered by tests fed raw stored minor-unit values for all three currencies (5000/1200/1000 → 50 zł / 12 € / 10 £).
- [ ] No real email sent, no Resend config touched, no prod DB writes during this phase.
- [ ] The interpretation note (typo → newsletter) is restated in the code as a short comment above the send block, and carried into the Phase 7 report as an open confirmation item.
- [ ] `npm run lint && npm run typecheck && npm run test` green; adversarial diff re-read done.
