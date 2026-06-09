# Email migration `@ciok.art` — status checkpoint

> Updated: 2026-06-08 (session). PR **#34** is merged (`3f4b4f4`). Remaining Phase-4 smoke tests are tracked as T20/T22 in `2026-06-08-go-to-market-execution.md`.

## Gates

| Gate | Status | Owner |
| --- | --- | --- |
| Resend `ciok.art` verified | **DONE** (2026-06-07 ~21:07 CET) | — |
| External mail → `hej@ciok.art` | **DONE** (user confirmed) | — |
| External mail → `studio@ciok.art` | **DONE** (user confirmed) | — |
| Squash-merge PR #34 | **DONE** (`3f4b4f4`, 2026-06-07) | — |
| `wrangler secret put STUDIO_NOTIFY_EMAIL` | **DONE** → `studio@ciok.art` | — |
| `wrangler secret put STUDIO_RETURN_EMAIL` | **DONE** → `studio@ciok.art` | — |
| `hej@annaciok.pl` → `hej@ciok.art` forward | **N/A** | `annaciok.pl` not in this OVH account |
| `konradciok.pl` / legacy Konrad addresses | **N/A** | Domain/address never existed — no forward needed |

## Completed (Phase 2)

- OVH mailboxes: `hej@ciok.art`, `studio@ciok.art` (task IDs 213086006, 213086007)
- Resend domain `ciok.art` created (ID `7767a4f9-bfc1-40e9-918b-c0ea3850290d`, region `eu-west-1`)
- OVH DNS zone records:
  - **Added**: `resend._domainkey` TXT (DKIM); `send` MX + TXT (Resend return-path / SPF)
  - **Added** (2026-06-08): `_dmarc` TXT — OVH record ID `5418337827`, target
    `v=DMARC1; p=none; rua=mailto:studio@ciok.art` (`studio@` used — no `dmarc@` mailbox).
    Post-add `nslookup -type=TXT _dmarc.ciok.art` on 1.1.1.1 + 8.8.8.8 both return the
    record within ~15s. Policy `p=none` — tighten to `p=quarantine` after 1–2 weeks of
    aggregate reports.
- Root `@` unchanged: OVH MX (`mx1/mx2/mx3.mail.ovh.net`) + SPF `include:mx.ovh.com`
- Resend verify: **verified** (all three records green)

## Rollback preserved

- `anna-ciok.studio` remains verified in Resend (only other domain)
- Templates: `label-to-studio`, `shipping-confirmation`, `return-label-customer` — all published

## Your turn

1. **Phase 4 smoke tests** — see `docs/superpowers/plans/2026-06-07-email-ciok-art-prompt.md` and tasks **T20/T22** in `2026-06-08-go-to-market-execution.md`.

## OVH cleanup (2026-06-07)

- Removed `konrad@ciok.art` mailbox (legacy personal account).
- Removed `postmaster@ciok.art` → `konrad.ciok@gmail.com` forward.
- Removed mistaken `_dmarc@ciok.art` email forward (DMARC stays DNS TXT only).
- Active studio mailboxes on `ciok.art`: `hej`, `studio`, `ania`, `info`.
- `konradciok.pl` does not exist — ignore. `konradciok.art` is a separate registered domain in this OVH account (empty redirect-only email offer); unrelated to storefront mail.

## T20 — Resend hardening (2026-06-08)

Evidence from the T20 session (`docs/superpowers/plans/2026-06-08-resend.md`):

- **API keys pruned** — deleted stale keys `docker`, `react`, `Onboarding`; `list-api-keys`
  now returns **only `ceramics`** (the Worker's `RESEND_API_KEY`).
- **Smoke send delivered** — FROM `sklep@ciok.art` → `studio@ciok.art`, Resend ID
  `60818b7e-6aee-4c17-9b18-aed79e28c448`, status **delivered**, 2026-06-08 20:18 UTC.
  Proves domain + DNS + deliverability via the Resend MCP key. **Does not** prove the
  production Worker's `RESEND_API_KEY` wiring (no admin send route; true Worker proof
  needs a real checkout — Task 22).
- **Resend webhook route added** — `src/app/api/resend/webhook/route.ts` + pure verifier
  `src/lib/resend-webhook.ts` (+ tests), committed `bffa2f0` on `codex/hardening`. Verifies
  the Svix HMAC-SHA256 signature via Web Crypto, ±300s replay window, fails closed without
  the secret. Introduces `RESEND_WEBHOOK_SECRET`. **Registered** in Resend 2026-06-08
  (webhook ID `5d5224fc-6c13-4601-bf52-b1ee26d37d8e`, enabled; events delivered/bounced/
  complained/delivery_delayed; signing secret issued + stored as `RESEND_WEBHOOK_SECRET`).
  **Not yet deployed** to prod.
- **DMARC added** (2026-06-08) — new OVH API token (`zone` app) with domain-zone ACL.
  Before: `nslookup` → **Non-existent domain** (1.1.1.1 + 8.8.8.8). After zone refresh:
  `"v=DMARC1; p=none; rua=mailto:studio@ciok.art"` on both resolvers. OVH record ID
  `5418337827`. `rua` points at `studio@ciok.art` (existing mailbox; no `dmarc@`).

**Pending (gated on user):**
- Update Cursor `user-ovhcloud` MCP env with the new `zone` API credentials (old key
  still 403 on domain endpoints).
- Set `wrangler secret put RESEND_WEBHOOK_SECRET` on the prod Worker and deploy/merge to
  main (webhook already registered). Then confirm an `email.delivered` event arrives for a
  fresh smoke send by checking the Worker logs for the `"event":"resend_webhook"` line.

## Not started

- Phase 4 smoke tests (post-merge)
- Phase 5 legacy cleanup (~1–2 week window)
