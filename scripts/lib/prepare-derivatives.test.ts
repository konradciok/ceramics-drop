import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  composeDerivative,
  composeFullBleedDerivative,
  validateSignatureSvg,
  signatureDensity,
  rasterizeSignature,
  prepareOutputDir,
} from './prepare-derivatives';
import type { Placement } from '../../src/lib/print-assets-prepare';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-test-'));
const ARTWORK = path.join(TMP, 'artwork.png');
// A 3:4 full-bleed master (30x40 px — tiny fixture, real ratio) — solid red.
const FULL_BLEED_3X4 = path.join(TMP, 'full-bleed-3x4.jpg');
const SIG = path.join(TMP, 'sig.svg');
const BAD_SIG = path.join(TMP, 'bad.svg');
const TEXT_SIG = path.join(TMP, 'text.svg');
const EXTERNAL_SIG = path.join(TMP, 'external.svg');
// Real, checked-in fixture (not tmp-generated): viewBox-only, no explicit
// width/height — exercises the intrinsic-size-from-viewBox decode path.
const SIGNATURE_VIEWBOX = path.join(__dirname, 'fixtures', 'signature-viewbox.svg');

beforeAll(async () => {
  // A solid-red 200x200 artwork master.
  await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ff0000' } })
    .png()
    .toFile(ARTWORK);
  // A solid-blue 30x40 (3:4) full-bleed master.
  await sharp({ create: { width: 30, height: 40, channels: 3, background: '#0000ff' } })
    .jpeg()
    .toFile(FULL_BLEED_3X4);
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

describe('composeFullBleedDerivative', () => {
  it('resizes the source directly to the exact target pixels — no canvas, no crop', async () => {
    const result = await composeFullBleedDerivative({
      sourcePath: FULL_BLEED_3X4,
      target: { w: 60, h: 80 },
      format: 'jpg',
    });
    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(60);
    expect(meta.height).toBe(80);
    expect(result.format).toBe('jpg');
  });

  it('is byte-deterministic across two runs', async () => {
    const input = { sourcePath: FULL_BLEED_3X4, target: { w: 60, h: 80 }, format: 'jpg' as const };
    const a = await composeFullBleedDerivative(input);
    const b = await composeFullBleedDerivative(input);
    expect(a.sha256).toBe(b.sha256);
  });

  it('embeds an sRGB ICC profile and produces a three-channel output with no alpha', async () => {
    const result = await composeFullBleedDerivative({
      sourcePath: FULL_BLEED_3X4,
      target: { w: 60, h: 80 },
      format: 'png',
    });
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.space).toBe('srgb');
    expect(metadata.hasProfile).toBe(true);
    expect(metadata.channels).toBe(3);
    expect(metadata.hasAlpha).toBe(false);
  });

  it('supports png format', async () => {
    const result = await composeFullBleedDerivative({
      sourcePath: FULL_BLEED_3X4,
      target: { w: 60, h: 80 },
      format: 'png',
    });
    expect(result.format).toBe('png');
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

describe('signatureDensity', () => {
  it('computes the DPI that exactly contains the intrinsic size into the zone', () => {
    expect(signatureDensity({ width: 500, height: 100 }, { width: 1000, height: 200 })).toBe(72);
    expect(signatureDensity({ width: 7812, height: 204 }, { width: 1000, height: 200 })).toBe(74);
  });

  it('throws when the resolved density or raster size exceeds the safe budget', () => {
    expect(() => signatureDensity({ width: 8000, height: 8000 }, { width: 10, height: 10 })).toThrow(
      /safe density budget/,
    );
  });

  it('throws on invalid intrinsic dimensions', () => {
    expect(() => signatureDensity({ width: 100, height: 100 }, { width: 0, height: 10 })).toThrow(
      /intrinsic dimensions/,
    );
  });

  it('throws on an invalid signature zone', () => {
    expect(() => signatureDensity({ width: 0, height: 100 }, { width: 10, height: 10 })).toThrow(
      /signature zone/,
    );
  });
});

describe('rasterizeSignature', () => {
  it('rasterises a viewBox-only SVG into the exact zone dimensions within the raster budget', async () => {
    // Fixture is 260x25 (viewBox, no width/height) contained into a large
    // 7812x204 zone — the same shape as a production signature placed on a
    // big-format print, but with no upstream density cap this would blow way
    // past a sane pixel budget or come out from a blurry 72dpi upscale.
    const zone = { width: 7812, height: 204 };
    const buffer = await rasterizeSignature(SIGNATURE_VIEWBOX, zone);
    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(zone.width);
    expect(meta.height).toBe(zone.height);
  });
});

describe('prepareOutputDir', () => {
  it('creates a fresh output directory when none exists', () => {
    const dir = path.join(TMP, 'out-fresh');
    expect(() => prepareOutputDir(dir, { force: false })).not.toThrow();
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('refuses to overwrite an existing directory without --force', () => {
    const dir = path.join(TMP, 'out-existing');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stale.jpg'), 'stale');
    expect(() => prepareOutputDir(dir, { force: false })).toThrow(/already exists.*--force/i);
    // The refusal must not have touched the existing contents.
    expect(fs.existsSync(path.join(dir, 'stale.jpg'))).toBe(true);
  });

  it('clears and recreates an existing directory with --force', () => {
    const dir = path.join(TMP, 'out-force');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stale.jpg'), 'stale');
    prepareOutputDir(dir, { force: true });
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'stale.jpg'))).toBe(false);
  });
});
