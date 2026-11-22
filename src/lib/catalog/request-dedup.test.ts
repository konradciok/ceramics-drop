import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Use React's real server cache implementation; supply the per-render cache
// dispatcher normally installed by the RSC renderer, without a Next server.
vi.mock('react', () => {
  const require = createRequire(import.meta.url);
  return require(join(dirname(require.resolve('react')), 'react.react-server.js'));
});
vi.mock('./load', () => ({
  loadCeramicProductsFromDb: vi.fn(),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import * as React from 'react';
import * as Sentry from '@sentry/nextjs';
import { getProductById, getProducts, resolveKnownProducts } from '../products';
import { loadCeramicProductsFromDb } from './load';

type Dispatcher = { getCacheForType: (factory: () => unknown) => unknown };
const internals = (React as unknown as {
  __SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { A: Dispatcher | null };
}).__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

function newRender() {
  const entries = new Map<() => unknown, unknown>();
  internals.A = {
    getCacheForType(factory) {
      if (!entries.has(factory)) entries.set(factory, factory());
      return entries.get(factory);
    },
  };
  vi.stubEnv('CATALOG_SOURCE', 'db');
}

afterEach(() => {
  internals.A = null;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('request-scoped catalog reads', () => {
  it('shares concurrent and sequential reads across accessors; retries in a new render', async () => {
    vi.mocked(loadCeramicProductsFromDb).mockResolvedValue([]);
    for (let render = 1; render <= 2; render++) {
      newRender();
      await Promise.all([getProducts(), resolveKnownProducts(['k01']), getProductById('k02')]);
      await getProducts();
      await getProductById('k03');
      expect(loadCeramicProductsFromDb).toHaveBeenCalledTimes(render);
    }
  });

  it('shares a failed read and its report, then recovers on the next render', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(loadCeramicProductsFromDb).mockRejectedValueOnce(new Error('timeout')).mockResolvedValue([]);
    newRender();
    await Promise.all([getProducts(), getProductById('k01')]);
    await getProducts();
    expect(loadCeramicProductsFromDb).toHaveBeenCalledOnce();
    expect(Sentry.captureException).toHaveBeenCalledOnce();
    newRender();
    await expect(getProducts()).resolves.toEqual([]);
    expect(loadCeramicProductsFromDb).toHaveBeenCalledTimes(2);
  });
});
