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
| Fine-art prints | Storefront + Prodigi pipeline live; **43 production designs published (`fap005`–`fap047`)** in five curated collections, all through the full prepare→publish asset pipeline. Legacy posters `fap01`–`fap03` withdrawn 2026-08-06 (never fulfilable; entries retained unpublished — re-publishing needs restored sources + a pipeline run). `prodigi-contract-smoke` dispatched successfully 2026-07-23 | 2026-08-07 |
| GitHub Actions | Repo is public (unlimited minutes); CI + E2E are required checks on `main`. The `docs/github-actions-audit.md` operator checklist is **complete**: `PRINT_ASSET_TOKEN_SECRET` + `PRODIGI_API_KEY_SANDBOX` repo secrets set, `prodigi-contract-smoke` dispatched (success), `PRINT_SMOKE_STRICT=true`, `PRODIGI_SMOKE_STRICT=true` | 2026-08-07 |
| Ceramic catalogue | ~125 live pieces across 9 categories (`src/lib/products.test.ts` asserts the exact count) | 2026-07-27 |
| Currencies | PLN / EUR / GBP live; USD & CAD scaffolded only (`priceOfCurrency` throws) — intentional, do not remove without an owner decision | 2026-07-14 |
| Versioning | release-please active; current series pre-1.0 (`0.x`), **v0.13.0 released 2026-08-07** (the full-bleed prints rollout + fap01–03 withdrawal) | 2026-08-07 |
