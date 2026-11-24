/* eslint-disable */
// Workers bindings from wrangler.jsonc + secrets. After changing bindings, run `npm run cf-typegen`.
// Binding shapes (R2Bucket, Fetcher, Service) resolve via cloudflare-bindings.d.ts;
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
  // Sendcloud API v3 (InPost Spain lockers/points, shipping from mainland Spain).
  // Optional while no checkout routes to it: an order on the sendcloud channel
  // without them fails closed (SendcloudConfigError not_configured).
  /** Integration public key (Basic-auth username; also browser-safe for the picker). */
  SENDCLOUD_PUBLIC_KEY?: string;
  /** Integration secret key (Basic-auth password). */
  SENDCLOUD_SECRET_KEY?: string;
  /** Dedicated Webhook Signature Key for the Sendcloud-Signature HMAC — never the secret key. */
  SENDCLOUD_WEBHOOK_SIGNATURE_KEY?: string;
  /** `sender_address_id` of the mainland-Spain sender address in the Sendcloud panel. */
  SENDCLOUD_SENDER_ADDRESS_ID?: string;
  /** Override of the API base (default https://panel.sendcloud.sc/api/v3). */
  SENDCLOUD_API_URL?: string;
  // Transactional email for the shipping label (Resend). STUDIO_NOTIFY_EMAIL is
  // where the printable A6 label PDF is sent once a shipment is confirmed.
  RESEND_API_KEY: string;
  STUDIO_NOTIFY_EMAIL: string;
  /** Svix signing secret for the Resend delivery/bounce/complaint webhook. */
  RESEND_WEBHOOK_SECRET: string;
  // Server-side conversions (Meta CAPI + GA4 Measurement Protocol).
  META_CAPI_ACCESS_TOKEN?: string;
  META_TEST_EVENT_CODE?: string;
  GA4_API_SECRET?: string;
  // Sentry (optional; server runtime falls back to NEXT_PUBLIC_SENTRY_DSN from the build).
  SENTRY_DSN?: string;
  // R2 bucket for site media (CMS/admin uploads under `site-media/`, served by
  // /api/media). The binding name predates the print shop's retirement.
  PRINT_ASSETS: R2Bucket;
  // CMS preview-token HMAC secret (admin draft preview links). Dedicated, fail-closed.
  CMS_PREVIEW_SECRET: string;
  // Newsletter double-opt-in HMAC secret (confirm-link tokens). Dedicated, fail-closed:
  // POST /api/newsletter and GET /api/newsletter/confirm return 503 when unset.
  NEWSLETTER_CONFIRM_SECRET: string;
  /** Optional legacy Resend Audience id — when set, confirmed contacts POST to
   *  /audiences/{id}/contacts instead of the global /contacts endpoint. */
  RESEND_NEWSLETTER_AUDIENCE_ID?: string;
  /** Resend Segment id for marketing broadcasts (wrangler.jsonc `vars`). Confirmed
   *  newsletter subscribers and buyers who tick the checkout marketing consent are
   *  added to it. Unset → contacts are still created, just not segmented. */
  RESEND_MARKETING_SEGMENT_ID?: string;
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
