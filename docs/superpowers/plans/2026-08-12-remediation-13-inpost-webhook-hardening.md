# Remediation 13 — InPost webhook hardening (M-13 / L-34 / L-35) — P2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Source audit: `docs/audits/backend-audit-2026-08-12.md` §5 M-13, §9 (InPost), L-34/L-35. Evidence re-verified at HEAD `3da7ee0`.

**Goal:** Close the three InPost-webhook weaknesses: the shared secret riding in a URL that lands in 100%-sampled persisted logs, the non-timing-safe token compare (the only non-constant-time webhook auth in the codebase), and status mirroring with no allow-list or monotonic guard (out-of-order redeliveries regress `/konto` tracking status).

**Architecture:** Point fixes in `src/app/api/inpost/webhook/route.ts` + `src/lib/shipx.ts`: constant-time compare (WebCrypto digest-equality helper), a status allow-list with rank-based monotonic advance, log-redaction of the token, and an optional source-IP allowlist as secondary defense. The token stays in the URL — the InPost panel only registers a URL (`route.ts:24` comment) — so the mitigation is redaction + rotation + secondary checks, not relocation.

**Tech stack:** WebCrypto (`crypto.subtle.digest` equality — Workers-safe), InPost ShipX webhook docs (https://dokumentacja-inpost.atlassian.net/wiki/spaces/PL/pages/18153494/Webhooks).

## Objective

A leaked log line no longer hands out a replayable webhook credential; token comparison leaks no timing signal; a late-arriving older event can no longer overwrite a newer delivery status shown to customers.

## Findings covered

- **M-13** (MEDIUM) — token in URL, persisted in 100%-sampled logs; source-IP allowlist (`91.216.25.0/24`) unused. → PLANNED
- **L-34** (LOW) — plain `!==` compare. → PLANNED
- **L-35** (LOW) — no allow-list/monotonic guard on `delivery_status`. → PLANNED

## Current-state evidence

All `VERIFIED` at HEAD `3da7ee0`:

- `src/app/api/inpost/webhook/route.ts:24-28` — token from `searchParams`, compared with `!==`; comment confirms the URL-only registration constraint. No body-signature verification exists (InPost offers signatures on some products — check the current docs during implementation; if the ShipX org webhook now supports signing, prefer it).
- `route.ts:77-84` — `delivery_status: evt.status` mirrored unconditionally; `parseShipxWebhook` (`src/lib/shipx.ts:269-294`) validates only non-empty-string (+ `shipment_confirmed` fallback :283-284). No enum, no ordering. CAS claims exist only for the email stamps (:96-101, :158-163, :233-238) — the status column itself is unguarded.
- `wrangler.jsonc:56-70` — logs persisted at 100% sampling → every webhook URL (with `?token=`) is durably logged (M-13's exposure path; note OpenNext/Workers log the URL on invocation logs).
- Audit §9: the InPost source-IP allowlist `91.216.25.0/24` is documented by InPost but unused here. `[INFERENCE]` on its stability — treat as secondary defense only.

## Desired end state

Constant-time token check; token never appears in logs (redacted at our logging sites; invocation-log exposure mitigated by rotation + secondary IP check); `delivery_status` only advances along a known-status ranking (unknown statuses recorded to a side field/log, never regressing the customer-visible value).

## Scope

- `src/app/api/inpost/webhook/route.ts`, `src/lib/shipx.ts` (+ tests)
- A small shared `timingSafeEqualStrings` helper (place in `src/lib/` near existing crypto utils; the newsletter HMAC compare is already constant-time — reuse its helper if one exists rather than adding a twin)
- **External (gated):** one-time `INPOST_WEBHOOK_TOKEN` rotation after deploy

## Out of scope

- Moving the token out of the URL (impossible under panel constraints today).
- The InPost *sending* path (shipment creation) and returns flow.
- Any `/konto` UI change.

## Implementation steps

### Task 1 — L-34: constant-time compare

- [ ] Locate/create the constant-time string-equality helper (check `src/lib/newsletter.ts`'s token compare first — reuse if exported/exportable). Workers-safe approach: compare `SHA-256` digests of both values via `crypto.subtle.digest`, byte-wise — digest-then-compare sidesteps length leaks.
- [ ] Failing test: equal tokens pass; unequal fail; empty/missing fail — through the route (mock env).
- [ ] Swap the `!==` at `route.ts:26`.
- [ ] Green + commit: `fix(inpost): constant-time webhook token comparison (L-34)`

### Task 2 — L-35: status allow-list + monotonic advance

- [ ] Enumerate the known ShipX status vocabulary actually consumed by the app (grep `/konto` tracking display + `docs/` for the status list; consult the InPost docs for the canonical sequence, e.g. `created → offers_prepared → offer_selected → confirmed → dispatched_by_sender → collected_from_sender → taken_by_courier → adopted_at_source_branch → … → out_for_delivery → ready_to_pickup → delivered`). Build `SHIPX_STATUS_RANK: Record<string, number>` in `src/lib/shipx.ts` from that list — ranks with gaps (10, 20, 30…) so intermediate statuses slot in later.
- [ ] Failing tests (shipx + route): a known status with higher rank than the stored one updates; a lower/equal rank does NOT regress the column (no-op + structured log `inpost_status_out_of_order`); an unknown status does not touch `delivery_status` (logged `inpost_status_unknown`, still 200 — InPost must not retry-loop on our vocabulary gaps); tracking-number backfill still applies regardless of rank outcome.
- [ ] Implement: fetch the current `delivery_status` in the existing order lookup (it already reads the order — extend the select), gate the update at `route.ts:77-84` on rank advance. Terminal statuses (`delivered`, `returned_to_sender`) rank highest.
- [ ] Green + commit: `fix(inpost): allow-listed, monotonic delivery-status updates (L-35)`

### Task 3 — M-13: exposure reduction

- [ ] Audit our own logging in the route: ensure no `console.*` call logs `req.url` or the token (add redaction if any does).
- [ ] Add the secondary source-IP check: if `CF-Connecting-IP` is present and outside `91.216.25.0/24`, log `inpost_webhook_ip_unexpected` (structured, incl. IP) and — decision point — **log-only for the first two weeks**, then flip to reject via a small `INPOST_WEBHOOK_ENFORCE_IP` env toggle. Rationale: the CIDR is documentation-sourced, not contractual; observe before enforcing. Both modes tested.
- [ ] Document the rotation runbook step in `docs/stripe-operations.md`-adjacent ops docs (or `docs/orders-cli.md`'s ops section): rotate `INPOST_WEBHOOK_TOKEN` = set new secret + re-register the webhook URL in the InPost panel.
- [ ] **GATE (live mutation):** perform one token rotation after this deploy (new random token; `wrangler secret put INPOST_WEBHOOK_TOKEN`; update the URL in the InPost panel) — invalidates every token copy sitting in historical logs. Requires operator approval + a low-traffic window (webhooks 401 between secret set and panel update — keep the gap to minutes; InPost retries failed deliveries, and `npm run reconcile:orders --buy` backfills stuck shipments if any slip through).
- [ ] Commit (code parts): `fix(inpost): redact token from logs; observe-then-enforce source-IP check (M-13)`

## Database / migration work

None (`delivery_status` stays free-text at the DB layer; the allow-list is enforced in code — a DB CHECK would fight InPost's evolving vocabulary; decision recorded here deliberately, diverging from L-13's DB-side approach because the value set is external).

## External-system changes

| Change | System | Gate |
|---|---|---|
| Rotate `INPOST_WEBHOOK_TOKEN` + re-register webhook URL | Cloudflare secret + InPost panel | **Explicit operator approval + timed window** |
| (Conditional) enable IP enforcement | env var flip | Operator, after 2-week observation shows only-InPost IPs |

Pre-state check: current webhook registration visible in the InPost panel. Post-state: a test shipment event (or the next organic one) delivers 200 with the new token; old token 401s.

## Tests

- **New:** constant-time compare (equal/unequal/missing); status rank matrix (advance / regress-blocked / unknown-logged / tracking-backfill-independence); IP check both modes.
- **Regressions caught:** reintroduction of `!==`; unconditional status mirror; token leakage into our log calls (assert log payloads in tests where the seam allows).
- **Simulated:** out-of-order redelivery (newer status stored, older event arrives); unknown future status; off-CIDR source.

## Verification

- **Local/unit:** `npx vitest run src/app/api/inpost src/lib/shipx*` + full `npm test` — pasted.
- **Preview:** replay a captured ShipX payload shape against preview with the right/wrong token → 200/401; two events out of order → status does not regress (DB read pasted).
- **Live read-only:** after the next organic InPost event, confirm `/konto` status advanced and logs show no `inpost_status_out_of_order` false positives.
- **Live mutation:** the gated rotation, verified by a 401 on the old token and 200 on the new.

## Rollout / recovery

1. Code PR first; observe one organic delivery cycle.
2. Rotation second (gate).
3. IP enforcement last (after observation).
4. **Rollback:** revert PR / revert secret to prior value + panel URL. **Stop signals:** any legitimate InPost delivery 401ing post-rotation (panel URL mismatch — fix the registration, don't widen the check); `inpost_status_out_of_order` firing on *forward* progress (rank table wrong — fix ranks before customers notice stale tracking).

## Acceptance criteria

- [ ] Token compare is constant-time; unit matrix green.
- [ ] Out-of-order events cannot regress `delivery_status` (unit + preview evidence).
- [ ] Unknown statuses log-and-200 without mutation.
- [ ] Rotation completed with old token rejected (or explicitly deferred by operator with the risk noted).
- [ ] IP observations logged; enforcement decision recorded after the window.

## Dependencies

None on other plans (independent). The rotation gate needs operator scheduling.

## Risks / unresolved questions

- The canonical ShipX status ordering must come from InPost docs at implementation time — the rank table is the one place correctness depends on external documentation.
- If InPost has since added webhook signatures for ShipX org webhooks, prefer implementing signature verification over the IP check (supersedes that half of Task 3) — check first.
