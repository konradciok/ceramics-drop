import type { IncrementalCache } from '@opennextjs/aws/types/overrides.js';
import staticAssetsIncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache';

/**
 * The upstream static-assets cache is read-only by design, but its `set()` /
 * `delete()` log an error() on EVERY dropped write — thousands of log events
 * per day that count against the Workers Logs quota. Writes being dropped is
 * the expected behavior here (no revalidation persistence), so this wrapper
 * keeps the reads and swallows the write-path logging.
 */
const quietStaticAssetsIncrementalCache: IncrementalCache = {
  name: staticAssetsIncrementalCache.name,
  get: (key, cacheType) => staticAssetsIncrementalCache.get(key, cacheType),
  set: async () => {},
  delete: async () => {},
};

export default quietStaticAssetsIncrementalCache;
