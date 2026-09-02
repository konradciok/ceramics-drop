// Regression coverage for verifyPreviewToken: a crafted/malformed ?preview=
// token must resolve to null, never throw — a throw here 500s every page
// that reads preview content (homepage, print PDPs).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Sentry from '@sentry/nextjs';

const ENV = vi.hoisted(() => ({
  CMS_PREVIEW_SECRET: 'secret_test' as string | undefined,
}));
const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: ENV }),
}));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: mockFrom }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { mintPreviewToken, verifyPreviewToken, getPublishedContent } from './server';
import { registryPrintDesigns } from '@/lib/prints';

/** A thenable chain where every builder returns the chain; resolves to `result`.
 *  Mirrors the idiom in src/lib/catalog/repository.test.ts. */
function makeChain(result: unknown): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'abortSignal']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain['maybeSingle'] = vi.fn().mockResolvedValue(result);
  return chain;
}

describe('getPublishedContent — Supabase error reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('reports a real Supabase error to Sentry before returning null', async () => {
    const error = { message: 'boom' };
    mockFrom.mockReturnValue(makeChain({ data: null, error }));
    await expect(getPublishedContent('page', 'home', 'en')).resolves.toBeNull();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ tags: { cms: 'getPublishedContent' } }),
    );
  });

  it('stays silent (no Sentry) when there is simply no published row', async () => {
    mockFrom.mockReturnValue(makeChain({ data: null, error: null }));
    await expect(getPublishedContent('page', 'home', 'en')).resolves.toBeNull();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('getPublishedContent — product notes read leniency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns the live notes minus stale ids instead of null when the published payload carries a retired design', async () => {
    const ids = registryPrintDesigns().map((d) => d.id);
    const notes = Object.fromEntries(ids.map((id) => [id, `Opis ${id}`]));
    const payload = { notes: { ...notes, 'fap-stale': 'Opis' } };
    mockFrom.mockReturnValue(makeChain({ data: { id: 'doc', cms_document_versions: [{ payload }] }, error: null }));
    const result = await getPublishedContent<{ notes: Record<string, string> }>('product_notes', 'fine-art-prints', 'es');
    expect(result).not.toBeNull();
    expect(Object.keys(result!.notes).sort()).toEqual([...ids].sort());
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('verifyPreviewToken', () => {
  beforeEach(() => {
    ENV.CMS_PREVIEW_SECRET = 'secret_test';
  });

  it('round-trips a token minted by mintPreviewToken', async () => {
    const token = await mintPreviewToken({ kind: 'page', slug: 'home', locale: 'en', version: 1 });
    const parsed = await verifyPreviewToken(token);
    expect(parsed).toEqual({ kind: 'page', slug: 'home', locale: 'en', version: 1, exp: expect.any(Number) });
  });

  it('returns null for null/undefined/empty input', async () => {
    await expect(verifyPreviewToken(null)).resolves.toBeNull();
    await expect(verifyPreviewToken(undefined)).resolves.toBeNull();
    await expect(verifyPreviewToken('')).resolves.toBeNull();
  });

  it('returns null (not a throw) for a token missing the signature segment', async () => {
    await expect(verifyPreviewToken('a.x'.split('.')[0])).resolves.toBeNull();
    // No dot at all — split() yields a single element, so `signature` is undefined.
    await expect(verifyPreviewToken('nodothere')).resolves.toBeNull();
  });

  it('returns null (not a throw) for a signature segment with invalid base64url characters', async () => {
    // '!!!' is not valid base64url and previously made fromBase64Url's atob()
    // throw InvalidCharacterError outside any try/catch, 500-ing the page.
    await expect(verifyPreviewToken('a.!!!')).resolves.toBeNull();
    await expect(verifyPreviewToken('a.x')).resolves.toBeNull();
  });

  it('returns null (not a throw) when the body segment cannot be parsed as JSON after decoding', async () => {
    const token = await mintPreviewToken({ kind: 'page', slug: 'home', locale: 'en', version: 1 });
    const [, signature] = token.split('.');
    // Valid base64url, valid signature format, but garbage body — signature
    // check will fail (body doesn't match), still must resolve to null.
    await expect(verifyPreviewToken(`bm90LWpzb24.${signature}`)).resolves.toBeNull();
  });

  it('returns null (not a throw) when CMS_PREVIEW_SECRET is unset', async () => {
    ENV.CMS_PREVIEW_SECRET = undefined;
    await expect(verifyPreviewToken('a.x')).resolves.toBeNull();
  });

  it('returns null for a well-formed but tampered signature', async () => {
    const token = await mintPreviewToken({ kind: 'page', slug: 'home', locale: 'en', version: 1 });
    const [body] = token.split('.');
    // Same length/shape as a real base64url signature, but wrong bytes.
    const fakeSig = 'A'.repeat(43);
    await expect(verifyPreviewToken(`${body}.${fakeSig}`)).resolves.toBeNull();
  });

  it('returns null for an expired token', async () => {
    const token = await mintPreviewToken({ kind: 'page', slug: 'home', locale: 'en', version: 1 }, -1);
    await expect(verifyPreviewToken(token)).resolves.toBeNull();
  });
});
