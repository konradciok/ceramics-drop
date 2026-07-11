# Orders CLI operations

`npm run orders` inspects order/inventory/fulfilment state and, once confirmed, performs the same mutations the [`/admin`](../src/app/admin) UI exposes (refund, release-reservation, create-shipment, resend-confirmation) — so agents/operators don't need raw SQL or the Cloudflare-Access-gated admin UI for routine order debugging. It reuses the same extracted functions the four `/api/admin/*` routes call (`src/lib/admin/actions.ts`), so behavior never drifts between the UI and the CLI.

## Usage

```bash
npm run orders -- [--env-file PATH] [--show-pii] [--compact] [--allow-nonprod] <resource> <action>
```

```text
order get <uuid>
order list [--status STATUS] [--email EMAIL] [--top N]
inventory list [--status STATUS]
order refund <uuid> --confirm <uuid>
order release-reservation <uuid> --confirm <uuid>
order resend-confirmation <uuid> --confirm <uuid>
order create-shipment <uuid> [--recreate] --confirm <uuid>
```

`--compact` prints single-line JSON. Output is redacted (email, name, phone, address) by default; use `--show-pii` only when full personal data is operationally necessary.

## Environment and credentials

The CLI loads variables in this order, with later sources overriding earlier ones:

1. `.env.local`
2. `.dev.vars`
3. the file passed with `--env-file PATH`
4. the existing process environment

Required keys (same names the storefront/webhook use):

```dotenv
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
STRIPE_SECRET_KEY=...          # order get / order refund / order release-reservation
INPOST_API_URL=...             # order create-shipment
INPOST_API_TOKEN=...
INPOST_ORGANIZATION_ID=...
RESEND_API_KEY=...             # order resend-confirmation (checked inside emailOrderConfirmationToCustomer)
PRODIGI_API_KEY_SANDBOX=...    # order refund, only when the order has print line items (cancelPrintFulfilment)
PRODIGI_API_KEY_LIVE=...
PRODIGI_ENV=...
```

`order refund` on a print order is best-effort against Prodigi: a missing/invalid `PRODIGI_*` key (or any other Prodigi/DB/email hiccup) never fails the refund itself — the Stripe refund has already happened by that point — but it does surface in the response as `printFulfilment: "best_effort_failed"` (see Mutations below) and is captured in Sentry. Set the Prodigi keys before refunding a print order so cancellation isn't silently skipped.

The local-admin `ADMIN_SUPABASE_URL` / `ADMIN_SUPABASE_SERVICE_ROLE_KEY` / `ADMIN_STRIPE_SECRET_KEY` overrides (see `src/lib/admin/clients.ts`) are honored with the same precedence as the admin UI, so a `.dev.vars` already set up for local-admin-against-production needs no changes.

## Reads

- `order get <uuid>` — merges the order + its line items, the matching `piece_state` rows for ceramic items, `prodigi_orders`/`fulfilment_jobs` rows for print items, and a Stripe PaymentIntent summary (status, card brand/last4, refunded amount).
- `order list [--status STATUS] [--email EMAIL] [--top N]` — thin wrapper on `listOrders()`. `--status` must be one of `pending`, `paid`, `failed`, `expired`, `refunded`.
- `inventory list [--status STATUS]` — wrapper on `listInventory()`. `--status` must be one of `available`, `reserved`, `sold`. Each row's `reservedExpired` flag marks a stuck hold worth investigating.

Reads work against whatever Supabase project the loaded env points at — there is no production-target guard on read-only commands.

## Mutations

Each mutating subcommand requires `--confirm <order-id>` matching the target id **exactly** (mirrors `prodigi-cli`'s `--confirm-live` guard):

```bash
npm run orders -- order refund 3fa2c1de-... --confirm 3fa2c1de-...
```

Mutations are additionally blocked unless the loaded `SUPABASE_URL` resolves to the expected production project ref. Pass `--allow-nonprod` to run a mutation against a different project on purpose (e.g. a scratch/test project) — so a stray `--env-file` can't silently write to (or silently no-op against) the wrong database.

- `order refund <uuid> --confirm <uuid>` — full Stripe refund only (no partial refunds — the `charge.refunded` webhook only relists pieces on a full refund), then stops Prodigi fulfilment for print orders. The response includes `printFulfilment` (`no_print_items` | `cancelled` | `manual_cancel_required` | `best_effort_failed`) — check it after refunding a print order; anything other than `no_print_items`/`cancelled` means Prodigi needs a manual look (already alerted to Sentry/studio email, but worth confirming).
- `order release-reservation <uuid> --confirm <uuid>` — cancels the order's PaymentIntent if still pending, then frees any pieces stuck in `reserved` (private-sale orders return to `sold`, never relisted publicly).
- `order resend-confirmation <uuid> --confirm <uuid>` — re-sends the customer order-confirmation email.
- `order create-shipment <uuid> [--recreate] --confirm <uuid>` — (re)creates the InPost shipment for a paid ceramic order; idempotent unless `--recreate` is passed. Print-only orders are rejected (Prodigi ships those, not InPost).

## Output and exit codes

Success is written to stdout; errors are JSON written to stderr. Pretty JSON is the default.

```json
{
  "ok": true,
  "data": {}
}
```

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Internal CLI error |
| `2` | Invalid arguments |
| `3` | Missing configuration or safety guard failure (`--confirm` missing/mismatched, non-prod target without `--allow-nonprod`, missing env vars) |
| `4` | The underlying action rejected the request (order not found, wrong status, etc.) |
| `5` | An upstream service (Stripe / InPost / Resend) failed |

## Manual read-only smoke test

This procedure makes real Supabase/Stripe requests against whatever project `.dev.vars` points at and is deliberately separate from automated tests. It never runs a mutation.

1. Ensure `.dev.vars` has `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (and `STRIPE_SECRET_KEY` for `order get`).
2. Run `npm run orders -- order list --top 5`. Expect exit `0` and up to 5 orders, newest first.
3. Copy an order id from the previous step and run `npm run orders -- order get "$ORDER_ID"`. Confirm the merged `order` / `pieces` / `prodigiOrders` / `fulfilmentJobs` / `payment` shape, and that `email`/`receiver_first_name`/`receiver_phone`/`shipping_address` are redacted. Re-run with `--show-pii` to confirm they are revealed, then discard the output.
4. Run `npm run orders -- inventory list --status reserved`. Confirm `reservedExpired` correctly flags any stuck holds.
5. Do **not** run a mutation against production as part of this smoke test — that requires a disposable/test order, matching the sandbox smoke-test discipline in `docs/prodigi-cli.md`.

Automated unit tests (`src/lib/admin/actions.test.ts`, `scripts/orders-cli.test.ts`) mock Supabase/Stripe/InPost and must not perform real requests. Run the repository gates separately:

```bash
npm test
npm run lint
npm run typecheck
```
