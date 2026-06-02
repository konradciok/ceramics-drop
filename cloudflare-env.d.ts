/* eslint-disable */
// Workers bindings from wrangler.jsonc. After changing bindings, run `npm run cf-typegen`.

interface CloudflareEnv {
  ASSETS: Fetcher;
  WORKER_SELF_REFERENCE: Service<typeof import('./.open-next/worker').default>;
}

declare namespace Cloudflare {
  interface Env extends CloudflareEnv {}
}
