import { SITE_URL } from './site';

/** Public origin for Worker-generated URLs (signed assets, Prodigi callbacks). */
export function getWorkerOrigin(env: Pick<CloudflareEnv, 'WORKER_ORIGIN'>): string {
  const o = env.WORKER_ORIGIN?.trim();
  return o && o.length > 0 ? o : SITE_URL;
}
