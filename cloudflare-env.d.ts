/* eslint-disable */
// Workers bindings from wrangler.jsonc + secrets. After changing bindings, run `npm run cf-typegen`.

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
}

declare namespace Cloudflare {
  interface Env extends CloudflareEnv {}
}
