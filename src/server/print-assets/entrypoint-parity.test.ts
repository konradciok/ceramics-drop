import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharp from 'sharp';
import { MAX_SOURCE_BYTES, MAX_SOURCE_PIXELS, type DerivativeSpec } from '../asset-jobs/container-protocol';
import { renderFullBleedDerivative } from './container-handler';
import { composeFullBleedDerivative } from '../../scripts/lib/prepare-derivatives';

// Regression guard for the print-asset pipeline cutover (Priority 8 / Phase 4):
// the CmsApi/Container path (renderFullBleedDerivative, buffer-based) and the
// CLI path (composeFullBleedDerivative, file-based) both wrap the SAME shared
// composeFullBleedDerivative in ./derivatives — this test proves that stays
// true by comparing their actual output, not their source code. If someone
// ever changes one wrapper to call something else, this is what catches it.

let scratchDir: string;
let master3x4Path: string;
let master3x4Buffer: Buffer;

beforeAll(async () => {
  master3x4Buffer = await sharp({
    create: { width: 300, height: 400, channels: 3, background: '#2244aa' },
  })
    .jpeg()
    .toBuffer();
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-parity-'));
  master3x4Path = path.join(scratchDir, 'master-3x4.jpg');
  fs.writeFileSync(master3x4Path, master3x4Buffer);
});

afterAll(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe('Container vs CLI Sharp entry points', () => {
  it('produce byte-identical derivatives for the same source, target, and format', async () => {
    const spec: DerivativeSpec = {
      jobId: 'parity-test',
      uploadId: 'parity-test',
      sourceContentType: 'image/jpeg',
      expectedRatio: '3x4',
      target: { w: 60, h: 80 },
      format: 'jpg',
      maxSourceBytes: MAX_SOURCE_BYTES,
      maxSourcePixels: MAX_SOURCE_PIXELS,
    };

    const containerResult = await renderFullBleedDerivative(spec, master3x4Buffer);
    const cliResult = await composeFullBleedDerivative({
      sourcePath: master3x4Path,
      target: spec.target,
      format: spec.format,
    });

    expect(containerResult.sha256).toBe(cliResult.sha256);
    expect(containerResult.byteSize).toBe(cliResult.byteSize);
    expect(containerResult.buffer.equals(cliResult.buffer)).toBe(true);
  });

  it('still produce byte-identical output for a different target and a png source', async () => {
    const pngBuffer = await sharp({
      create: { width: 300, height: 450, channels: 3, background: '#aa4422' },
    })
      .png()
      .toBuffer();
    const pngPath = path.join(scratchDir, 'master-2x3.png');
    fs.writeFileSync(pngPath, pngBuffer);

    const spec: DerivativeSpec = {
      jobId: 'parity-test-2',
      uploadId: 'parity-test-2',
      sourceContentType: 'image/png',
      expectedRatio: '2x3',
      target: { w: 100, h: 150 },
      format: 'png',
      maxSourceBytes: MAX_SOURCE_BYTES,
      maxSourcePixels: MAX_SOURCE_PIXELS,
    };

    const containerResult = await renderFullBleedDerivative(spec, pngBuffer);
    const cliResult = await composeFullBleedDerivative({
      sourcePath: pngPath,
      target: spec.target,
      format: spec.format,
    });

    expect(containerResult.sha256).toBe(cliResult.sha256);
  });
});
