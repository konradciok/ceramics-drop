# Email migration `@ciok.art` — status checkpoint

> Updated: 2026-06-07 (session). PR **#34** is merged (`3f4b4f4`). Remaining Phase-4 smoke tests are tracked as T20/T22 in `2026-06-08-go-to-market-execution.md`.

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
- OVH DNS zone records added + refreshed:
  - `resend._domainkey` TXT (DKIM)
  - `send` MX + TXT (Resend return-path / SPF)
  - `_dmarc` TXT (`p=none`, `rua=mailto:dmarc@ciok.art`)
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

## Not started

- Phase 4 smoke tests (post-merge)
- Phase 5 legacy cleanup (~1–2 week window)
