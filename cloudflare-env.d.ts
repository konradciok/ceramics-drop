/* eslint-disable */
// Workers bindings from wrangler.jsonc + secrets. After changing bindings, run `npm run cf-typegen`.

interface CloudflareEnv {
  ASSETS: Fetcher;
  WORKER_SELF_REFERENCE: Service<typeof import('./.open-next/worker').default>;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

declare namespace Cloudflare {
  interface Env extends CloudflareEnv {}
}
