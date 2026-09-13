const enc = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export type ProductPreviewPayload = { kind: 'product'; resourceId: string; revision: number; exp: number };

export async function mintProductPreviewToken(
  secret: string,
  resourceId: string,
  revision: number,
  ttlSeconds = 900,
  nowMs: number = Date.now(),
): Promise<{ token: string; expiresAt: string }> {
  const exp = nowMs + ttlSeconds * 1000;
  const payload: ProductPreviewPayload = { kind: 'product', resourceId, revision, exp };
  const body = base64UrlEncode(enc.encode(JSON.stringify(payload)));
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const sigHex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { token: `${body}.${sigHex}`, expiresAt: new Date(exp).toISOString() };
}

/** Fails closed to null on any malformed input, expired token, or bad signature. */
export async function verifyProductPreviewToken(
  secret: string,
  token: string,
  nowMs: number = Date.now(),
): Promise<ProductPreviewPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sigHex] = parts;
  if (!/^[0-9a-f]+$/.test(sigHex)) return null;

  try {
    const key = await importKey(secret);
    const sig = Uint8Array.from(sigHex.match(/../g)!.map((h) => parseInt(h, 16)));
    const valid = await crypto.subtle.verify('HMAC', key, sig, enc.encode(body));
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as ProductPreviewPayload;
    if (payload.kind !== 'product' || payload.exp < nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}
