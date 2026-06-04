/* eslint-disable */
// Workers bindings from wrangler.jsonc + secrets. After changing bindings, run `npm run cf-typegen`.

interface CloudflareEnv {
  ASSETS: Fetcher;
  WORKER_SELF_REFERENCE: Service<typeof import('./.open-next/worker').default>;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  /** Signing secret for the thin event destination (/api/stripe/webhook-thin). */
  STRIPE_WEBHOOK_THIN_SECRET: string;
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
  // Sentry (optional; server runtime falls back to NEXT_PUBLIC_SENTRY_DSN from the build).
  SENTRY_DSN?: string;
}

declare namespace Cloudflare {
  interface Env extends CloudflareEnv {}
}
