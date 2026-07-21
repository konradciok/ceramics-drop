# Customer Accounts — Implementation Plan

Google + Apple sign-in, persistent accounts, order history, and per-order shipment tracking, integrated with the existing (anonymous) checkout — designed for minimal effort and maximum reuse of what this repository already has.

> Status: **design/plan only — no implementation yet.** Written 2026-07-21 from a full repository audit (three exploration passes over infra/middleware, DB schema/order lifecycle, and checkout/Prodigi, plus an adversarial design review; all line references verified against `main` @ `a82397c`).

---

## 1. Repository analysis

### 1.1 Application architecture

- **Next.js 16 App Router** (webpack build — Turbopack is forbidden, see `AGENTS.md`), deployed to **Cloudflare Workers via OpenNext** (`@opennextjs/cloudflare`). A custom `worker.ts` wraps the OpenNext handler and adds: the Cloudflare Access gate for `/admin`, a 15-minute cron (abandoned-order sweep, stuck-job alerts), and the Prodigi queue consumer. It must keep re-exporting `DOQueueHandler`, `DOShardedTagCache`, `BucketCachePurge`.
- **`src/middleware.ts`** (edge runtime; must never become `proxy.ts`) composes next-intl routing, security headers (CSP is Report-Only; `connect-src` already allows `https://*.supabase.co`), and `currency_pref` cookie seeding from `CF-IPCountry`. It appends **`Vary: Cookie` to every storefront response** (`src/middleware.ts:98`) and its matcher **excludes `api|admin|_next|…`** (`src/middleware.ts:107`) — so `/api/auth/*` would bypass it while a `/konto` page goes through it.
- **Rendering/caching:** PDP, collection, `sklep`, `showroom`, cart, admin, and API routes are all `force-dynamic`; data caching is `unstable_cache` tags (`catalog`, `inventory`). `open-next.config.ts` sets `enableCacheInterception: true`. Crucially, `getCurrency()` (`src/lib/currency.server.ts:14`) returns early for `locale === 'pl'` **before** touching `cookies()` — so parts of the Polish (default-locale) tree can prerender. Anything that reads a session cookie in the shared layout or `Header` would flip that tree dynamic. This constraint shapes the header design below.
- **Data access:** Supabase Postgres via `@supabase/supabase-js` with the **service-role key only** (`src/lib/supabase.ts` — `supabaseFromEnv(env)` / `getSupabaseAdmin()` via `getCloudflareContext().env`). There is **no anon/publishable key anywhere, no browser-side Supabase**, and **RLS is enabled on all 19 tables with zero policies** (deny-all; service role bypasses).
- **i18n:** 4 locales (`pl` default unprefixed, `en`, `es`, `de`), `localePrefix: 'as-needed'`, **no `pathnames` map** — one route folder (e.g. `/koszyk`) serves all locales. UI strings live as top-level namespaces in `messages/{pl,en,es,de}.json`, with a shape-parity test (`src/i18n/messages.test.ts`).
- **Cart:** Zustand in `localStorage` (`acc_cart_v1`); print delivery draft in `sessionStorage` (`acc_print_delivery_v1`); checkout attempt id in `localStorage` (`acc_checkout_attempt_v1`).

### 1.2 Existing authentication

**There is no customer authentication of any kind.** The only auth in the app is the **staff-only** Cloudflare Access JWT gate for `/admin`, verified in `src/lib/admin/access.ts` with `jose` (`createRemoteJWKSet` cached at module level + `jwtVerify` with issuer/audience checks, fail-closed 404). `jose ^6.2.3` is already a dependency. No `next-auth`/`@auth/*`, `lucia`, `clerk`, or `@supabase/ssr` is installed. Supabase Auth is scaffolded in `supabase/config.toml` (`[auth] enabled = true`, refresh-token rotation on, an `[auth.external.apple]` block present but disabled) and **entirely unused**. Grep for `user_id|customer_id|auth.users|auth.uid` across all SQL/TS: zero matches.

### 1.3 Database structure (relevant subset)

- **`orders`** — flat contact columns, **no user identity**: `id uuid PK` (doubles as ShipX `reference` and Prodigi `merchantReference`; there is no human order number), `payment_intent_id UNIQUE`, `status (pending|paid|failed|expired|refunded)`, `currency (pln|eur|gbp|usd|cad)`, minor-unit totals, `email` (nullable), `receiver_first_name/last_name/phone`, `shipping_address jsonb` (ShipX `{street, building_number,…}` or print `{line1, line2,…}` shape), `delivery_method (paczkomat|kurier|odbior)`, `fulfilment_type (inpost|prodigi|pickup)`, `locale`, `marketing jsonb`, InPost columns (`inpost_shipment_id`, **`inpost_tracking_number`**, **`delivery_status`**, `inpost_target_point`, dispatch/return/label columns), email-idempotency claims (`confirmation_email_sent_at`, `studio_email_sent_at`, `customer_notified_at`), `private_sale_id`.
- **`order_items`** — `order_id FK`, `product_id`, `unit_price`, **`variant jsonb`** (`NULL` = ceramic; print snapshot with `prodigiSku`, `size/framed/mount/frameColour`, pinned `assetId/assetKey/assetSha256`, `printAreaPx`).
- **`fulfilment_jobs`** — Prodigi queue state: `status` (`queued → fulfilment_submitting → fulfilment_submitted → in_production → shipped`; terminal: `completed|shipped|cancelled|failed_action_required`), `idempotency_key UNIQUE`, one active job per order (partial unique index).
- **`prodigi_orders`** — `prodigi_order_id UNIQUE`, `prodigi_status_stage` (`InProgress|InProduction|Complete|Cancelled|Unknown`), **`prodigi_raw_json`** (full re-fetched Prodigi order, including `shipments[].carrier.name` / `tracking.number` / `tracking.url`), `shipping_email_sent_at`, `cancel_alerted_at`. **No dedicated tracking columns** — see §1.5.
- Others: `piece_state` (one-of-a-kind ceramic inventory + showroom flags), `private_sales`, `webhook_events` (provider event dedup with lease), `pod_variants`, CMS + catalog-shadow tables, `print_fulfilment_assets`. 39 migrations, timestamp-prefix convention, pgTAP tests for critical RPCs.

