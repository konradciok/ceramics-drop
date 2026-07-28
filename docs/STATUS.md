# Current status — volatile facts

Perishable, feature-state facts live here so `AGENTS.md` can stay stable
architecture only. Each row carries the date it was last verified; treat
anything old as "verify before relying on it". Update this file (not
`AGENTS.md`) when feature state changes.

| Area | State | Last verified |
|---|---|---|
| Production | Live at [anna-ciok.studio](https://anna-ciok.studio); deploys via Cloudflare Workers Builds on every push to `main` | 2026-07-28 |
| Catalog source | `CATALOG_SOURCE=db` in production (`wrangler.jsonc`); `code` is the local/test fallback. **Do not delete the DB catalog path** (see `docs/pony-audit.md` retraction) | 2026-07-28 |
| Customer accounts | Live; `SUPABASE_PUBLISHABLE_KEY` is set in prod. **Google sign-in verified end-to-end in production.** Apple sign-in wired in code but NOT enabled — blocked on the Apple Developer Program membership decision (`docs/customer-accounts-runbook.md` §1.3/§1.4) | 2026-07-25 |
| Fine-art prints | Storefront + Prodigi pipeline live; `fap01` published. Sandbox contract smoke exists but the `prodigi-contract-smoke` workflow had never been dispatched and its `PRODIGI_API_KEY_SANDBOX` repo secret was missing | 2026-07-23 |
| GitHub Actions | Repo is public (unlimited minutes); CI + E2E are required checks on `main`. Outstanding operator items from `docs/github-actions-audit.md`: refresh `PRINT_ASSET_TOKEN_SECRET` repo secret, add `PRODIGI_API_KEY_SANDBOX`, dispatch `prodigi-contract-smoke` once, set `PRINT_SMOKE_STRICT` / `PRODIGI_SMOKE_STRICT` to `true` | 2026-07-28 |
| Ceramic catalogue | ~125 live pieces across 9 categories (`src/lib/products.test.ts` asserts the exact count) | 2026-07-27 |
| Currencies | PLN / EUR / GBP live; USD & CAD scaffolded only (`priceOfCurrency` throws) — intentional, do not remove without an owner decision | 2026-07-14 |
| Versioning | release-please active; current series pre-1.0 (`0.x`), v0.11.0 | 2026-07-28 |
