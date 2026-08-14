import { afterEach, describe, expect, it, vi } from 'vitest';
import staticAssetsIncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache';
import quietStaticAssetsIncrementalCache from './quiet-static-assets-incremental-cache';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('quietStaticAssetsIncrementalCache', () => {
  it('set() is a silent no-op — no console.error per dropped write', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      quietStaticAssetsIncrementalCache.set('/pl', { type: 'route', body: '' } as never, 'cache'),
    ).resolves.toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('delete() is a silent no-op — no console.error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(quietStaticAssetsIncrementalCache.delete('/pl')).resolves.toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('get() delegates to the upstream static-assets cache', async () => {
    const sentinel = { value: { type: 'route' }, lastModified: 1 };
    const getSpy = vi
      .spyOn(staticAssetsIncrementalCache, 'get')
      .mockResolvedValue(sentinel as never);
    await expect(quietStaticAssetsIncrementalCache.get('some-key', 'fetch')).resolves.toBe(sentinel);
    expect(getSpy).toHaveBeenCalledWith('some-key', 'fetch');
  });

  it('keeps the upstream cache name so OpenNext identifies the same implementation', () => {
    expect(quietStaticAssetsIncrementalCache.name).toBe(staticAssetsIncrementalCache.name);
  });
});

describe('open-next.config wiring', () => {
  it('resolves the incremental cache to the quiet wrapper', async () => {
    const config = (await import('../../../open-next.config')).default;
    const resolve = config.default?.override?.incrementalCache;
    expect(typeof resolve).toBe('function');
    const cache = await (resolve as () => unknown | Promise<unknown>)();
    expect(cache).toBe(quietStaticAssetsIncrementalCache);
  });
});