### 1.4 Checkout flow (current)

`POST /api/checkout` (`src/app/api/checkout/route.ts`, force-dynamic): rate-limit by IP → parse body → clamp locale → **currency from the `currency_pref` cookie header** → `validateCart` (print tokens + ceramics; mixed carts rejected) → delivery validation (`validateDelivery` for InPost / `validatePrintDelivery` for prints) → `reserve_pieces()` RPC (ceramics only; 15-min TTL) → Stripe PaymentIntent (idempotency key `pi_create_${orderId}`; the client-generated `attemptId` **becomes `orders.id`**) → `orders` insert (`route.ts:331–353` — the only cookies read in the route today are currency + consent) → `order_items` insert → `{client_secret}`. Replay/conflict semantics ride on the PK violation (`23505`) with careful hold-release. Client side: `CartView.tsx` (inline ceramic contact fields; `PrintDeliveryForm` for prints) → Stripe PaymentElement → `/koszyk/return` (client component; `retrievePaymentIntent` once; success/processing/fail; no order id shown, no order-status page exists). The nearest thing to an order lookup is the returns flow (`/zwrot?order=<uuid>` → `/api/returns`), which documents the house pattern: *order UUID as capability token, 404 for unknown/ineligible, rate-limited against enumeration*.

### 1.5 Prodigi integration (current)

Stripe webhook `payment_intent.succeeded` → `markPaid` → `createShipment`: print orders call `enqueueProdigi()` (upserts `fulfilment_jobs`, sends `{orderId, jobId}` to the `prodigi-fulfilment` Cloudflare Queue) → `process-job.ts` (claims job, requires `status='paid'`, re-verifies pinned print assets fail-closed, `postOrder` with 409 recovery) → **`prodigi_orders` upsert**. Prodigi calls back to `/api/webhooks/prodigi/[token]` (timing-safe token check) → `handleProdigiCallback` (`src/server/prodigi/callbacks.ts`): dedup via `webhook_events` (5-min lease) → **re-fetches the full order from Prodigi** (never trusts the payload) → upserts `prodigi_orders {prodigi_status_stage, prodigi_raw_json}` (`callbacks.ts:136–139`) → advances the latest non-terminal `fulfilment_jobs` row (`status-map.ts`: `InProgress→fulfilment_submitted`, `InProduction→in_production`, `Complete→shipped`, `Cancelled→cancelled`) → on `shipped`, sends the customer tracking email exactly once (claim on `shipping_email_sent_at`), extracting carrier/tracking **in memory only** (`callbacks.ts:215–223`). **Tracking is emailed but never persisted to a queryable column — not even the admin UI can show it.** The only per-order fulfilment read is the fail-closed debug route `/api/debug/fulfilment-status`.

### 1.6 Order lifecycle (current)

`pending` (checkout) → `paid` (webhook CAS; pieces → `sold`; confirmation + studio emails via claim columns; conversions; invoice) → fulfilment per `fulfilment_type` (InPost columns on `orders` / Prodigi tables) → shipping email (both paths exist today). Failure paths: `failed` (payment failed / persist error), `expired` (cron: pending > 1 h → cancel PI → release), `refunded` (full refund or lost dispute → `releaseSale`; prints attempt Prodigi cancel). Ceramic tracking is queryable (`orders.delivery_status`, `inpost_tracking_number`, mirrored by `/api/inpost/webhook`); print tracking is not (raw JSON only). "Customers" exist only as an admin-side grouping of orders by email (`src/lib/admin/data.ts` → `listCustomers`).

**Implication:** accounts are greenfield. The identity anchors that exist are `orders.email` and the order UUID. Everything the dashboard needs (items, totals, addresses, ceramic tracking, print status) is already persisted except print tracking columns — so the work is: authentication, one `orders.user_id` column, four `prodigi_orders` columns, and a read UI.

---

## 2. Recommended authentication solution

### 2.1 Recommendation: Supabase Auth, integrated **server-only**

Use **Supabase Auth** (the auth service of the Supabase project the store already runs on) with Google and Apple as OAuth providers, integrated in a deliberately server-only shape:

- New dependency: **`@supabase/ssr` only**. No browser Supabase client, ever.
- Sessions live in **httpOnly, Secure, SameSite=Lax cookies** written exclusively by route handlers/middleware (our cookie adapter overrides the library's non-httpOnly default — safe precisely because no browser client needs to read them).
- The publishable/anon key is a **runtime secret** (`SUPABASE_PUBLISHABLE_KEY` via `wrangler secret put` / `.dev.vars`), *not* `NEXT_PUBLIC_*` — it never ships in the client bundle, preserving the repo's "no Supabase keys in the browser" property.
- Server code **verifies the access-token JWT locally with `jose`** against the project's JWKS (`https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`, after enabling asymmetric JWT signing keys) — a near-copy of the existing `src/lib/admin/access.ts` pattern, including the module-level JWKS cache. Network round-trips to Supabase Auth happen only on login, logout, and token refresh (~once per hour per active signed-in user).
- **RLS stays deny-all with zero policies.** Account pages read orders through the existing service-role client, filtered by the JWT-verified `user_id` server-side — exactly how every other read path in the repo works. Supabase Auth is used as an *identity provider + user store*, not as a client-side data-access layer.

### 2.2 Why this fits this repository best

1. **The user store lands in the database that already holds the orders.** `auth.users` lives in the same Postgres as `orders`, so linking is one nullable FK column, backfill is one UPDATE, and admin user management comes free in the Supabase dashboard the studio already uses. Every alternative puts users somewhere else (a new table we own, or a third-party SaaS) and makes the order link a distributed-consistency problem.
2. **The hard OAuth problems are absorbed by infrastructure the project already pays for.** State/nonce/PKCE, Google's token exchange, and — most importantly — **Apple's `form_post` response mode** are handled at Supabase's `/auth/v1/callback`. Apple POSTs cross-site to Supabase; our `/api/auth/callback` then receives a clean top-level GET with `?code=`, so SameSite=Lax httpOnly cookies flow correctly with zero special-casing. Same-verified-email sign-ins via Google *and* Apple are automatically linked to one user (with Supabase's protection of discarding unconfirmed identities).
3. **It matches, rather than fights, the repo's invariants**: service-role-only data access, jose/JWKS verification, fail-closed secret-gated features, no client-side secrets, edge-safe fetch-based SDKs already running inside this exact Worker bundle.
4. **Minimal new code.** Three small route handlers, one session lib, ~35 guarded lines in the existing middleware, two migrations, two pages.

