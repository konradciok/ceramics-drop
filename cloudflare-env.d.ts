/* eslint-disable */
// Workers bindings from wrangler.jsonc + secrets. After changing bindings, run `npm run cf-typegen`.
// Binding shapes (Queue, R2Bucket, Fetcher, Service) resolve via cloudflare-bindings.d.ts;
// handler/runtime types for worker.ts use @cloudflare/workers-types via tsconfig.worker.json.

/** Minimal Workers ExecutionContext — matches the runtime shape, usable in Next.js server code. */
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/**
 * The exact slice of the PRINT_ASSET_PROCESSOR Durable Object namespace this
 * codebase uses. Hand-written (rather than `DurableObjectNamespace<...>`)
 * because this file is shared by BOTH tsconfigs: the app build resolves binding
 * shapes from cloudflare-bindings.d.ts, which has no DO types, while
 * tsconfig.worker.json resolves them from @cloudflare/workers-types, whose
 * generic `DurableObjectNamespace<T>` constrains T to an RPC-branded class. A
 * plain structural interface is the one shape both accept.
 */
interface PrintAssetProcessorStub {
  renderDerivative(
    input: import('./src/server/asset-jobs/container-render').RenderInput,
  ): Promise<import('./src/server/asset-jobs/container-render').RenderResult>;
}

interface PrintAssetProcessorNamespace {
  getByName(name: string): PrintAssetProcessorStub;
}

interface CloudflareEnv {
  ASSETS: Fetcher;
  WORKER_SELF_REFERENCE: Service<typeof import('./.open-next/worker').default>;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  /** Stripe Payment Method Configuration id; live and sandbox can differ. */
  STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Customer accounts (Supabase Auth) — publishable/anon key, server-side only
   *  (never NEXT_PUBLIC_*). Optional on purpose: its PRESENCE is the feature
   *  flag (unset ⇒ auth routes 404, /konto renders "unavailable", middleware
   *  and checkout skip session work — fail-closed kill switch). */
  SUPABASE_PUBLISHABLE_KEY?: string;
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
  // Print-asset processing job queue (Priority 8 / Phase 2 — durable job
  // queue). Mirrors FULFILMENT_QUEUE's binding shape; see wrangler.jsonc's
  // ASSET_JOBS_QUEUE producer/consumer/DLQ declarations and
  // src/server/asset-jobs/{enqueue,process-job}.ts.
  ASSET_JOBS_QUEUE: Queue;
  /**
   * Priority 8 / Phase 3 — the Cloudflare Container (Node/Sharp) that turns a
   * confirmed upload into print derivatives. A Container is addressed through
   * its backing Durable Object namespace, so this is a DO binding rather than a
   * bespoke "container" binding (see wrangler.jsonc's `containers` +
   * `durable_objects` pair). Optional on purpose — same fail-closed posture as
   * the R2_S3_* secrets: a deployment without it fails the job as
   * `failed_action_required` with an explicit message rather than crashing the
   * queue consumer.
   */
  PRINT_ASSET_PROCESSOR?: PrintAssetProcessorNamespace;
  PRODIGI_API_KEY_SANDBOX: string;
  PRODIGI_API_KEY_LIVE: string;
  PRODIGI_ENV: string;
  /** Rehearsal-only sandbox base-URL override (failure injection, Plan 05).
   *  Ignored whenever PRODIGI_ENV is 'live' — can never redirect production traffic. */
  PRODIGI_API_BASE_URL?: string;
  PRODIGI_CALLBACK_TOKEN: string;
  PRINT_ASSET_TOKEN_SECRET: string;
  PRODIGI_DEFAULT_SHIPPING_METHOD: string;
  // R2 S3-compatible API credentials for Worker-side presigned PUT URLs
  // (POST /v1/uploads — src/server/cms-api/uploads-mapping.ts). Same three
  // values scripts/lib/r2.ts's resolveR2ConditionalCredentials already reads
  // for the CLI upload operator (R2_S3_ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY)
  // — deliberately the same names so a `.dev.vars` already set up for those
  // scripts (which `wrangler dev` also reads into this env) works here too.
  // Optional: uploads-create.ts fails closed (500) rather than crash the
  // Worker when unset, same posture as the STUDIO_RETURN_*/NEWSLETTER_CONFIRM_SECRET
  // fail-closed optional secrets above.
  R2_S3_ACCOUNT_ID?: string;
  R2_S3_ACCESS_KEY_ID?: string;
  R2_S3_SECRET_ACCESS_KEY?: string;
  // CMS preview-token HMAC secret (admin draft preview links). Dedicated, fail-closed.
  CMS_PREVIEW_SECRET: string;
  // Newsletter double-opt-in HMAC secret (confirm-link tokens). Dedicated, fail-closed:
  // POST /api/newsletter and GET /api/newsletter/confirm return 503 when unset.
  NEWSLETTER_CONFIRM_SECRET: string;
  /** Optional legacy Resend Audience id — when set, confirmed contacts POST to
   *  /audiences/{id}/contacts instead of the global /contacts endpoint. */
  RESEND_NEWSLETTER_AUDIENCE_ID?: string;
  // Fail-closed debug read for the destructive print-purchase E2E (audit H-2):
  // GET /api/debug/fulfilment-status returns 404 unless this is set. Preview-only.
  FULFILMENT_DEBUG_TOKEN?: string;
  // Cloudflare Access — admin route protection (worker.ts auth guard + src/lib/admin/access.ts).
  // CF_ACCESS_TEAM_DOMAIN: full issuer origin, e.g. https://<team>.cloudflareaccess.com
  // CF_ACCESS_AUD: Application Audience tag from the Access application settings.
  // ADMIN_ALLOWED_EMAILS: optional comma-separated allowlist for defense in depth.
  // STUDIO_ADMIN_LOCAL_BYPASS: set to "true" only for local dev — NEVER in production.
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  ADMIN_ALLOWED_EMAILS?: string;
  STUDIO_ADMIN_LOCAL_BYPASS?: string;
  CMS_ACCESS_TEAM_DOMAIN?: string;
  CMS_ACCESS_AUD?: string;
  CMS_OWNERS?: string;
  CMS_API_LOCAL_BYPASS?: string;
  CMS_API_ENVIRONMENT?: string;
  /** Storefront catalogue source — 'db' reads shadow tables; omit or any other value => code registry. */
  CATALOG_SOURCE?: string;
  /** Optional public origin override for non-production Workers (e.g. staging). Falls back to SITE_URL. */
  WORKER_ORIGIN?: string;
}

declare namespace Cloudflare {
  interface Env extends CloudflareEnv {}
}
