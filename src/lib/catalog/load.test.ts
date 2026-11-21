import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSupabaseAdmin: vi.fn(() => ({ kind: 'local-test-client' })),
  readCeramicProducts: vi.fn(),
}));

vi.mock('../supabase', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));
vi.mock('./repository', () => ({
  readCeramicProducts: mocks.readCeramicProducts,
}));

type RuntimeWithIncrementalCache = typeof globalThis & {
  __incrementalCache?: unknown;
  AsyncLocalStorage?: typeof AsyncLocalStorage;
};

const runtime = globalThis as RuntimeWithIncrementalCache;
const priorAsyncLocalStorage = runtime.AsyncLocalStorage;

beforeAll(() => {
  // Next installs this global in its Node/Workers runtime bootstrap. Vitest
  // does not, so install the same Node primitive before dynamically importing
  // next/cache through the production loader modules.
  runtime.AsyncLocalStorage = AsyncLocalStorage;
});

afterAll(() => {
  if (priorAsyncLocalStorage) runtime.AsyncLocalStorage = priorAsyncLocalStorage;
  else Reflect.deleteProperty(runtime, 'AsyncLocalStorage');
});

/**
 * Exercise Next's real unstable_cache implementation with a persistent cache
 * boundary. This is deliberately not a next/cache mock: a cached loader will
 * return the first value, while a direct DB loader observes the second value.
 */
function installPersistentNextDataCache(): void {
  const entries = new Map<string, unknown>();
  runtime.__incrementalCache = {
    isOnDemandRevalidate: false,
    generateCacheKey: async (key: string) => key,
    get: async (key: string) => {
      const value = entries.get(key);
      return value === undefined ? null : { value, isStale: false };
    },
    set: async (key: string, value: unknown) => {
      entries.set(key, value);
    },
  };
}

afterEach(() => {
  delete runtime.__incrementalCache;
  vi.clearAllMocks();
});

describe('database catalog loader freshness', () => {
  it('observes product repository changes on the next call', async () => {
    const { loadCeramicProductsFromDb } = await import('./load');
    installPersistentNextDataCache();
    mocks.readCeramicProducts
      .mockResolvedValueOnce([{ id: 'ceramic-before' }])
      .mockResolvedValueOnce([{ id: 'ceramic-after' }]);

    expect(await loadCeramicProductsFromDb()).toEqual([{ id: 'ceramic-before' }]);
    expect(await loadCeramicProductsFromDb()).toEqual([{ id: 'ceramic-after' }]);
  });
});
