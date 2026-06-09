import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyResendSignature, parseResendEvent } from './resend-webhook';

// A deterministic 32-byte key, base64-encoded the way Svix `whsec_` secrets are.
const KEY_BYTES = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const SECRET = `whsec_${KEY_BYTES.toString('base64')}`;

const SVIX_ID = 'msg_2abc';
const TS = 1_700_000_000; // fixed unix seconds
const NOW_MS = TS * 1000;
const PAYLOAD = JSON.stringify({ type: 'email.delivered', data: { email_id: 'em_123' } });

/** Independently compute the Svix v1 signature the way Resend/Svix does. */
function sign(id: string, ts: number, payload: string): string {
  return createHmac('sha256', KEY_BYTES).update(`${id}.${ts}.${payload}`).digest('base64');
}

describe('verifyResendSignature', () => {
  it('accepts a valid signature', async () => {
    const ok = await verifyResendSignature({
      secret: SECRET,
      svixId: SVIX_ID,
      svixTimestamp: String(TS),
      svixSignature: `v1,${sign(SVIX_ID, TS, PAYLOAD)}`,
      payload: PAYLOAD,
      nowMs: NOW_MS,
    });
    expect(ok).toBe(true);
  });

  it('rejects a tampered payload', async () => {
    const ok = await verifyResendSignature({
      secret: SECRET,
      svixId: SVIX_ID,
      svixTimestamp: String(TS),
      svixSignature: `v1,${sign(SVIX_ID, TS, PAYLOAD)}`,
      payload: `${PAYLOAD} `,
      nowMs: NOW_MS,
    });
    expect(ok).toBe(false);
  });

  it('rejects a wrong signature', async () => {
    const ok = await verifyResendSignature({
      secret: SECRET,
      svixId: SVIX_ID,
      svixTimestamp: String(TS),
      svixSignature: 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      payload: PAYLOAD,
      nowMs: NOW_MS,
    });
    expect(ok).toBe(false);
  });

  it('rejects an expired timestamp (replay protection)', async () => {
    const ok = await verifyResendSignature({
      secret: SECRET,
      svixId: SVIX_ID,
      svixTimestamp: String(TS),
      svixSignature: `v1,${sign(SVIX_ID, TS, PAYLOAD)}`,
      payload: PAYLOAD,
      nowMs: (TS + 3600) * 1000, // 1h later — beyond the 300s tolerance
    });
    expect(ok).toBe(false);
  });

  it('accepts when one of several space-separated candidates is valid', async () => {
    const ok = await verifyResendSignature({
      secret: SECRET,
      svixId: SVIX_ID,
      svixTimestamp: String(TS),
      svixSignature: `v0,bogus v1,${sign(SVIX_ID, TS, PAYLOAD)}`,
      payload: PAYLOAD,
      nowMs: NOW_MS,
    });
    expect(ok).toBe(true);
  });

  it('rejects missing headers', async () => {
    const ok = await verifyResendSignature({
      secret: SECRET,
      svixId: '',
      svixTimestamp: String(TS),
      svixSignature: `v1,${sign(SVIX_ID, TS, PAYLOAD)}`,
      payload: PAYLOAD,
      nowMs: NOW_MS,
    });
    expect(ok).toBe(false);
  });
});

describe('parseResendEvent', () => {
  it('parses a well-formed event', () => {
    const evt = parseResendEvent({
      type: 'email.delivered',
      created_at: '2026-06-08T00:00:00Z',
      data: { email_id: 'em_1' },
    });
    expect(evt).not.toBeNull();
    expect(evt?.type).toBe('email.delivered');
    expect(evt?.data.email_id).toBe('em_1');
    expect(evt?.created_at).toBe('2026-06-08T00:00:00Z');
  });

  it('returns null when type is missing', () => {
    expect(parseResendEvent({ data: {} })).toBeNull();
  });

  it('returns null when data is not an object', () => {
    expect(parseResendEvent({ type: 'email.delivered', data: 'nope' })).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseResendEvent(null)).toBeNull();
    expect(parseResendEvent('string')).toBeNull();
  });
});
