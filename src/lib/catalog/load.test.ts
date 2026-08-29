import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSupabaseAdmin: vi.fn(() => ({ kind: 'local-test-client' })),
  readCeramicProducts: vi.fn(),
  readPrintDesigns: vi.fn(),
  readPrintPricingConfig: vi.fn(),
}));

vi.mock('../supabase', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));
vi.mock('./repository', () => ({
  readCeramicProducts: mocks.readCeramicProducts,
  readPrintDesigns: mocks.readPrintDesigns,
}));
vi.mock('../print-pricing-config/repository', () => ({
  readPrintPricingConfig: mocks.readPrintPricingConfig,
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
  it('observes product and print repository changes on the next call', async () => {
    const { loadCeramicProductsFromDb, loadPrintDesignsFromDb } = await import('./load');
    installPersistentNextDataCache();
    mocks.readCeramicProducts
      .mockResolvedValueOnce([{ id: 'ceramic-before' }])
      .mockResolvedValueOnce([{ id: 'ceramic-after' }]);
    mocks.readPrintDesigns
      .mockResolvedValueOnce([{ id: 'print-before' }])
      .mockResolvedValueOnce([{ id: 'print-after' }]);

    expect(await loadCeramicProductsFromDb()).toEqual([{ id: 'ceramic-before' }]);
    expect(await loadPrintDesignsFromDb()).toEqual([{ id: 'print-before' }]);
    expect(await loadCeramicProductsFromDb()).toEqual([{ id: 'ceramic-after' }]);
    expect(await loadPrintDesignsFromDb()).toEqual([{ id: 'print-after' }]);
  });

  it('observes print-pricing changes on the next call', async () => {
    const { loadPrintPricingConfigFromDb } = await import('../print-pricing-config/load');
    installPersistentNextDataCache();
    mocks.readPrintPricingConfig
      .mockResolvedValueOnce({ revision: 'before' })
      .mockResolvedValueOnce({ revision: 'after' });

    expect(await loadPrintPricingConfigFromDb()).toEqual({ revision: 'before' });
    expect(await loadPrintPricingConfigFromDb()).toEqual({ revision: 'after' });
  });
});
