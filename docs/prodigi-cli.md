# Prodigi CLI operations

The repository CLI provides a deterministic JSON interface to the supported Prodigi API v4 operations. It uses the sandbox unless `--live` is explicit; creating an order in live is intentionally unsupported. Prodigi's [API reference](https://www.prodigi.com/print-api/docs/reference/) remains the source of truth for product-specific SKUs, attributes, assets, and shipping methods.

## Usage

```bash
npm run prodigi -- [--live] [--env-file PATH] [--show-pii] [--compact] <resource> <action>
```

```text
product get <sku>
product spine --file <path|->
quote create --file <path|->
order create --file <path|->
order get <ord_id>
order list [--top N] [--skip N] [--created-from ISO] [--created-to ISO]
           [--status STATUS] [--order-id ID...] [--merchant-reference REF...]
order actions <ord_id>
order cancel <ord_id>
order update-shipping <ord_id> --method METHOD
order update-recipient <ord_id> --file <path|->
order update-metadata <ord_id> --file <path|-> --replace-metadata
```

Use `--file -` to read exactly one JSON document from stdin:

```bash
printf '%s\n' '{"sku":"BOOK-A4-L-HARD-M","destinationCountryCode":"PL","numberOfPages":50}' \
  | npm run prodigi -- product spine --file -
```

Global options may appear before the resource. `--compact` prints single-line JSON. Order responses redact recipient name, email, phone number, and address by default; use `--show-pii` only when full personal data is operationally necessary.

## Environment and credentials

The CLI loads variables in this order, with later sources overriding earlier ones:

1. `.env.local`
2. `.dev.vars`
3. the file passed with `--env-file PATH`
4. the existing process environment

Only the key for the selected environment is required:

```dotenv
PRODIGI_API_KEY_SANDBOX=...
PRODIGI_API_KEY_LIVE=...
```

The default is sandbox. `PRODIGI_ENV` is ignored by this CLI so a storefront runtime setting cannot silently select live. API keys are never included in output.

## Payloads

Quote, order, and spine files contain the complete API request body. Recipient updates use the recipient object directly, without a `recipient` wrapper. Metadata updates use the API wrapper `{ "metadata": { ... } }` and also require `--replace-metadata` because Prodigi replaces all existing metadata.

Example `quote.json`:

```json
{
  "shippingMethod": "Budget",
  "destinationCountryCode": "PL",
  "currencyCode": "EUR",
  "items": [
    {
      "sku": "GLOBAL-FAP-12X16",
      "copies": 1,
      "attributes": {},
      "assets": [{ "printArea": "default" }]
    }
  ]
}
```

```bash
npm run prodigi -- quote create --file quote.json
```

Example sandbox-only `order.json`:

```json
{
  "idempotencyKey": "manual-smoke-20260711-001",
  "merchantReference": "manual-smoke-20260711-001",
  "shippingMethod": "Budget",
  "recipient": {
    "name": "Sandbox Recipient",
    "email": "sandbox@example.invalid",
    "phoneNumber": "+48111111111",
    "address": {
      "line1": "1 Test Street",
      "postalOrZipCode": "00-001",
      "countryCode": "PL",
      "townOrCity": "Warsaw"
    }
  },
  "items": [
    {
      "sku": "GLOBAL-FAP-12X16",
      "copies": 1,
      "sizing": "fillPrintArea",
      "attributes": {},
      "assets": [
        {
          "printArea": "default",
          "url": "https://example.invalid/test-print.jpg"
        }
      ]
    }
  ],
  "metadata": { "purpose": "manual-sandbox-smoke" }
}
```

Every `order create` payload must contain non-empty `idempotencyKey` and `merchantReference` values. Re-running a request should reuse its key only when deliberately testing Prodigi's idempotency behavior.

Example `recipient.json`:

