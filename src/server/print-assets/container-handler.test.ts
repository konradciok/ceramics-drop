import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import { MAX_SOURCE_BYTES, MAX_SOURCE_PIXELS, type DerivativeSpec } from '../asset-jobs/container-protocol';
import { PermanentInputError, assertKnownRatio, renderFullBleedDerivative } from './container-handler';

// NOTE ON SCOPE: this exercises the container's RENDER LOGIC with real Sharp
// and real image bytes. It does NOT — and cannot — verify anything about the
// Cloudflare Container runtime itself (cold start, sleep/wake, memory ceiling,
// Sharp performance under 2 vCPU). See the task report.

const spec = (overrides: Partial<DerivativeSpec> = {}): DerivativeSpec => ({
  jobId: 'job-1',
  uploadId: 'upload-1',
  sourceContentType: 'image/jpeg',
  expectedRatio: '3x4',
  target: { w: 60, h: 80 },
  format: 'jpg',
  maxSourceBytes: MAX_SOURCE_BYTES,
  maxSourcePixels: MAX_SOURCE_PIXELS,
  ...overrides,
});

// Tiny fixtures at REAL catalogue ratios — big enough to downscale into the
// targets below without tripping validateNoUpscale.
let master3x4: Buffer; // 300x400
let master2x3: Buffer; // 300x450
let masterPng3x4: Buffer; // 300x400, png

beforeAll(async () => {
  master3x4 = await sharp({ create: { width: 300, height: 400, channels: 3, background: '#2244aa' } }).jpeg().toBuffer();
  master2x3 = await sharp({ create: { width: 300, height: 450, channels: 3, background: '#aa4422' } }).jpeg().toBuffer();
  masterPng3x4 = await sharp({ create: { width: 300, height: 400, channels: 3, background: '#22aa44' } }).png().toBuffer();
});

describe('assertKnownRatio', () => {
  it('accepts the four catalogue ratios', () => {
    for (const ratio of ['3x4', '5x7', '7x10', '2x3']) expect(assertKnownRatio(ratio)).toBe(ratio);
  });

  it('rejects anything else as permanent input error', () => {
    expect(() => assertKnownRatio('4x3')).toThrow(PermanentInputError);
    expect(() => assertKnownRatio('4x3')).toThrow(/not a known print ratio/);
  });
});

describe('renderFullBleedDerivative', () => {
  it('produces an exact-pixel jpg derivative with a sha256 and real byte size', async () => {
    const result = await renderFullBleedDerivative(spec(), master3x4);
    expect(result.format).toBe('jpg');
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.byteSize).toBe(result.buffer.byteLength);
    const meta = await sharp(result.buffer).metadata();
    expect([meta.width, meta.height]).toEqual([60, 80]);
    expect(meta.format).toBe('jpeg');
  });

  it('is deterministic — the same source and target hash identically', async () => {
    const a = await renderFullBleedDerivative(spec(), master3x4);
    const b = await renderFullBleedDerivative(spec(), master3x4);
    expect(a.sha256).toBe(b.sha256);
    expect(a.byteSize).toBe(b.byteSize);
  });

  it('produces a png derivative when the spec asks for one', async () => {
    const result = await renderFullBleedDerivative(spec({ format: 'png', sourceContentType: 'image/png' }), masterPng3x4);
    expect(result.format).toBe('png');
    expect((await sharp(result.buffer).metadata()).format).toBe('png');
  });

  it('rejects a master whose real pixels contradict the declared ratio', async () => {
    // A genuine 2:3 file submitted as a 3x4 upload — the mislabeled-master guard.
    await expect(renderFullBleedDerivative(spec({ expectedRatio: '3x4' }), master2x3)).rejects.toThrow(PermanentInputError);
    await expect(renderFullBleedDerivative(spec({ expectedRatio: '3x4' }), master2x3)).rejects.toMatchObject({
      code: 'RATIO_MISMATCH',
    });
  });

  it('refuses to upscale a master smaller than its target', async () => {
    await expect(renderFullBleedDerivative(spec({ target: { w: 3000, h: 4000 } }), master3x4)).rejects.toMatchObject({
      code: 'WOULD_UPSCALE',
    });
  });

  it('rejects an empty body', async () => {
    await expect(renderFullBleedDerivative(spec(), Buffer.alloc(0))).rejects.toMatchObject({ code: 'SOURCE_EMPTY' });
  });

  it('rejects bytes that are not a decodable image', async () => {
    await expect(renderFullBleedDerivative(spec(), Buffer.from('this is not an image'))).rejects.toMatchObject({
      code: 'SOURCE_UNDECODABLE',
    });
  });

  it('enforces the byte budget before decoding anything', async () => {
    await expect(renderFullBleedDerivative(spec({ maxSourceBytes: 10 }), master3x4)).rejects.toMatchObject({
      code: 'SOURCE_TOO_LARGE',
    });
  });

  it('enforces the megapixel budget', async () => {
    // 300x400 = 120_000px; a 1_000px budget must reject it.
    await expect(renderFullBleedDerivative(spec({ maxSourcePixels: 1_000 }), master3x4)).rejects.toMatchObject({
      code: expect.stringMatching(/SOURCE_TOO_MANY_PIXELS|SOURCE_UNDECODABLE/),
    });
  });

  it('every rejection is a PermanentInputError, so none of them can become an infinite retry', async () => {
    const cases: Array<[DerivativeSpec, Buffer]> = [
      [spec({ expectedRatio: 'A4' }), master3x4],
      [spec({ expectedRatio: '3x4' }), master2x3],
      [spec({ target: { w: 3000, h: 4000 } }), master3x4],
      [spec(), Buffer.from('garbage')],
      [spec({ maxSourceBytes: 1 }), master3x4],
    ];
    for (const [s, buf] of cases) {
      await expect(renderFullBleedDerivative(s, buf)).rejects.toBeInstanceOf(PermanentInputError);
    }
  });
});
