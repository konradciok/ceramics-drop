// Regression coverage for verifyPreviewToken: a crafted/malformed ?preview=
// token must resolve to null, never throw — a throw here 500s every page
// that reads preview content (homepage, print PDPs).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ENV = vi.hoisted(() => ({
  CMS_PREVIEW_SECRET: 'secret_test' as string | undefined,
}));

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({ env: ENV }),
}));

import { mintPreviewToken, verifyPreviewToken } from './server';

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