### 2.3 Alternatives considered

| Option | Why not |
|---|---|
| **Standard `@supabase/ssr`** (browser client + `NEXT_PUBLIC` anon key + RLS policies) | The documented default, but it violates two deliberate repo invariants (anon key in the client bundle; RLS policies as a second authorization surface over 19 currently deny-all tables) for zero functional gain — there is no client-side data need: the cart is Zustand, account pages are server components. |
| **Hand-rolled OAuth with `jose`** (repo already has the JWKS-verify pattern; stateless HS256 session JWT; could mint the Apple client secret at runtime from the `.p8`, eliminating the 6-month rotation chore; consent screens show our own domain) | The only credible rival. Loses on blast radius: we would own ~600–900 lines of security-critical OAuth code (state, nonce, PKCE, **Apple's cross-site form_post + SameSite cookie dance**, id_token verification for two providers, refresh/rotation, replay), plus a users table and identity-linking logic Supabase gives us for free. Buying that to save a twice-a-year 5-minute secret rotation fails the "minimal effort, no overengineering" brief. |
| **Auth.js (next-auth v5)** | Still beta; Next 16 + OpenNext-on-Workers support has historically lagged; brings its own session/adapter conventions beside Supabase; users stored apart from orders unless adapter work is added; same Apple 6-month secret chore. |
| **Clerk / managed IdP** | New paid vendor and client-side widget for a boutique store with an existing database; users outside the orders DB. |

**Why Google and Apple should be implemented this way:** both become *provider toggles in the Supabase dashboard* plus console setup (§10), not code. Our code is provider-agnostic — `signInWithOAuth({ provider })` with two buttons. Apple's web quirks (Services ID as client_id, ES256 client-secret JWT from a `.p8` key, form_post) are configuration + a documented rotation runbook, and Google is a standard OAuth web client pointing at Supabase's callback. Adding a third provider later (or email OTP as a fallback) would be another toggle, not a redesign.

### 2.4 Session mechanics (precise)

- **Cookies** (managed by `@supabase/ssr` through our adapter): `sb-<ref>-auth-token` (base64url JSON of access JWT + refresh token + user; chunked at ~3180 bytes into `.0`, `.1`, … suffixes — use the library's `combineChunks`/`parseCookieHeader` helpers) and `sb-<ref>-auth-token-code-verifier` (PKCE, written at login, consumed at callback). Attributes set in every write: `httpOnly: true`, `secure: NODE_ENV === 'production'` (mirrors `COOKIE_SECURE` in middleware), `sameSite: 'lax'`, `path: '/'`; pin `cookieEncoding: 'base64url'`.
- **TTLs:** access token 3600 s (Supabase default; matches `config.toml`), refresh-token rotation on with the 10 s reuse interval (also defaults). Users stay signed in indefinitely until sign-out/revocation — appropriate for a shop.
- **Read tiers:**
  - *Account pages (RSC):* `getSessionUser()` — reassemble cookie → `jose.jwtVerify` against the cached JWKS (`iss = <SUPABASE_URL>/auth/v1`, `aud = 'authenticated'`) → `{ id, email, name? }`. Local, fail-closed (any error ⇒ signed-out, never 500). RSCs cannot write cookies, which is why…
  - *Middleware (only `/konto*` paths, only when an `sb-*` cookie exists):* fast local verify; if expired (or < 60 s left) → `createServerClient` bound to request/response → `getUser()` → rotated cookies written to the response, response stamped with the full anti-cache header set (§7). Anonymous visitors skip in two cheap guards (path regex, cookie presence).
  - *`POST /api/checkout` and `/api/auth/*` (route handlers — can write cookies):* same fast path; inline refresh on expiry; on any failure checkout proceeds anonymously.
- **Failure modes:** double-refresh races are absorbed by the 10 s reuse interval (both requests end with the same rotated session); JWKS fetch failure or a Supabase Auth outage degrades to signed-out rendering and anonymous checkout — the storefront and payments never depend on auth availability.

---

## 3. Database changes

Two additive, zero-downtime migrations (timestamp-prefix convention, `supabase/migrations/`). No new tables — `auth.users` (managed) is the user store; a `profiles` table is deliberately **not** created (nothing needs one: display name/email come from the JWT; marketing prefs etc. can add one later without rework).

### Migration 1 — `orders.user_id`

```sql
-- Customer accounts: link orders to Supabase Auth users.
-- ON DELETE SET NULL is a safety backstop only — account deletion runs through
-- a runbook procedure (unlink + stamp user_unlinked_at, THEN delete the auth
-- user) so order rows survive as guest-like rows for accounting/legal retention.
-- RLS stance unchanged: orders stays enabled/deny-all with zero policies; all
-- reads continue through the service-role client, filtered server-side by the
-- JWT-verified user id.
alter table orders
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  -- Stamped by the account-deletion procedure; excludes these rows from
  -- backfill-on-login forever, so deleted-account history can never be
  -- silently re-claimed by a later login with the same email address.
  add column if not exists user_unlinked_at timestamptz;

create index if not exists orders_user_id_idx
  on orders(user_id) where user_id is not null;

-- Backfill-on-login runs:
--   WHERE user_id IS NULL AND user_unlinked_at IS NULL AND lower(email) = lower($1)
create index if not exists orders_unclaimed_email_idx
  on orders(lower(email)) where user_id is null and email is not null;
```

FK to `auth.users` is the officially documented Supabase pattern; migrations run as `postgres` so permissions are fine, and local `supabase db reset` has the auth schema (auth is enabled in `config.toml`). Use `SET NULL` (never CASCADE) so order rows always survive user deletion.

**What account deletion does — and does not — do.** Deletion is an **unlink, not an erasure.** The runbook procedure is: `update orders set user_id = null, user_unlinked_at = now() where user_id = :uid;` then delete the `auth.users` row (the FK action is only a backstop if the first step is skipped). `orders.email`, receiver names, and shipping addresses remain on the rows under the store's accounting/legal retention duties — exactly as for guest orders — and erasure requests for that data follow the existing order-PII process, unchanged by this feature. The `user_unlinked_at` stamp is permanently excluded from backfill-on-login (§4.3), so a later verified login with the same address — whether the returning person or a future owner of a recycled mailbox — can never silently re-claim a deleted account's order history.

### Migration 2 — `prodigi_orders` tracking columns (+ backfill)

```sql
-- Persist print tracking (previously only extracted in memory for the shipping
-- email in src/server/prodigi/callbacks.ts). Also closes the admin visibility gap.
alter table prodigi_orders
  add column if not exists carrier         text,
  add column if not exists tracking_number text,
  add column if not exists tracking_url    text,
  add column if not exists shipped_at      timestamptz;

-- Backfill history from prodigi_raw_json. Shipment choice mirrors callbacks.ts:
-- first shipment WITH a tracking number, else first in array order.
update prodigi_orders po
set carrier         = s.ship->'carrier'->>'name',
    tracking_number = s.ship->'tracking'->>'number',
    tracking_url    = s.ship->'tracking'->>'url',
    shipped_at      = nullif(s.ship->>'dispatchDate', '')::timestamptz
from (
  select p.id,
         (select sh.value
            from jsonb_array_elements(coalesce(p.prodigi_raw_json->'shipments', '[]'::jsonb))
                 with ordinality sh(value, ord)
           order by (sh.value->'tracking'->>'number') is null, sh.ord
           limit 1) as ship
  from prodigi_orders p
) s
where po.id = s.id
  and s.ship is not null
  and po.tracking_number is null;
```

(Field paths verified against `src/server/prodigi/types.ts`: `carrier?.name`, `tracking?.{number,url}`, `dispatchDate`.)

**Relationships:** `orders.user_id → auth.users.id` (N:1, nullable). Everything else (order_items, prodigi_orders, fulfilment_jobs → orders) already exists. **RLS:** unchanged everywhere; no policies added (no non-service-role access is introduced).

---

## 4. Purchase flow changes

### 4.1 Anonymous checkout — unchanged

Not one field, validation, reservation, Stripe call, or error shape changes. `user_id` is nullable and absent for guests. All existing E2E checkout specs must pass untouched — that is the acceptance criterion for this section.

### 4.2 Authenticated checkout

One change in `POST /api/checkout`: before the `orders` insert (`route.ts:331`), resolve the session best-effort —

1. Fast path: verify the `sb-*` access token from the `cookie` header locally with jose (microseconds, no I/O).
2. If expired: attempt one refresh via `createServerClient` + `getUser()` (route handlers can set cookies; rotated tokens ride the JSON response). This matters because Apple private-relay users can never be repaired by email backfill later (§4.4) — checkout-time association is their only link.
3. On any failure: `user = null`, checkout proceeds anonymously. **Auth must never block payment.**

Then `user_id: user?.id ?? null` joins the insert. The contact/email fields stay exactly as typed by the buyer — `orders.email` remains the operational email for confirmations/invoices; the account is a viewing layer on top.

*(Phase-5 polish, optional: `koszyk/page.tsx` already reads `headers()` — passing `initialContact` from the session into `CartView` to prefill name/email costs nothing architecturally.)*

### 4.3 How orders become linked to users

Two mechanisms, in priority order:

1. **At creation** (§4.2) — authoritative; survives email mismatches.
2. **Backfill-on-login** — in `/api/auth/callback`, after `exchangeCodeForSession` succeeds (try/caught, never blocks the redirect):

   ```sql
   update orders set user_id = :uid
   where user_id is null
     and user_unlinked_at is null
     and lower(email) = lower(:verified_email);
   ```

   Runs on **every** login (cheap via the partial index), so guest purchases made *between* logins are swept up too. Only provider-verified emails reach this point (Google and Apple both verify; Supabase discards unverified identity emails), and orders unlinked by an account deletion are permanently excluded (§3).

Webhooks, `markPaid`, refunds, the cron — none of them touch `user_id`. Association is decided at insert or by backfill, nowhere else.

### 4.4 Edge cases

| Case | Behavior |
|---|---|
| Replayed checkout POST (PG 23505 `replay=true` branch) | Original row keeps its `user_id`; replay branch doesn't update. A login between retries is repaired by backfill. |
| Pending order → user signs out → pays | Link was written at insert; sign-out doesn't touch orders. |
| Anonymous pending order → user logs in → pays | Backfill covers all statuses including `pending`, so the link exists before `paid`. |
| `orders.email IS NULL` (legacy rows) | Skipped by the backfill predicate; unlinkable by definition. |
| **Apple private relay** (`…@privaterelay.appleid.com`) | Relay ≠ typed checkout email ⇒ backfill can't match past guest orders. Mitigated by checkout-time association (incl. the expired-token refresh). Residual: relay users' *pre-account* guest orders stay unlinked — documented limitation. |
| Buyer pays with a different email than the account | Session `user_id` wins; `orders.email` keeps the typed address (emails/invoices unchanged). Deliberate: the account that made the purchase owns it. |
| Same verified email via Google *and* Apple | Supabase automatic identity linking ⇒ one user, one history. Not taken on faith: the cross-provider same-email round-trip is an explicit item in the Phase-4 preview runbook checklist (§10 rollout step 4). |
| Two accounts could claim the same guest email (e.g. Google user vs Apple-relay user who typed it at checkout) | First login claims (`user_id IS NULL` guard); deterministic, no flapping. |
| Recycled/mistyped email claimed by its current verified owner | Same exposure class as the existing order-confirmation email itself; accepted, documented (only provider-verified emails backfill). |
| Account deletion | Runbook: unlink + stamp `user_unlinked_at`, then delete the auth user (FK `SET NULL` is only a backstop). Orders persist as guest-like rows for accounting/legal retention; deletion is an unlink, not an erasure — `orders.email` erasure remains the existing separate PII process (§3). |
| Same email logs in again *after* a deletion | The `user_unlinked_at IS NULL` guard excludes unlinked rows from backfill ⇒ deleted history is never re-claimed, by the returning person or by a future owner of a recycled address. |
| Refund / dispute / expiry | Untouched paths; the account page simply renders the resulting status. |

---

## 5. Prodigi integration

### 5.1 Order IDs — already right, keep as-is

The internal order UUID is already Prodigi's `merchantReference` **and** `metadata.internal_order_id` (`src/server/prodigi/mapper.ts`), and `prodigi_orders` maps `order_id ↔ prodigi_order_id UNIQUE` with a merchantReference fallback resolver in the callback (`callbacks.ts:121–129`). No change needed — the account dashboard joins `orders → prodigi_orders` on `order_id`.

### 5.2 Shipment tracking synchronization

**Persist tracking in the existing callback upsert** — the data is already in hand there. In `handleProdigiCallback` step 4 (`callbacks.ts:136–139`), hoist the shipment-selection expression currently inside `sendPrintShippingEmailOnce` (`callbacks.ts:215–216`: first shipment with a tracking number, else first) to before the upsert and extend the payload:

```ts
{ order_id, prodigi_order_id, prodigi_status_stage, prodigi_raw_json, updated_at,
  carrier, tracking_number,
  tracking_url, // persisted only when it passes https-validation (below)
  shipped_at    // dispatchDate ?? null — NEVER now(): a replayed/late callback
                // must not shift the ship date to callback-processing time.
                // Derived purely from Prodigi data, so replays converge; absent
                // dispatchDate stays NULL and the UI shows status without a date.
}
```

The email path then reuses the picked shipment. This lands inside an already-deduped (webhook_events lease), already-retried (Prodigi redelivers on our 500s) pipeline — no new failure modes, no changes to dedup/claim logic. Because the handler *re-fetches* the full order on every event, late-arriving tracking numbers upgrade the columns on any subsequent callback automatically.

**`tracking_url` is untrusted external data.** It is persisted and later rendered as an `href` in the account. Validate twice: at persistence (accept only absolute `https://` URLs — anything else stores `NULL` while keeping carrier/number) and again at render (the shared tracking helper emits a link only for `https:` values; otherwise the page shows the bare tracking number as text). This closes off `javascript:`/`data:`-scheme injection from a buggy or compromised upstream payload.

**V1 scope — one primary tracking per order (explicit).** The persisted columns describe the *primary* shipment — first with a tracking number, else first in array order, exactly the shipment today's shipping email cites — while the complete `shipments[]` array remains losslessly in `prodigi_raw_json` (nothing is discarded). Split shipments have never occurred for this catalogue (single-print boutique orders); if they become real, the upgrade path is a child `prodigi_shipments` table plus a shipments list on the detail page, backfillable from the raw JSON at that point. Building that now would be speculative.

### 5.3 Status update flow (customer-facing)

`orders.status` × `fulfilment_type` × per-path fulfilment state → one unified customer status via a new pure mapper `src/lib/account/status.ts` (unit-tested, i18n keys in all four locales):

- `refunded` overrides everything; `pending/failed/expired` orders are simply not shown (§6).
- **Prints** (from latest `fulfilment_jobs.status`): `queued|fulfilment_submitting|fulfilment_submitted` → *processing*; `in_production` → *in production*; `shipped|completed` → *shipped* (+ carrier/tracking link from the new columns); `cancelled` → *cancelled*.
- **Ceramics** (from `orders.delivery_status`, bucketed conservatively): `created|offer_selected|confirmed` → *processing*; movement statuses → *shipped* (+ `inpost_tracking_number` and the InPost tracking URL — extract the literal already used in `src/lib/email.ts` into a shared helper); `ready_to_pickup`-class → *ready for pickup*; `delivered` → *delivered*; unknown → *shipped* if tracking exists else *processing*.
- **Pickup** orders: *paid — awaiting pickup*.

### 5.4 Webhooks vs polling

**Callbacks only; no polling.** Prodigi's callback already covers every stage transition and shipment event (it triggers a full order re-fetch), and it retries on our 5xx. A missed-and-never-retried callback already means "no shipping email today", and the existing manual repair path (`npm run prodigi -- order get …` / callback replay) covers it; the migration backfills all history. Optional later nicety (not in scope): a `sync-tracking` subcommand on `scripts/prodigi-cli.ts`. Ceramics need nothing — `/api/inpost/webhook` already mirrors status + tracking onto `orders`.

---

## 6. User dashboard

Minimal surface: **two pages** under one new route folder `src/app/[locale]/konto/` (Polish slug, consistent with `/koszyk`, `/zwrot`; serves all four locales — no pathnames map exists). Both `force-dynamic`, `robots noindex`, styled with existing tokens/components.

1. **`/konto`** (`konto/page.tsx`) — three states:
   - Auth not configured (`authEnabled` false): a calm "accounts unavailable" notice (deterministic for hermetic E2E).
   - Signed out: **sign-in panel** — two provider buttons (plain `<form method="post" action="/api/auth/login">` with a `provider` field — zero client JS), a short RODO/privacy note, `?auth_error=1` message slot.
   - Signed in: account header (name/email from the JWT + sign-out form) and **order history**: `paid`/`refunded` orders (newest first, capped at 50), each row showing date, item summary (names via the existing product registry / print-token resolvers), total (existing money formatters), and the unified status chip.
2. **`/konto/zamowienia/[id]`** (order detail + tracking) — signed-out → locale-aware `redirect('/konto')`; lookup `WHERE id = :id AND user_id = :uid`, else `notFound()` (matches the `/api/returns` anti-enumeration posture). Sections: items (with print variant details from `order_items.variant`), amounts, delivery method + formatted address (`normalizeShippingAddress` — already handles both JSONB shapes), and the **tracking block** per §5.3. Ceramic paid orders also link to the existing `/zwrot?order=<id>` returns flow — reusing it rather than rebuilding returns inside the account.

**Account management:** deliberately minimal for v1 — identity comes from Google/Apple (nothing to edit), so "management" is sign-out plus a mailto for deletion requests (owner runs the unlink runbook from §3, then deletes the user in the Supabase dashboard). A self-serve delete button is listed as an open decision (§13). No address book, no saved payment methods (Stripe PaymentElement + browser autofill already cover this at the friction level the store wants).

---

## 7. Backend changes

### New endpoints (all under `/api/auth/*` — outside the middleware matcher, never cache-intercepted)

Any response that writes auth cookies — these routes, the middleware refresh, and a checkout response that performed an inline refresh — carries the **full anti-cache header set** per Supabase SSR guidance, not just the house `private, no-store`: `Cache-Control: private, no-cache, no-store, must-revalidate, max-age=0`, `Pragma: no-cache`, `Expires: 0` (plus the already-global `Vary: Cookie`). Asserted in unit tests for the route handlers and the middleware block.

| Route | Method | Behavior |
|---|---|---|
| `/api/auth/login` | POST (form) | Fail-closed 404 unless `authEnabled`; rate-limited (clone the `/api/returns` limiter pattern); validates `provider ∈ {google, apple}` and relative-only `next` (`^\/(?!\/)`), stashes `next` in a short-lived httpOnly cookie; `signInWithOAuth({ provider, options: { redirectTo: <origin>/api/auth/callback, skipBrowserRedirect: true } })` → 303 to the provider URL (PKCE verifier cookie written httpOnly). |
| `/api/auth/callback` | GET | `exchangeCodeForSession(code)` → session cookies (httpOnly) → try/caught **backfill UPDATE** (§4.3) → 303 to sanitized `next` (default `/konto`); on provider `?error` or exchange failure → 303 `/konto?auth_error=1`. |
| `/api/auth/signout` | POST (form) | Origin check; `signOut({ scope: 'local' })` (revokes the session server-side, clears cookies via the adapter); 303 → `/`. |
| `/api/debug/test-session` | POST | **Optional, Phase 4.** E2E-only seeded-session mint, gated fail-closed by a new `E2E_AUTH_DEBUG_TOKEN` (exact `FULFILMENT_DEBUG_TOKEN` pattern: 404 unless set; never set in production). |

**No `/api/account/*` data endpoints at all.** Account pages are server components calling a shared read helper (`src/lib/account/orders.ts`) that uses `getSupabaseAdmin()` filtered by the verified user id — the same shape as every admin read (`src/lib/admin/data.ts`). Fewer endpoints, no client fetching, no new authorization surface.

### Modified

- **`src/middleware.ts`** — one guarded block (~35 lines) before `handleI18n`: `/konto` path regex + `sb-*` cookie presence → local verify → refresh only when expired → copy rotated cookies onto the response + the full anti-cache header set (§7). Everything else (matcher, i18n, currency, headers, the `middleware.ts` filename) untouched. Keep the supabase-server import lazy inside the guarded branch to limit edge-bundle parse cost.
- **`src/app/api/checkout/route.ts`** — §4.2 (session resolve + `user_id` in the insert).
- **`src/server/prodigi/callbacks.ts`** — §5.2 (tracking columns in the existing upsert).
- **`src/app/admin/fulfillment/[id]/page.tsx`** *(optional, ~5 lines)* — display the new Prodigi tracking columns; closes today's admin gap.

### New libs

- **`src/lib/auth/session.ts`** — `authEnabled(env)`; `getSessionUser()` (RSC via `next/headers`); `getSessionUserFromCookieHeader(header)` (pure — checkout fast path, middleware, unit tests); cookie-name derivation from `SUPABASE_URL`; chunk reassembly via the library helpers; jose verification with a module-level JWKS map (clone of `access.ts`). Env access via `getCloudflareContext().env` with a `try/catch → process.env` fallback (hermetic `next start` E2E).
- **`src/lib/auth/supabase-server.ts`** — two `createServerClient` factories (from `next/headers` cookies; from request/response for middleware) pinning `cookieOptions` (httpOnly/secure/lax/path) + `cookieEncoding: 'base64url'`.
- **`src/lib/account/orders.ts`** — list/detail reads (orders + items + `prodigi_orders` + latest `fulfilment_jobs` row, mirroring the "latest job" rule from `callbacks.ts:147–153`).
- **`src/lib/account/status.ts`** (+ colocated test) — the unified status mapper (§5.3).

### Authentication middleware & authorization rules

- Verification is **local jose JWT verification** everywhere (fail-closed: any error = anonymous); Supabase is contacted only to mint/refresh/revoke sessions.
- Authorization is **row-ownership by construction**: every account query is `…eq('user_id', session.id)`; the detail page 404s on mismatch. No roles, no policy engine — nothing else needs authorizing.
- `/admin` (Cloudflare Access) and `/api/admin/*` are completely unaffected; the two auth systems never interact.

---

## 8. Frontend changes

- **Auth UI:** `src/components/account/SignInPanel.tsx` + `SignOutButton.tsx` — server components, plain POST forms, provider logos per brand guidelines. No modal, no OAuth JS SDKs, no client islands.
- **Account pages:** §6 (two pages + small presentational pieces: order row, status chip, tracking block).
- **Checkout touches:** `/koszyk/return` success block (`return/page.tsx:100–103` already renders a button row) gains one quiet link to `/konto` — "track this order in your account". It is rendered unconditionally (the target handles both states), so the client component needs **no session awareness**. Cart prefill is Phase-5 polish (§4.2).
- **Navigation:** `Header.tsx` `nav-right` (line 51) + the `mobileLinks` array (line 16) gain a **static** `Konto` link (an icon-btn next to the cart, matching house style). Deliberately *not* session-aware: the header is a server component rendered inside the `[locale]` layout, and reading `cookies()` there would flip the prerenderable Polish pages dynamic (§1.1) — a real caching regression for a label. `/konto` itself shows the right state. (A non-httpOnly `acc_ui=1` display-hint cookie + client label swap is noted as optional polish, same pattern as `CartCount`.)
- **i18n:** new top-level `account` namespace (~25 keys: headings, provider buttons, empty state, order labels, 8 status labels, auth error, sign-out) + `nav.konto` + `title.konto` — added to **all four** `messages/*.json` in the same commit (`src/i18n/messages.test.ts` enforces parity). Links via `@/i18n/navigation` as everywhere else.

---

## 9. Security considerations

- **OAuth:** PKCE code flow end-to-end; provider secrets live only in Supabase's dashboard (never in our env/bundle); Apple form_post terminates at Supabase; our callback validates via `exchangeCodeForSession` (code + verifier bound); `next` redirect targets are validated relative-only (open-redirect proof); login endpoint is rate-limited and POST-only (login-CSRF resistant); provider `?error` responses never mint cookies.
- **Session management:** httpOnly + Secure + SameSite=Lax cookies (tokens are **never** readable by JS — stricter than the Supabase default browser setup, and it makes the Report-Only CSP a non-blocker); refresh-token rotation with 10 s reuse window; sign-out revokes server-side (`scope: 'local'`); JWT verification checks signature (asymmetric JWKS), `iss`, `aud`, `exp` — mirroring `src/lib/admin/access.ts`; sessions die cleanly if the secret is removed (kill switch).
- **Authorization:** service-role stays server-only (unchanged); every account read is ownership-filtered server-side; order detail 404s on non-ownership (anti-enumeration, house pattern); RLS posture (deny-all, no policies) unchanged; no privilege path from customer session to admin surfaces.
- **Sensitive data:** the dashboard exposes only the owner's own orders (address, items, tracking — data they entered); no payment data beyond totals (PANs never touch this system); `marketing` jsonb is never rendered; backfill links only provider-**verified** emails and never rows stamped `user_unlinked_at`; account deletion = the unlink runbook (§3 — an unlink, not an erasure; orders keep serving accounting/tax duties as guest-like rows); externally-sourced `tracking_url` values are https-validated at persistence *and* at render (§5.2); one privacy-policy paragraph documents account processing + historical-order linking (RODO). Auth events are loggable via existing Sentry wiring without token contents.
- **Fail-closed everywhere:** missing `SUPABASE_PUBLISHABLE_KEY` ⇒ auth routes 404, `/konto` renders "unavailable", middleware no-ops, checkout skips resolution — the pattern `FULFILMENT_DEBUG_TOKEN` and the admin gate already established.

---

## 10. Deployment considerations

### Environment variables

| Var | Kind | Notes |
|---|---|---|
| `SUPABASE_PUBLISHABLE_KEY` | **New** runtime secret (`wrangler secret put` + `.dev.vars`) | Publishable/anon key; server-side only. Its presence is the feature flag. |
| `E2E_AUTH_DEBUG_TOKEN` | New, optional, preview/staging only | Test-session mint gate; **never set in production**. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Existing | Unchanged. |

Update `.env.example` + `.env.cf-typegen`, run `npm run cf-typegen` (type the new var as optional so the fail-closed check is compiler-enforced). No `NEXT_PUBLIC_*` additions — nothing auth-related is needed at build time.

### Supabase dashboard (Phase 0)

1. Migrate the project to **asymmetric JWT signing keys** (zero-downtime dashboard action) → exposes the JWKS endpoint for local verification.
2. Auth → URL configuration: Site URL `https://anna-ciok.studio`; redirect allowlist: `https://anna-ciok.studio/api/auth/callback`, `http://localhost:3000/api/auth/callback` (+ staging/preview equivalents).
3. Enable Google + Apple providers (credentials below). Leave the email provider un-surfaced in our UI (OAuth-only sign-in).

### Google OAuth setup

Google Cloud Console → OAuth consent screen (External; app name "Anna Ciok Ceramics"; support email; authorized domains: `anna-ciok.studio` + `supabase.co`) → Credentials → OAuth Client ID (Web application) → authorized redirect URI **`https://<ref>.supabase.co/auth/v1/callback`** → paste client id/secret into Supabase. Scopes are non-sensitive (`openid email profile`) — no Google verification review needed (start logo-less to avoid triggering one).

### Apple Sign-In setup

Requires an active **Apple Developer Program membership** ($99/yr — open question §13). App ID → **Services ID** (this is the OAuth `client_id`, e.g. `studio.anna-ciok.web`) with Sign in with Apple enabled, domain `<ref>.supabase.co`, return URL `https://<ref>.supabase.co/auth/v1/callback` → create a Sign in with Apple **Key**, download the `.p8` (store offline) → generate the ES256 **client-secret JWT (max 6-month validity)** and paste into Supabase. Add a tiny `scripts/gen-apple-secret.ts` (jose is already a dependency) so regeneration is one command, and a **5-month calendar reminder** in the runbook — an expired secret breaks *only* Apple login, silently.

### Production rollout steps

1. **Phase 0** (no code): provider consoles + Supabase config above; resolve §13 open items.
2. Ship migrations (dark — columns unused).
3. Ship auth core + pages **with the secret unset** → everything 404s/renders "unavailable"; storefront provably unaffected.
4. Set `SUPABASE_PUBLISHABLE_KEY` on a **preview** deployment; manually round-trip Google + Apple (runbook checklist: fresh signup, repeat login, cross-provider same-email linking, backfill, checkout association, konto rendering, sign-out).
5. `wrangler secret put` in production → feature is live but unadvertised (direct URL only) → smoke test with a real account.
6. Ship the header/nav entry + return-page link — the public launch commit.
7. Kill switch at every step: delete the secret (sessions degrade to signed-out; checkout unaffected). Conventional commits per phase (`feat(db):…`, `feat(auth):…`, `feat(account):…`) so release-please versions them normally.

---

## 11. Risks

| Risk | Assessment / mitigation |
|---|---|
| **Layout/caching regression** (session read in layout or Header flips the prerenderable `pl` tree dynamic) | The one real architectural trap — designed out via the static header link; PR checklist line: "no `cookies()`/`headers()` added to `[locale]/layout.tsx` or `Header.tsx`". |
| **Set-Cookie meets cache interception** | Auth cookies are written only on `/api/*` (outside interception) and `/konto*` (force-dynamic); every such response carries the full anti-cache header set (§7); `Vary: Cookie` is already global. |
| **Split (multi-parcel) Prodigi shipment** | V1 explicitly tracks the primary shipment only (§5.2); the full `shipments[]` array stays in `prodigi_raw_json`, so nothing is lost and a child-table upgrade remains backfillable. |
| **Middleware bloat / edge compat** (`middleware.ts` must stay edge; OpenNext rejects Node `proxy.ts`) | supabase-js already runs in this Worker; the refresh path sits behind two cheap guards and a lazy import; verify `next build --webpack` + `opennextjs-cloudflare build` in Phase-2 CI. |
| **@supabase/ssr cookie-format drift** on upgrade (our jose fast path parses its cookies) | Unit fixture is generated *via the library itself* — drift fails the test loudly, not production silently. |
| **Double-refresh races** (parallel expired requests) | Absorbed by the 10 s refresh-reuse interval; refresh surface deliberately tiny (konto + checkout). Residual: very stale multi-tab sessions may force a re-login — acceptable. |
| **Apple secret expiry** (6-month max) breaks Apple login only | Runbook + 5-month reminder + `gen-apple-secret` script; watch Sentry for callback `auth_error` spikes. |
| **Apple private relay** limits history backfill | Checkout-time association (incl. refresh-on-expired) is the primary link; residual limitation documented. |
| **Wrong-account linking via recycled/typo'd guest emails** | Only provider-verified emails backfill; `user_id IS NULL` guard makes claims one-shot; exposure class already accepted for order-confirmation emails. |
| **Supabase Auth outage** | Fail-closed to signed-out rendering + anonymous checkout; revenue path never depends on auth. |
| **Backward compatibility** | Columns are additive/nullable; webhooks, cron, admin actions, orders-CLI, reconcile scripts untouched; anonymous checkout byte-identical; existing E2E suite green is the regression gate. |
| **i18n parity** | `messages.test.ts` fails any partial translation — namespace lands in all four files in one commit. |
| **Migration risk** | Both migrations additive with `if not exists`; the jsonb backfill only fills NULLs (idempotent, re-runnable); FK adds no lock pressure at this table size. |

---

## 12. Implementation roadmap

Phases are independently shippable, each behind the fail-closed gate; conventional-commit titles included for release-please.

| Phase | Contents | Ships as |
|---|---|---|
| **0 — Provider setup** (no code; owner + dev) | Apple Developer membership confirmed, Services ID + key; Google consent screen + client; Supabase: JWT signing keys, URLs, providers; decide §13 items | — |
| **1 — Data groundwork** | Both migrations; `callbacks.ts` persists tracking columns; (opt.) admin fulfillment page shows them | `feat(db): link orders to auth users and persist prodigi tracking` |
| **2 — Auth core (dark)** | `@supabase/ssr`; `src/lib/auth/{session,supabase-server}.ts`; `/api/auth/{login,callback,signout}`; middleware block; env plumbing + `cf-typegen`; unit tests | `feat(auth): supabase auth core behind fail-closed env gate` |
| **3 — Account pages + association** | `/konto` + `/konto/zamowienia/[id]`; `src/lib/account/{orders,status}.ts` + tests; checkout `user_id`; callback backfill; `account` namespace ×4 locales | `feat(account): order history and tracking pages` |
| **4 — Entry points, tests, docs** | Header/mobile `Konto` link; return-page link; `e2e/konto.spec.ts` (@ci: unavailable-state, redirect, nav link, 404 gate); optional `test-session` debug route + `@account-edge` seeded-session spec; `docs/customer-accounts-runbook.md` | `feat(account): navigation entry, e2e coverage, runbook` |
| **5 — Optional polish** (each independent) | Cart contact prefill from session; non-httpOnly display-hint cookie for a signed-in header label; `/admin/customers` grouping by `user_id`; `prodigi-cli sync-tracking` | separate small PRs |

**Testing summary:** unit — status mapper (exhaustive table), session cookie reassembly/verify (fixtures minted via `@supabase/ssr` itself + locally-signed ES256 JWTs), the `tracking_url` https-validator, anti-cache headers on every cookie-writing auth response, existing messages-parity test; E2E `@ci` — hermetic, auth-disabled deterministic states; E2E `@account-edge` (new opt-in tier alongside `@checkout-edge`) — seeded session via the debug route against a real staging Supabase: list/detail/sign-out and a checkout-association assertion; real-provider OAuth round-trips are a manual runbook checklist per environment (the honest cost of OAuth E2E everywhere). Regression gate: the untouched checkout E2E suite stays green.

---

## 13. Missing information / decisions needed from the owner

Explicitly *not* assumed — these change setup or scope:

1. **Apple Developer Program**: is a paid membership ($99/yr) active, and who owns the account? Sign in with Apple is impossible without it (its absence blocks only the Apple half — Google could ship first).
2. **Google Cloud project**: reuse the existing analytics GCP project for the OAuth consent screen, or create a dedicated one? Who administers it?
3. **Consent-screen branding tolerance**: Google's screen will show `<project-ref>.supabase.co`. Accept, or purchase the Supabase custom-domain add-on (~$10/mo; changes the redirect URLs configured at both providers)?
4. **Backfill-by-email policy**: confirm that auto-linking historical guest orders on first verified-email login is desired, and that the privacy policy gets the corresponding RODO paragraph.
5. **Scope confirmations** (assumed yes): ceramics orders are in scope ("every order"), and the account list shows `paid`/`refunded` orders only (hiding `pending/failed/expired`).
6. **Account deletion**: v1 = owner-handled via the Supabase dashboard on request (recommended), or is a self-serve delete button a launch requirement?
7. **Supabase project state**: is the hosted project still on the legacy symmetric JWT secret (determines whether the signing-keys migration in Phase 0 is a click or already done)? Does the staging plan imply a second Supabase project needing its own provider config?
8. **Apple secret rotation ownership**: who receives the 5-month reminder (studio vs developer)?
