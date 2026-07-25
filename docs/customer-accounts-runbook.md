# Customer Accounts — Operator Runbook

Operational procedures for the customer-accounts feature (Google/Apple sign-in, order history, tracking). Design and rationale live in [`docs/plans/customer-accounts.md`](./plans/customer-accounts.md); this file is the *how-to* for the studio + developer.

**Status (2026-07-25):** Google sign-in is live and verified end-to-end in production. JWT signing keys were already migrated to asymmetric (ECC P-256) prior to this pass. Apple sign-in is not yet configured — pending the Apple Developer Program membership decision (§1.3).

**Feature flag / kill switch:** the presence of the `SUPABASE_PUBLISHABLE_KEY` runtime secret. (Strictly, the gate requires `SUPABASE_URL` **and** the publishable key — but `SUPABASE_URL` is a standing prerequisite the store cannot run without, so the publishable key is the only lever you ever operate.) Unset ⇒ `/api/auth/*` return 404, `/konto` renders "accounts unavailable", middleware and checkout skip all session work, existing sessions degrade to signed-out. Checkout and the storefront never depend on auth availability.

```bash
# enable (prod)
wrangler secret put SUPABASE_PUBLISHABLE_KEY
# kill switch
wrangler secret delete SUPABASE_PUBLISHABLE_KEY
```

Locally: set `SUPABASE_PUBLISHABLE_KEY=` in `.dev.vars`.

---

## 1. Phase-0 provider setup (one-time, owner + dev)

### 1.1 Supabase dashboard

