import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { composeDerivative } from './compose-master';
import { DEFAULT_LAYOUT, BACKGROUND_DEFAULT } from '../../src/lib/print-composition';

let tmpDir: string;
let artworkPng: string; // 700x1000 (7:10), opaque red
let signatureSvg: string; // 300x100 (3:1) viewBox

const config = {
  product: 'fap01',
  artwork: '',
  background: BACKGROUND_DEFAULT,
  signature: '',
  layout: DEFAULT_LAYOUT,
  opticalOffset: { x: 0, y: 0 },
  bleedMm: 0,
};

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-master-'));
  artworkPng = path.join(tmpDir, 'artwork.png');
  await sharp({ create: { width: 700, height: 1000, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .withMetadata({ icc: 'srgb' })
    .png()
    .toFile(artworkPng);
  config.artwork = artworkPng;
  signatureSvg = path.join(tmpDir, 'signature.svg');
  fs.writeFileSync(
    signatureSvg,
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100" viewBox="0 0 300 100"><rect width="300" height="100" fill="#222"/></svg>`,
  );
  config.signature = signatureSvg;
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('composeDerivative', () => {
  it('decodes to exactly the requested canvas dimensions', async () => {
    const result = await composeDerivative(artworkPng, signatureSvg, { width: 3600, height: 4800 }, 'jpg', config);
    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(3600);
    expect(meta.height).toBe(4800);
    expect(result.geometry.canvas).toEqual({ width: 3600, height: 4800 }); // req. 16: geometry returned for the manifest
  });

  it('produces a JPG with no alpha channel', async () => {
    const result = await composeDerivative(artworkPng, signatureSvg, { width: 3600, height: 4800 }, 'jpg', config);
    const meta = await sharp(result.buffer).metadata();
    expect(meta.hasAlpha).toBe(false);
  });

  it('is deterministic — same inputs yield the same sha256', async () => {
    const a = await composeDerivative(artworkPng, signatureSvg, { width: 3600, height: 4800 }, 'jpg', config);
    const b = await composeDerivative(artworkPng, signatureSvg, { width: 3600, height: 4800 }, 'jpg', config);
    expect(a.sha256).toBe(b.sha256);
  }, 15_000);

  it('produces a different sha256 for a different canvas size', async () => {
    const a = await composeDerivative(artworkPng, signatureSvg, { width: 3600, height: 4800 }, 'jpg', config);
    const b = await composeDerivative(artworkPng, signatureSvg, { width: 8400, height: 12000 }, 'jpg', config);
    expect(a.sha256).not.toBe(b.sha256);
    // 8400x12000 is the real Prodigi 70x100 print area — ~100 Mpx compose needs headroom.
  }, 30_000);

  it('honours the requested format', async () => {
    const jpg = await composeDerivative(artworkPng, signatureSvg, { width: 3600, height: 4800 }, 'jpg', config);
    const png = await composeDerivative(artworkPng, signatureSvg, { width: 3600, height: 4800 }, 'png', config);
    expect(jpg.format).toBe('jpg');
    expect(png.format).toBe('png');
    // result.format merely echoes the argument — assert the actual encoding too.
    expect((await sharp(jpg.buffer).metadata()).format).toBe('jpeg');
    expect((await sharp(png.buffer).metadata()).format).toBe('png');
  });

  it('embeds an sRGB ICC profile', async () => {
    const result = await composeDerivative(artworkPng, signatureSvg, { width: 3600, height: 4800 }, 'jpg', config);
    const meta = await sharp(result.buffer).metadata();
    expect(meta.icc).toBeDefined();
  });
});
