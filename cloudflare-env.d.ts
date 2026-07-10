/* eslint-disable */
// Workers bindings from wrangler.jsonc + secrets. After changing bindings, run `npm run cf-typegen`.
// Binding shapes (Queue, R2Bucket, Fetcher, Service) resolve via cloudflare-bindings.d.ts;
// handler/runtime types for worker.ts use @cloudflare/workers-types via tsconfig.worker.json.

/** Minimal Workers ExecutionContext — matches the runtime shape, usable in Next.js server code. */
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface CloudflareEnv {
  ASSETS: Fetcher;
  WORKER_SELF_REFERENCE: Service<typeof import('./.open-next/worker').default>;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  // InPost ShipX (sole delivery provider). API base + Bearer token + organization
  // from Manager Paczek; INPOST_WEBHOOK_TOKEN is a shared secret guarding the
  // inbound shipment-status callback we register there.
  INPOST_API_URL: string;
  INPOST_API_TOKEN: string;
  INPOST_ORGANIZATION_ID: string;
  INPOST_WEBHOOK_TOKEN: string;
  // Transactional email for the shipping label (Resend). STUDIO_NOTIFY_EMAIL is
  // where the printable A6 label PDF is sent once a shipment is confirmed.
  RESEND_API_KEY: string;
  STUDIO_NOTIFY_EMAIL: string;
  /** Svix signing secret for the Resend delivery/bounce/complaint webhook. */
  RESEND_WEBHOOK_SECRET: string;
  // Studio return address — used as the receiver on InPost return shipments.
  // All fields required to enable POST /api/returns; endpoint returns 503 if any are missing.
  STUDIO_RETURN_FIRST_NAME?: string;
  STUDIO_RETURN_LAST_NAME?: string;
  /** Defaults to STUDIO_NOTIFY_EMAIL when unset. */
  STUDIO_RETURN_EMAIL?: string;
  STUDIO_RETURN_PHONE?: string;
  STUDIO_RETURN_ADDRESS_STREET?: string;
  STUDIO_RETURN_ADDRESS_BUILDING?: string;
  STUDIO_RETURN_ADDRESS_CITY?: string;
  STUDIO_RETURN_ADDRESS_POSTAL?: string;
  /** Optional: paczkomat code pre-assigned as the return drop-off target (e.g. KRA010). */
  STUDIO_RETURN_POINT?: string;
  // Server-side conversions (Meta CAPI + GA4 Measurement Protocol).
  META_CAPI_ACCESS_TOKEN?: string;
  META_TEST_EVENT_CODE?: string;
  GA4_API_SECRET?: string;
  // Sentry (optional; server runtime falls back to NEXT_PUBLIC_SENTRY_DSN from the build).
  SENTRY_DSN?: string;
  // Prodigi Print-on-Demand — CF Queue, R2 bucket, and API secrets.
  FULFILMENT_QUEUE: Queue;
  PRINT_ASSETS: R2Bucket;
  PRODIGI_API_KEY_SANDBOX: string;
  PRODIGI_API_KEY_LIVE: string;
  PRODIGI_ENV: string;
  PRODIGI_CALLBACK_TOKEN: string;
  PRINT_ASSET_TOKEN_SECRET: string;
  PRODIGI_DEFAULT_SHIPPING_METHOD: string;
  // CMS preview-token HMAC secret (admin draft preview links). Dedicated, fail-closed.
  CMS_PREVIEW_SECRET: string;
  // Cloudflare Access — admin route protection (worker.ts auth guard + src/lib/admin/access.ts).
  // CF_ACCESS_TEAM_DOMAIN: full issuer origin, e.g. https://<team>.cloudflareaccess.com
  // CF_ACCESS_AUD: Application Audience tag from the Access application settings.
  // ADMIN_ALLOWED_EMAILS: optional comma-separated allowlist for defense in depth.
  // STUDIO_ADMIN_LOCAL_BYPASS: set to "true" only for local dev — NEVER in production.
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  ADMIN_ALLOWED_EMAILS?: string;
  STUDIO_ADMIN_LOCAL_BYPASS?: string;
  /** Storefront catalogue source — 'db' reads shadow tables; omit or any other value => code registry. */
  CATALOG_SOURCE?: string;
}

declare namespace Cloudflare {
  interface Env extends CloudflareEnv {}
}
