import { defineCloudflareConfig } from '@opennextjs/cloudflare';
// Relative import (no `@/` alias) — this file is bundled by OpenNext's own
// esbuild config, which doesn't know the app tsconfig paths.
import quietStaticAssetsIncrementalCache from './src/server/cache/quiet-static-assets-incremental-cache';

export default defineCloudflareConfig({
  incrementalCache: quietStaticAssetsIncrementalCache,
  enableCacheInterception: true,
});
