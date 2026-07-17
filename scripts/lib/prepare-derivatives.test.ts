import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { composeDerivative, validateSignatureSvg } from './prepare-derivatives';
import type { Placement } from '../../src/lib/print-assets-prepare';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-test-'));
const ARTWORK = path.join(TMP, 'artwork.png');
const SIG = path.join(TMP, 'sig.svg');
const BAD_SIG = path.join(TMP, 'bad.svg');
const TEXT_SIG = path.join(TMP, 'text.svg');
const EXTERNAL_SIG = path.join(TMP, 'external.svg');

beforeAll(async () => {
  // A solid-red 200x200 artwork master.
  await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ff0000' } })
    .png()
    .toFile(ARTWORK);
  // A 100x20 solid-blue signature SVG.
  fs.writeFileSync(
    SIG,
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="20"><rect width="100" height="20" fill="#0000ff"/></svg>',
  );
  fs.writeFileSync(BAD_SIG, '<svg><not-closed>');
  fs.writeFileSync(
    TEXT_SIG,
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="20"><text font-family="Studio Font">Anna</text></svg>',
  );
  fs.writeFileSync(
    EXTERNAL_SIG,
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="20"><image href="signature.png"/></svg>',
  );
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ponytail: auto-detect channels from the buffer. The verbatim helper assumed
// channels=3, but compositing an RGBA signature onto an RGB canvas promotes the
// PNG output to 4-channel RGBA — a fixed 3-stride reads misaligned bytes.
async function pixel(buffer: Buffer, x: number, y: number, width: number) {
  const meta = await sharp(buffer).metadata();
  const channels = meta.channels ?? 3;
  const { data } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const idx = (y * width + x) * channels;
  return [data[idx], data[idx + 1], data[idx + 2]];
}

describe('composeDerivative', () => {
  it('produces a canvas at exact target dimensions', async () => {
    const placement: Placement = {
      artworkBox: { x: 100, y: 100, width: 800, height: 700 },
      signatureBox: { x: 100, y: 850, width: 800, height: 50 },
      artworkOut: { width: 200, height: 200 },
      artworkPos: { x: 400, y: 350 },
      scale: 1,
    };
    const result = await composeDerivative({
      artworkPath: ARTWORK,
      signatureSvgPath: SIG,
      background: '#00ff00',
      placement,
      target: { w: 1000, h: 1000 },
      format: 'jpg',
    });
    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(1000);
    expect(meta.height).toBe(1000);
    expect(result.format).toBe('jpg');
  });

  // ponytail: colour-geometry assertions use PNG (lossless). The brief's verbatim
  // used 'jpg', but mozjpeg q92 — the locked pipeline setting — quantises pure
  // primaries (255→254 on red/green), so exact-RGB assertions can't hold through
  // the JPG path. PNG proves the composition math (background fill + artwork
  // position) at full fidelity; JPG q92 stays exercised by the dimensions +
  // determinism tests below.
  it('fills the canvas background where no artwork or signature is drawn', async () => {
    const placement: Placement = {
      artworkBox: { x: 100, y: 100, width: 800, height: 700 },
      signatureBox: { x: 100, y: 850, width: 800, height: 50 },
      artworkOut: { width: 200, height: 200 },
      artworkPos: { x: 400, y: 350 },
      scale: 1,
    };
    const result = await composeDerivative({
      artworkPath: ARTWORK,
      signatureSvgPath: SIG,
      background: '#00ff00',
      placement,
      target: { w: 1000, h: 1000 },
      format: 'png',
    });
    // Top-left corner is pure background (green).
    const [r, g, b] = await pixel(result.buffer, 5, 5, 1000);
    expect([r, g, b]).toEqual([0, 255, 0]);
  });

  it('composites the artwork at its resolved position', async () => {
    const placement: Placement = {
      artworkBox: { x: 100, y: 100, width: 800, height: 700 },
      signatureBox: { x: 100, y: 850, width: 800, height: 50 },
      artworkOut: { width: 200, height: 200 },
      artworkPos: { x: 400, y: 350 },
      scale: 1,
    };
    const result = await composeDerivative({
      artworkPath: ARTWORK,
      signatureSvgPath: SIG,
      background: '#00ff00',
      placement,
      target: { w: 1000, h: 1000 },
      format: 'png',
    });
    // Centre of the 200x200 artwork placed at (400,350) → (500,450) is red.
    const [r, g, b] = await pixel(result.buffer, 500, 450, 1000);
    expect([r, g, b]).toEqual([255, 0, 0]);
  });

  it('produces a three-channel PNG with no alpha channel', async () => {
    const placement: Placement = {
      artworkBox: { x: 100, y: 100, width: 800, height: 700 },
      signatureBox: { x: 100, y: 850, width: 800, height: 50 },
      artworkOut: { width: 200, height: 200 },
      artworkPos: { x: 400, y: 350 },
      scale: 1,
    };
    const result = await composeDerivative({
      artworkPath: ARTWORK,
      signatureSvgPath: SIG,
      background: '#00ff00',
      placement,
      target: { w: 1000, h: 1000 },
      format: 'png',
    });
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.channels).toBe(3);
    expect(metadata.hasAlpha).toBe(false);
  });

  it('is byte-deterministic across two runs', async () => {
    const placement: Placement = {
      artworkBox: { x: 100, y: 100, width: 800, height: 700 },
      signatureBox: { x: 100, y: 850, width: 800, height: 50 },
      artworkOut: { width: 200, height: 200 },
      artworkPos: { x: 400, y: 350 },
      scale: 1,
    };
    const input = {
      artworkPath: ARTWORK,
      signatureSvgPath: SIG,
      background: '#00ff00',
      placement,
      target: { w: 1000, h: 1000 },
      format: 'jpg' as const,
    };
    const a = await composeDerivative(input);
    const b = await composeDerivative(input);
    expect(a.sha256).toBe(b.sha256);
  });

  it('embeds an sRGB ICC profile in the composed output', async () => {
    const placement: Placement = {
      artworkBox: { x: 10, y: 10, width: 80, height: 70 },
      signatureBox: null,
      artworkOut: { width: 50, height: 50 },
      artworkPos: { x: 25, y: 20 },
      scale: 0.25,
    };
    const result = await composeDerivative({
      artworkPath: ARTWORK,
      signatureSvgPath: null,
      background: '#ffffff',
      placement,
      target: { w: 100, h: 100 },
      format: 'jpg',
    });
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.space).toBe('srgb');
    expect(metadata.hasProfile).toBe(true);
    expect(metadata.icc?.byteLength).toBeGreaterThan(0);
  });

  it('composes without a signature when signatureSvgPath is null', async () => {
    const placement: Placement = {
      artworkBox: { x: 100, y: 100, width: 800, height: 800 },
      signatureBox: null,
      artworkOut: { width: 200, height: 200 },
      artworkPos: { x: 400, y: 400 },
      scale: 1,
    };
    const result = await composeDerivative({
      artworkPath: ARTWORK,
      signatureSvgPath: null,
      background: '#00ff00',
      placement,
      target: { w: 1000, h: 1000 },
      format: 'jpg',
    });
    expect(result.byteSize).toBeGreaterThan(0);
  });
});

describe('validateSignatureSvg', () => {
  it('accepts a decodable SVG with non-zero dimensions', async () => {
    await expect(validateSignatureSvg(SIG)).resolves.toBeUndefined();
  });

  it('rejects an invalid SVG before derivative generation', async () => {
    await expect(validateSignatureSvg(BAD_SIG)).rejects.toThrow(/invalid/i);
  });

  it('rejects font-dependent text before derivative generation', async () => {
    await expect(validateSignatureSvg(TEXT_SIG)).rejects.toThrow(/outlined paths/i);
  });

  it('rejects external or embedded image resources before derivative generation', async () => {
    await expect(validateSignatureSvg(EXTERNAL_SIG)).rejects.toThrow(/path-only SVG/i);
  });
});
