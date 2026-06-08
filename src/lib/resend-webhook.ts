/**
 * Resend inbound webhook verification + parsing. Pure and I/O-free so it can be
 * unit-tested without the Workers env. Resend signs webhooks with Svix: the
 * request carries `svix-id`, `svix-timestamp`, and `svix-signature` headers, and
 * the body is signed with HMAC-SHA256. We verify with Web Crypto (`crypto.subtle`)
 * so this runs on the Workers runtime — no Node `crypto`/`Buffer`.
 */

const DEFAULT_TOLERANCE_SECONDS = 300;

/** base64 → bytes (Workers has `atob`, no `Buffer`). Throws on invalid base64. */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** bytes → base64 (Workers has `btoa`, no `Buffer`). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Constant-time equality for the (fixed-length) base64 signatures. Unequal
 * lengths short-circuit — safe here because a valid HMAC-SHA256 signature is
 * always the same length — but equal-length inputs are compared in full so a
 * timing side-channel can't reveal how many leading bytes matched.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a Resend (Svix) webhook signature. Returns false (never throws) on any
 * malformed input. `nowMs` is injectable so the replay window is testable.
 */
export async function verifyResendSignature(params: {
  secret: string;
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
  payload: string;
  toleranceSeconds?: number;
  nowMs?: number;
}): Promise<boolean> {
  const {
    secret,
    svixId,
    svixTimestamp,
    svixSignature,
    payload,
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
    nowMs = Date.now(),
  } = params;

  if (!secret || !svixId || !svixTimestamp || !svixSignature) return false;

  // Replay protection: reject timestamps more than `toleranceSeconds` in the
  // past or future.
  const tsSeconds = Number(svixTimestamp);
  if (!Number.isFinite(tsSeconds)) return false;
  if (Math.abs(nowMs / 1000 - tsSeconds) > toleranceSeconds) return false;

  // The signing secret is `whsec_<base64>`; the HMAC key is the decoded base64.
  const rawSecret = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = base64ToBytes(rawSecret);
  } catch {
    return false;
  }

  const signedContent = `${svixId}.${svixTimestamp}.${payload}`;

  let expected: string;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedContent));
    expected = bytesToBase64(new Uint8Array(sigBuf));
  } catch {
    return false;
  }

  // `svix-signature` is a space-separated list of `version,signature` tokens
  // (e.g. `v1,abc v1,def`). Accept if any v1 signature matches.
  for (const token of svixSignature.split(' ')) {
    const comma = token.indexOf(',');
    if (comma === -1) continue;
    if (token.slice(0, comma) !== 'v1') continue;
    if (timingSafeEqual(expected, token.slice(comma + 1))) return true;
  }
  return false;
}

export type ResendWebhookEvent = {
  type: string;
  created_at?: string;
  data: { email_id?: string; [key: string]: unknown };
};

/**
 * Narrow an untrusted parsed body to a ResendWebhookEvent. Returns null unless
 * it has a string `type` and an object `data`.
 */
export function parseResendEvent(raw: unknown): ResendWebhookEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.type !== 'string') return null;
  if (!obj.data || typeof obj.data !== 'object') return null;
  return {
    type: obj.type,
    created_at: typeof obj.created_at === 'string' ? obj.created_at : undefined,
    data: obj.data as { email_id?: string; [key: string]: unknown },
  };
}