1. **Asymmetric JWT signing keys** — Dashboard → Project Settings → JWT Keys → migrate to asymmetric signing keys (zero-downtime dashboard action). This exposes `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`, which the app verifies tokens against locally (`src/lib/auth/session.ts`). *If the project is still on the legacy symmetric secret, local verification fails and every visitor reads as signed-out — this step is mandatory.* ✅ Done (confirmed already on asymmetric ECC (P-256) as of 2026-07-25).
2. **URL configuration** — Auth → URL Configuration:
   - Site URL: `https://anna-ciok.studio`
   - Redirect allowlist: `https://anna-ciok.studio/api/auth/callback`, `http://localhost:3000/api/auth/callback` (+ any staging origin's `/api/auth/callback`).
   ✅ Done 2026-07-25 (pushed via `supabase config push --project-ref wnlysejenowymjdxlnaq`, which also carries `[auth.external.*]` — see §1.2/§1.3 for how provider secrets are wired into the same push).
3. **Providers** — enable Google and Apple with the credentials below. Leave the email provider un-surfaced (the UI is OAuth-only). ✅ Google done and verified in production 2026-07-25. Apple still pending.

### 1.2 Google OAuth client ✅ done 2026-07-25

Uses GCP project `anna-ciok-studio-analytics` (the existing analytics project, per plan §13.2 — no dedicated project was created). `supabase/config.toml`'s `[auth.external.google]` references the client id/secret via `env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID)` / `env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)` — these were exported in-shell for the initial `config push` but are **not yet persisted** to a gitignored `.env`. Before the next `supabase config push` for any reason (e.g. wiring up Apple), re-export both or add them to the repo-root `.env` first, or the push will fail to resolve them and can silently disable the provider.

Google Cloud Console (decide which GCP project owns this — §13.2 of the plan):

1. OAuth consent screen: External; app name "Anna Ciok Ceramics"; support email; authorized domains `anna-ciok.studio` and `supabase.co`. Scopes stay non-sensitive (`openid email profile`) — no verification review needed; start logo-less to avoid triggering one.
2. Credentials → Create OAuth Client ID → Web application → authorized redirect URI **`https://<ref>.supabase.co/auth/v1/callback`** (Supabase's callback, not ours).
3. Paste client id + secret into Supabase → Auth → Providers → Google.

### 1.3 Apple Sign-In (requires active Apple Developer Program membership, $99/yr)

1. Certificates, Identifiers & Profiles → Identifiers → App ID (primary), then a **Services ID** (e.g. `studio.anna-ciok.web`) with "Sign in with Apple" enabled — the Services ID is the OAuth `client_id`.
2. Configure the Services ID: domain `<ref>.supabase.co`, return URL `https://<ref>.supabase.co/auth/v1/callback`.
3. Keys → create a "Sign in with Apple" key, download the `.p8` **once** and store it offline (password manager / offline vault — it cannot be re-downloaded).
4. Generate the client secret (ES256 JWT, max 6 months):

   ```bash
   npm run apple:client-secret -- \
     --key ./AuthKey_<KEYID>.p8 --key-id <KEYID> \
     --team-id <TEAMID> --services-id studio.anna-ciok.web
   ```

5. Paste the JWT into Supabase → Auth → Providers → Apple (client id = the Services ID).

### 1.4 Apple secret rotation (every ~5 months) ⚠️

The Apple client secret **expires after at most 6 months**; when it lapses, *only* Apple login breaks — silently (users land on `/konto?auth_error=1`; watch Sentry for a spike). Runbook:

1. Calendar reminder at **5 months** (owner decision §13.8 says who receives it).
2. Re-run the `npm run apple:client-secret` command above with the same `.p8`.
3. Paste the fresh JWT into the Supabase Apple provider. No deploy needed.

---

## 2. Rollout / dark-launch checklist (plan §10)

1. **Phase 0**: provider consoles + Supabase config above; resolve the plan's §13 open decisions.
2. Ship the migrations (dark — the columns are unused until auth goes live).
3. Ship the code **with the secret unset**: `/api/auth/*` 404, `/konto` renders "unavailable" (the `@ci` E2E suite pins this contract), storefront provably unaffected. Note: the header/nav `Konto` entry ships with the code and is visible while dark — it points at the calm "unavailable" notice (accepted trade-off; the alternative, an env-conditional header, would break the prerendered Polish tree).
4. Set `SUPABASE_PUBLISHABLE_KEY` on a **preview/staging** deployment (its `SUPABASE_URL` must point at a project with the providers configured) and walk the manual round-trip checklist (§3 below) for Google **and** Apple. All "unadvertised" verification happens here — production has no quiet stage.
5. `wrangler secret put SUPABASE_PUBLISHABLE_KEY` in production → **this is the public launch**: the nav entry is already live, so the moment the secret is set the sign-in flow is publicly discoverable. Enable only after the preview checklist is fully green, then immediately smoke-test production with a real account.
6. Kill switch at every step: delete the secret (sessions degrade to signed-out; checkout unaffected; the nav entry reverts to the "unavailable" notice).

## 3. Manual OAuth round-trip checklist (per environment)

Real-provider OAuth is verified by hand (the honest cost of OAuth E2E). For each of Google and Apple:

- [ ] Fresh signup: provider consent → lands on `/konto` signed-in, name/email shown.
- [ ] Repeat login: no duplicate user (Supabase dashboard → Auth → Users).
- [ ] Cross-provider linking: sign in via Google, sign out, sign in via Apple **with the same verified email** → one user, one order history.
- [ ] Backfill: place a guest order with the account's email while signed out → log in → the order appears in `/konto`.
- [ ] Checkout association: place an order while signed in (any email in the form) → it appears in `/konto` without backfill.
- [ ] Order detail: items, amounts, delivery, tracking block render; a foreign/unknown order id 404s.
- [ ] Sign-out: immediate for the browser; `/konto` shows the sign-in panel again.
- [ ] Apple private relay: sign up with "Hide My Email" → checkout while signed in still associates (relay addresses can never be email-backfilled — expected residual limitation).
- [ ] `?auth_error=1` path: cancel on the provider screen → calm error note on `/konto`, no cookies minted.

## 4. Account deletion (v1: owner-handled on request)

Deletion is an **unlink, not an erasure** — order rows survive as guest-like rows under accounting/legal retention duties; `orders.email`-PII erasure remains the existing separate order-PII process.

1. Find the user id: Supabase Dashboard → Auth → Users (search by email) — or SQL: `select id from auth.users where email = lower('<email>');`
2. **Unlink first** (SQL editor, service role):

   ```sql
   update orders
   set user_id = null, user_unlinked_at = now()
   where user_id = '<user-uuid>';
   ```

3. Then delete the user in Dashboard → Auth → Users (the FK's `ON DELETE SET NULL` is only a backstop if step 2 was skipped — but step 2's `user_unlinked_at` stamp is what permanently excludes those orders from backfill-on-login, so never skip it).
4. Reply to the customer confirming deletion; note that order records are retained for accounting purposes as with any guest purchase.

The `user_unlinked_at IS NULL` guard in the backfill means a later login with the same address (the returning person or a future owner of a recycled mailbox) can never silently re-claim the deleted account's order history.

## 5. Troubleshooting

| Symptom | Check |
|---|---|
| Everyone reads as signed-out, logins "succeed" then bounce | Supabase project still on the legacy symmetric JWT secret? Migrate to asymmetric signing keys (§1.1.1) — local jose verification needs the JWKS endpoint. |
| Apple login broken, Google fine | Expired Apple client secret (§1.4). Also check the Services ID return URL still points at `https://<ref>.supabase.co/auth/v1/callback`. |
| Login lands on `/konto?auth_error=1` | Provider error or code exchange failed. Check the redirect allowlist (§1.1.2) — a `redirectTo` not on the allowlist silently falls back to the Site URL. Sentry logs `auth callback: code exchange failed`. |
| Guest orders not appearing after login | Backfill only links provider-**verified** emails, only rows with `user_id IS NULL AND user_unlinked_at IS NULL`, and matches `lower(email)`. Apple private-relay addresses never match typed checkout emails (expected). |
| Sessions drop unexpectedly | Cookie writes must go through the pinned adapter (`src/lib/auth/supabase-server.ts`) — any new auth surface must forward `setCookies` onto its response, or refreshes are silently lost. |
| Print order shows no tracking | `prodigi_orders.tracking_number` persists from the callback; replay the Prodigi callback or `npm run prodigi -- order get <id>` to inspect. Non-`https://` tracking URLs are stored as NULL by design (number still shows as text). |

## 6. Related surfaces

- `/konto`, `/konto/zamowienia/[id]` — `src/app/[locale]/konto/`
- Auth routes — `src/app/api/auth/{login,callback,signout}/route.ts`
- Session/verification — `src/lib/auth/`; account reads — `src/lib/account/`
- Middleware refresh — the `KONTO_RE` block in `src/middleware.ts`
- Checkout association — `POST /api/checkout` (`user_id`, best-effort)
- Print tracking persistence — `src/server/prodigi/callbacks.ts` + migration `20260723120100`
