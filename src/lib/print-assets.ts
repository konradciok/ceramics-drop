import { SITE_URL } from './site';

/**
 * HMAC-signed print-asset URLs. R2 bucket bindings expose get/put/head/list
 * only — there is no createSignedUrl — so master artwork is served to Prodigi
 * through /api/print-assets/[id], authenticated with an HMAC over
 * `{assetId}:{exp}` using PRINT_ASSET_TOKEN_SECRET.
 */

export const PRINT_ASSET_TTL_SECS = 60 * 60 * 24 * 7; // 7 days — Prodigi downloads well within this

export function printAssetKey(productId: string): string {
  return `${productId}/master.jpg`;
}

const enc = new TextEncoder();

function importHmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage],
  );
}

export async function signPrintAssetUrl(
  assetId: string,
  secret: string,
  nowMs: number = Date.now(),
  origin: string = SITE_URL,
): Promise<string> {
  const exp = Math.floor(nowMs / 1000) + PRINT_ASSET_TTL_SECS;
  const key = await importHmacKey(secret, 'sign');
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${assetId}:${exp}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${origin}/api/print-assets/${encodeURIComponent(assetId)}?exp=${exp}&sig=${hex}`;
}

/** Constant-time verify via crypto.subtle.verify. Also rejects expired links. */
export async function verifyPrintAssetSig(
  assetId: string,
  exp: number,
  sigHex: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!Number.isFinite(exp) || exp * 1000 < nowMs) return false;
  if (!/^[0-9a-f]{64}$/.test(sigHex)) return false;
  const sig = new Uint8Array(sigHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const key = await importHmacKey(secret, 'verify');
  return crypto.subtle.verify('HMAC', key, sig, enc.encode(`${assetId}:${exp}`));
}
