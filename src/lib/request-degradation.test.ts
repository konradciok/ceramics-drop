import { describe, it, expect } from 'vitest';
import {
  applyCatalogDegradation,
  DEGRADED_RETRY_AFTER_SECONDS,
  markCeramicCatalogColdFailClosed,
  type RequestDegradation,
} from './request-degradation';
import { runWithRequestDegradation } from './request-degradation-scope';

const COLD: RequestDegradation = { ceramicCatalogColdFailClosed: true };
const WARM: RequestDegradation = { ceramicCatalogColdFailClosed: false };

/** A storefront request for `path`. */
function req(path: string, method = 'GET'): Request {
  return new Request(`https://anna-ciok.studio${path}`, { method });
}

describe('request degradation scope', () => {
  it('marking outside a scope is a harmless no-op', () => {
    expect(() => markCeramicCatalogColdFailClosed()).not.toThrow();
  });

  it('a mark inside the scope (across awaits) flags only that request', async () => {
    const flagged = await runWithRequestDegradation(async (state) => {
      await Promise.resolve();
      markCeramicCatalogColdFailClosed();
      return state;
    });
    const untouched = await runWithRequestDegradation(async (state) => state);
    expect(flagged.ceramicCatalogColdFailClosed).toBe(true);
    expect(untouched.ceramicCatalogColdFailClosed).toBe(false);
  });

  it('keeps concurrent requests isolated', async () => {
    const [a, b] = await Promise.all([
      runWithRequestDegradation(async (state) => {
        await new Promise((r) => setTimeout(r, 5));
        markCeramicCatalogColdFailClosed();
        return state;
      }),
      runWithRequestDegradation(async (state) => {
        await new Promise((r) => setTimeout(r, 10));
        return state;
      }),
    ]);
    expect(a.ceramicCatalogColdFailClosed).toBe(true);
    expect(b.ceramicCatalogColdFailClosed).toBe(false);
  });
});

describe('applyCatalogDegradation', () => {
  it('turns a cold-fail-closed PDP 404 into 503 + Retry-After, never cached', async () => {
    const res = applyCatalogDegradation(req('/de/talerzyki/t11'), new Response('nf', { status: 404 }), COLD);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe(String(DEGRADED_RETRY_AFTER_SECONDS));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).toContain('Chwilowo niedostępne');
  });

  it('turns a cold-fail-closed sitemap into 503 even though it rendered 200', () => {
    const res = applyCatalogDegradation(req('/sitemap.xml'), new Response('<urlset/>', { status: 200 }), COLD);
    expect(res.status).toBe(503);
  });

  it('answers HEAD with an empty 503', async () => {
    const res = applyCatalogDegradation(req('/kubki/k01', 'HEAD'), new Response(null, { status: 404 }), COLD);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('');
  });

  it('leaves a page that still rendered (200) untouched', () => {
    const original = new Response('ok', { status: 200 });
    expect(applyCatalogDegradation(req('/kubki'), original, COLD)).toBe(original);
  });

  it('leaves a genuine 404 untouched when the catalogue was healthy', () => {
    const original = new Response('nf', { status: 404 });
    expect(applyCatalogDegradation(req('/kubki/k999'), original, WARM)).toBe(original);
    expect(applyCatalogDegradation(req('/kubki/k999'), original, undefined)).toBe(original);
  });

  it('never rewrites non-GET/HEAD responses', () => {
    const original = new Response('nf', { status: 404 });
    expect(applyCatalogDegradation(req('/api/checkout', 'POST'), original, COLD)).toBe(original);
  });
});
