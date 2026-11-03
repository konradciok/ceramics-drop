import { describe, it, expect } from 'vitest';
import {
  MAX_SOURCE_BYTES,
  MAX_SOURCE_PIXELS,
  ProtocolError,
  RESULT_HEADER,
  SPEC_HEADER,
  classifyContainerStatus,
  decodeDerivativeSpec,
  encodeDerivativeSpec,
  encodeResultHeaders,
  parseContainerErrorBody,
  parseResultHeaders,
  type DerivativeSpec,
} from './container-protocol';

const SPEC: DerivativeSpec = {
  jobId: '22222222-2222-2222-2222-222222222222',
  uploadId: '11111111-1111-1111-1111-111111111111',
  sourceContentType: 'image/jpeg',
  expectedRatio: '3x4',
  target: { w: 3600, h: 4800 },
  format: 'jpg',
  maxSourceBytes: MAX_SOURCE_BYTES,
  maxSourcePixels: MAX_SOURCE_PIXELS,
};

describe('DerivativeSpec encode/decode', () => {
  it('round-trips a spec through the header encoding', () => {
    expect(decodeDerivativeSpec(encodeDerivativeSpec(SPEC))).toEqual(SPEC);
  });

  it('produces a header-safe value (no whitespace, no non-ASCII, no base64 padding)', () => {
    expect(encodeDerivativeSpec(SPEC)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects a missing header', () => {
    expect(() => decodeDerivativeSpec(undefined)).toThrow(ProtocolError);
    expect(() => decodeDerivativeSpec(null)).toThrow(new RegExp(SPEC_HEADER));
    expect(() => decodeDerivativeSpec('')).toThrow(ProtocolError);
  });

  it('rejects non-base64url and non-JSON payloads', () => {
    expect(() => decodeDerivativeSpec('!!!not base64!!!')).toThrow(/base64url/);
    expect(() => decodeDerivativeSpec(btoa('not json').replace(/=+$/, ''))).toThrow(/valid JSON/);
  });

  it('rejects a JSON payload that is not an object', () => {
    const encoded = encodeDerivativeSpec([] as unknown as DerivativeSpec);
    expect(() => decodeDerivativeSpec(encoded)).toThrow(/must be a JSON object/);
  });

  // The container trusts NOTHING it is sent: each of these is a Worker-side
  // bug, which must surface as a permanent 422 rather than an unbounded retry.
  it.each([
    ['jobId', { ...SPEC, jobId: '' }, /jobId/],
    ['uploadId', { ...SPEC, uploadId: 123 as unknown as string }, /uploadId/],
    ['sourceContentType', { ...SPEC, sourceContentType: 'image/webp' as DerivativeSpec['sourceContentType'] }, /sourceContentType/],
    ['expectedRatio', { ...SPEC, expectedRatio: '' }, /expectedRatio/],
    ['format', { ...SPEC, format: 'tiff' as DerivativeSpec['format'] }, /format/],
    ['target.w', { ...SPEC, target: { w: 0, h: 4800 } }, /target\.w/],
    ['target.h', { ...SPEC, target: { w: 3600, h: -1 } }, /target\.h/],
    ['target.w non-integer', { ...SPEC, target: { w: 3600.5, h: 4800 } }, /target\.w/],
    ['maxSourceBytes', { ...SPEC, maxSourceBytes: 0 }, /maxSourceBytes/],
    ['maxSourcePixels', { ...SPEC, maxSourcePixels: 0 }, /maxSourcePixels/],
  ])('rejects an invalid %s', (_label, spec, pattern) => {
    expect(() => decodeDerivativeSpec(encodeDerivativeSpec(spec as DerivativeSpec))).toThrow(pattern);
  });

  it('rejects a missing target object', () => {
    const encoded = encodeDerivativeSpec({ ...SPEC, target: undefined as unknown as DerivativeSpec['target'] });
    expect(() => decodeDerivativeSpec(encoded)).toThrow(/target/);
  });
});

describe('result headers', () => {
  const META = { sha256: 'a'.repeat(64), byteSize: 1234, width: 3600, height: 4800, format: 'jpg' as const };

  it('round-trips metadata through headers', () => {
    const headers = encodeResultHeaders(META);
    expect(parseResultHeaders((name) => headers[name] ?? null)).toEqual(META);
  });

  it('rejects a sha256 that is not lowercase 64-hex', () => {
    const headers: Record<string, string> = { ...encodeResultHeaders(META), [RESULT_HEADER.sha256]: 'A'.repeat(64) };
    expect(() => parseResultHeaders((name) => headers[name] ?? null)).toThrow(/64-hex/);
    const short: Record<string, string> = { ...encodeResultHeaders(META), [RESULT_HEADER.sha256]: 'abc' };
    expect(() => parseResultHeaders((name) => short[name] ?? null)).toThrow(/64-hex/);
  });

  it.each([RESULT_HEADER.byteSize, RESULT_HEADER.width, RESULT_HEADER.height])(
    'rejects a missing or non-positive %s',
    (header) => {
      const missing = { ...encodeResultHeaders(META) } as Record<string, string>;
      delete missing[header];
      expect(() => parseResultHeaders((name) => missing[name] ?? null)).toThrow(new RegExp(header));
      const zero: Record<string, string> = { ...encodeResultHeaders(META), [header]: '0' };
      expect(() => parseResultHeaders((name) => zero[name] ?? null)).toThrow(new RegExp(header));
    },
  );

  it('rejects an unknown format', () => {
    const headers: Record<string, string> = { ...encodeResultHeaders(META), [RESULT_HEADER.format]: 'webp' };
    expect(() => parseResultHeaders((name) => headers[name] ?? null)).toThrow(/format/);
  });
});

describe('classifyContainerStatus', () => {
  it('treats 200 as success', () => {
    expect(classifyContainerStatus(200)).toBe('ok');
  });

  it('treats 4xx as permanent — bad bytes never become good bytes', () => {
    expect(classifyContainerStatus(422)).toBe('permanent');
    expect(classifyContainerStatus(400)).toBe('permanent');
    expect(classifyContainerStatus(404)).toBe('permanent');
  });

  it('treats 408/429 as retryable despite being 4xx (capacity, not input)', () => {
    expect(classifyContainerStatus(408)).toBe('retryable');
    expect(classifyContainerStatus(429)).toBe('retryable');
  });

  it('treats 5xx and anything unexpected as retryable', () => {
    expect(classifyContainerStatus(500)).toBe('retryable');
    expect(classifyContainerStatus(503)).toBe('retryable');
    expect(classifyContainerStatus(0)).toBe('retryable');
  });
});

describe('parseContainerErrorBody', () => {
  it('reads a well-formed error envelope', () => {
    expect(parseContainerErrorBody('{"code":"WOULD_UPSCALE","message":"too small"}', 422)).toEqual({
      code: 'WOULD_UPSCALE',
      message: 'too small',
    });
  });

  it('falls back to the status when the body is not JSON', () => {
    expect(parseContainerErrorBody('<html>502</html>', 502)).toEqual({ code: 'HTTP_502', message: '<html>502</html>' });
  });

  it('falls back to the status when the body is empty', () => {
    expect(parseContainerErrorBody('', 500)).toEqual({ code: 'HTTP_500', message: 'container returned 500' });
  });

  it('truncates a runaway message', () => {
    const { message } = parseContainerErrorBody('x'.repeat(5000), 500);
    expect(message).toHaveLength(500);
  });
});