```json
{
  "name": "Updated Sandbox Recipient",
  "email": "sandbox-updated@example.invalid",
  "phoneNumber": "+48222222222",
  "address": {
    "line1": "2 Test Street",
    "postalOrZipCode": "00-002",
    "countryCode": "PL",
    "townOrCity": "Warsaw"
  }
}
```

Example `metadata.json`:

```json
{
  "metadata": {
    "purpose": "manual-sandbox-smoke",
    "operatorNote": "replacement metadata"
  }
}
```

```bash
npm run prodigi -- order update-recipient ord_123456 --file recipient.json
npm run prodigi -- order update-metadata ord_123456 --file metadata.json --replace-metadata
```

## Live safety rules

- Live is selected only with `--live`; `PRODIGI_ENV` has no effect.
- `order create` is always blocked in live. Production orders must continue through the storefront and Cloudflare Queue fulfilment pipeline.
- Live `order cancel`, `order update-shipping`, `order update-recipient`, and `order update-metadata` require `--confirm-live <ord_id>`. The confirmation must exactly match the target order ID.
- Inspect `order actions <ord_id>` immediately before a mutation. Prodigi may stop allowing an action after fulfilment starts.
- Prefer the default PII redaction. Never paste `--show-pii` output into tickets, chat, or logs.

Example deliberate live update:

```bash
npm run prodigi -- --live order update-shipping ord_123456 \
  --method Express --confirm-live ord_123456
```

## Output and exit codes

Success is written to stdout; errors are JSON written to stderr. Pretty JSON is the default.

```json
{
  "ok": true,
  "environment": "sandbox",
  "data": {}
}
```

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Internal CLI error |
| `2` | Invalid arguments, JSON, or payload |
| `3` | Missing configuration or safety guard failure |
| `4` | HTTP or network failure |
| `5` | Unsuccessful or partial Prodigi `outcome` |

Do not treat HTTP 200 alone as success. The CLI interprets Prodigi's `outcome`; results such as `CreatedWithIssues`, `PartiallyUpdated`, `FailedToUpdate`, and `ActionNotAvailable` exit with code `5` while retaining the response in error JSON. Network and retryable server errors still exit with code `4`.

## Manual sandbox smoke test

This procedure makes real sandbox API requests and is deliberately separate from automated tests. It never creates a live order.

1. Export `PRODIGI_API_KEY_SANDBOX`, or place it in an environment file. Do not set `--live`.
2. Select a published SKU and its required attributes with `npm run prodigi -- product get <sku>`.
3. Copy `quote.json` above, replace the illustrative SKU with the verified SKU, and run `npm run prodigi -- quote create --file quote.json`. Expect exit `0`, `environment: "sandbox"`, and at least one quote.
4. Prepare an HTTPS asset URL that Prodigi sandbox can fetch. Copy `order.json`, replace the SKU and asset URL, and give both `idempotencyKey` and `merchantReference` a new unique smoke-test value.
5. Run `npm run prodigi -- order create --file order.json`. Expect exit `0`; record `data.order.id` as `ORD_ID`.
6. Run `npm run prodigi -- order get "$ORD_ID"`, `npm run prodigi -- order list --order-id "$ORD_ID"`, and `npm run prodigi -- order actions "$ORD_ID"`. Confirm the order appears and output is redacted.
7. While the actions response permits changes, run `order update-shipping`, then `order update-recipient` with `recipient.json`, and `order update-metadata` with `metadata.json --replace-metadata`. Fetch the order after each change. Use `--show-pii` only for the recipient verification, then repeat without it to confirm redaction.
8. Run `npm run prodigi -- order cancel "$ORD_ID"`, then fetch the order again and confirm its cancelled outcome/status. If the action is no longer available, exit `5` is the expected safety signal; record the returned outcome.
9. Record the CLI version/commit, SKU, merchant reference, Prodigi order ID, commands, exit codes, and redacted results in the release note. Delete temporary payloads if they contain personal data.

Automated unit tests mock `fetch` and must not perform real Prodigi requests. Run the repository gates separately:

```bash
npm test
npm run lint
npm run typecheck
```
