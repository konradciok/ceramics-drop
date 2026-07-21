import { describe, it, expect } from 'vitest';
import {
  signPrintAssetUrl,
  verifyPrintAssetSig,
  PRINT_ASSET_TTL_SECS,
} from './print-assets';
import { SITE_URL } from './site';

const SECRET = 'test-secret-abc';
const NOW_MS = 1_700_000_000_000; // deterministic fixed clock
const ASSET_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const STAGING_ORIGIN = 'https://staging.example';

/** exp the signer computes for a given nowMs. */
const expFor = (nowMs: number) => Math.floor(nowMs / 1000) + PRINT_ASSET_TTL_SECS;

/** Sign and pull (exp, sig) back out of the returned URL. */
async function signTriple(assetId = ASSET_ID, secret = SECRET, nowMs: number = NOW_MS) {
  const url = await signPrintAssetUrl(assetId, secret, nowMs);
  const params = new URL(url).searchParams;
  return { exp: Number(params.get('exp')), sig: params.get('sig')! };
}

describe('signPrintAssetUrl — URL shape', () => {
  it('produces ${origin}/api/print-assets/{encAssetId}?exp={exp}&sig={lowercase-hex}', async () => {
    const url = await signPrintAssetUrl(ASSET_ID, SECRET, NOW_MS);
    const exp = expFor(NOW_MS);
    const prefix = `${SITE_URL}/api/print-assets/${encodeURIComponent(ASSET_ID)}?exp=${exp}&sig=`;
    expect(url.startsWith(prefix)).toBe(true);
    expect(url.slice(prefix.length)).toMatch(/^[0-9a-f]{64}$/); // lowercase hex, SHA-256
  });

  it('encodes special characters in assetId', async () => {
    const url = await signPrintAssetUrl('a/b c', SECRET, NOW_MS);
    expect(url).toContain(`${SITE_URL}/api/print-assets/a%2Fb%20c?exp=`);
  });

  it('respects an explicit origin override', async () => {
    const url = await signPrintAssetUrl(ASSET_ID, SECRET, NOW_MS, STAGING_ORIGIN);
    expect(url.startsWith(`${STAGING_ORIGIN}/api/print-assets/`)).toBe(true);
  });

  it('sets exp = floor(nowMs/1000) + PRINT_ASSET_TTL_SECS (7 days)', () => {
    expect(PRINT_ASSET_TTL_SECS).toBe(60 * 60 * 24 * 7);
    expect(expFor(NOW_MS)).toBe(Math.floor(NOW_MS / 1000) + 604800);
  });
});

describe('signPrintAssetUrl — determinism & sensitivity', () => {
  it('is deterministic: same inputs → byte-identical URL', async () => {
    const a = await signPrintAssetUrl(ASSET_ID, SECRET, NOW_MS);
    const b = await signPrintAssetUrl(ASSET_ID, SECRET, NOW_MS);
    expect(a).toBe(b);
  });

  it('is sensitive to assetId', async () => {
    const a = await signPrintAssetUrl(ASSET_ID, SECRET, NOW_MS);
    const b = await signPrintAssetUrl('bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', SECRET, NOW_MS);
    expect(a).not.toBe(b);
  });

  it('is sensitive to nowMs (and thus exp)', async () => {
    const a = await signPrintAssetUrl(ASSET_ID, SECRET, NOW_MS);
    const b = await signPrintAssetUrl(ASSET_ID, SECRET, NOW_MS + 1000);
    expect(a).not.toBe(b);
  });

  it('is sensitive to secret', async () => {
    const a = await signPrintAssetUrl(ASSET_ID, SECRET, NOW_MS);
    const b = await signPrintAssetUrl(ASSET_ID, 'different-secret', NOW_MS);
    expect(a).not.toBe(b);
  });
});

describe('verifyPrintAssetSig — round-trip & tamper rejection', () => {
  it('verifies a freshly signed triple with the same secret', async () => {
    const { exp, sig } = await signTriple();
    expect(await verifyPrintAssetSig(ASSET_ID, exp, sig, SECRET, NOW_MS)).toBe(true);
  });

  it('rejects a flipped assetId', async () => {
    const { exp, sig } = await signTriple();
    expect(await verifyPrintAssetSig('bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', exp, sig, SECRET, NOW_MS)).toBe(false);
  });

  it('rejects a different exp', async () => {
    const { exp, sig } = await signTriple();
    expect(await verifyPrintAssetSig(ASSET_ID, exp + 1, sig, SECRET, NOW_MS)).toBe(false);
  });

  it('rejects a wrong secret', async () => {
    const { exp, sig } = await signTriple();
    expect(await verifyPrintAssetSig(ASSET_ID, exp, sig, 'wrong-secret', NOW_MS)).toBe(false);
  });

  it('rejects a truncated sig', async () => {
    const { exp, sig } = await signTriple();
    expect(await verifyPrintAssetSig(ASSET_ID, exp, sig.slice(0, -2), SECRET, NOW_MS)).toBe(false);
  });

  it('rejects a mutated sig (last nibble flipped)', async () => {
    const { exp, sig } = await signTriple();
    const last = sig.slice(-1);
    const flipped = last === 'a' ? 'b' : 'a';
    expect(await verifyPrintAssetSig(ASSET_ID, exp, sig.slice(0, -1) + flipped, SECRET, NOW_MS)).toBe(false);
  });
});

describe('verifyPrintAssetSig — malformed signature', () => {
  it('rejects an odd-length sigHex without throwing', async () => {
    const { exp, sig } = await signTriple();
    await expect(verifyPrintAssetSig(ASSET_ID, exp, sig + 'f', SECRET, NOW_MS)).resolves.toBe(false);
  });

  it('rejects a non-hex sigHex without throwing', async () => {
    const { exp } = await signTriple();
    await expect(verifyPrintAssetSig(ASSET_ID, exp, 'z'.repeat(64), SECRET, NOW_MS)).resolves.toBe(false);
  });

  it('rejects uppercase hex (regex is lowercase-only)', async () => {
    const { exp, sig } = await signTriple();
    await expect(verifyPrintAssetSig(ASSET_ID, exp, sig.toUpperCase(), SECRET, NOW_MS)).resolves.toBe(false);
  });
});

describe('verifyPrintAssetSig — expiry boundary', () => {
  // verify has a nowMs param (defaults to Date.now()); pass it directly for determinism.
  it('accepts at the exact boundary exp*1000 === nowMs', async () => {
    const { exp, sig } = await signTriple();
    expect(await verifyPrintAssetSig(ASSET_ID, exp, sig, SECRET, exp * 1000)).toBe(true);
  });

  it('rejects 1ms past the boundary (exp*1000 < nowMs)', async () => {
    const { exp, sig } = await signTriple();
    expect(await verifyPrintAssetSig(ASSET_ID, exp, sig, SECRET, exp * 1000 + 1)).toBe(false);
  });

  it('accepts a far-future exp (verifying at a nowMs deep in the past)', async () => {
    const { exp, sig } = await signTriple(); // exp is 7 days ahead of NOW_MS
    expect(await verifyPrintAssetSig(ASSET_ID, exp, sig, SECRET, 0)).toBe(true);
  });

  it('rejects a non-finite exp', async () => {
    await expect(verifyPrintAssetSig(ASSET_ID, Number.NaN, '0'.repeat(64), SECRET, NOW_MS)).resolves.toBe(false);
  });
});
