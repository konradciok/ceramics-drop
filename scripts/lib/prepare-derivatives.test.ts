import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { generateDerivative } from './prepare-derivatives';

let tmpDir: string;
let redPng: string; // 200x300, r=255 — big enough to downscale to any test target

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-assets-prepare-'));
  redPng = path.join(tmpDir, 'source.png');
  await sharp({ create: { width: 200, height: 300, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .png()
    .toFile(redPng);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('generateDerivative', () => {
  it('produces a deterministic sha256 for the same crop/target/format', async () => {
    const crop = { left: 0, top: 0, width: 200, height: 300 };
    const a = await generateDerivative(redPng, crop, 100, 150, 'jpg');
    const b = await generateDerivative(redPng, crop, 100, 150, 'jpg');
    expect(a.sha256).toBe(b.sha256);
    expect(a.byteSize).toBe(b.byteSize);
  });

  it('produces a different hash for a different target size', async () => {
    const crop = { left: 0, top: 0, width: 200, height: 300 };
    const a = await generateDerivative(redPng, crop, 100, 150, 'jpg');
    const b = await generateDerivative(redPng, crop, 120, 180, 'jpg');
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('honors the requested format', async () => {
    const crop = { left: 0, top: 0, width: 200, height: 300 };
    const jpg = await generateDerivative(redPng, crop, 100, 150, 'jpg');
    const png = await generateDerivative(redPng, crop, 100, 150, 'png');
    expect(jpg.format).toBe('jpg');
    expect(png.format).toBe('png');
    expect(jpg.sha256).not.toBe(png.sha256);
  });

  it('decodes to exactly the requested target dimensions', async () => {
    const crop = { left: 0, top: 0, width: 200, height: 300 };
    const result = await generateDerivative(redPng, crop, 100, 150, 'jpg');
    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(150);
  });

  it('rejects a crop region that extends past the source bounds', async () => {
    // Source is 200x300; this crop starts past the right edge.
    const crop = { left: 190, top: 0, width: 200, height: 300 };
    await expect(generateDerivative(redPng, crop, 100, 150, 'jpg')).rejects.toThrow();
  });

  it('produces JPGs with no alpha channel even from an RGBA source', async () => {
    const rgbaPng = path.join(tmpDir, 'rgba-source.png');
    await sharp({ create: { width: 200, height: 300, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 0.5 } } })
      .png()
      .toFile(rgbaPng);
    const crop = { left: 0, top: 0, width: 200, height: 300 };
    const result = await generateDerivative(rgbaPng, crop, 100, 150, 'jpg');
    const meta = await sharp(result.buffer).metadata();
    expect(meta.hasAlpha).toBe(false);
  });
});
